import {
    Notice,
    Plugin,
    TAbstractFile,
    TFile,
    TFolder,
    WorkspaceLeaf,
} from "obsidian";

import { DuplicateReviewerSettings, DEFAULT_SETTINGS, DuplicateGroup, ScanProgress } from "./types";
import { DuplicateReviewerSettingTab } from "./settings";
import { DuplicateReviewView, DUPLICATE_REVIEW_VIEW_TYPE } from "./views/DuplicateReviewView";
import { FolderSelectModal } from "./modals/FolderSelectModal";
import { PatternSelectModal } from "./modals/PatternSelectModal";
import {
    scanForDuplicates,
    collectMarkdownFiles,
    findByPattern,
    findTitleDuplicates,
    groupDuplicates,
    buildExclusionMap,
    filterExcludedCandidates,
} from "./scanner";
import { CacheManager } from "./cache";

// Keys that live at the top level of data.json alongside the cache
const SETTINGS_KEYS: (keyof DuplicateReviewerSettings)[] = [
    "titleSimilarityThreshold",
    "enableContentSimilarity",
    "contentSimilarityThreshold",
    "contentCharsToAnalyze",
    "ignoredFolders",
    "commonPatterns",
    "maxComparisonPanes",
];

export default class DuplicateReviewerPlugin extends Plugin {
    settings: DuplicateReviewerSettings;
    cacheManager: CacheManager;
    private duplicateReviewView: DuplicateReviewView;
    // One controller per in-flight scan, keyed by folder path
    private scanControllers: Map<string, AbortController> = new Map();

    // ── dismissal state ──────────────────────────────────────────────────────
    dismissedGroups: string[][] = [];                 // persisted in data.json
    private dismissedSet: Set<string> = new Set();    // O(1) lookup (paths joined by \0)

    async onload(): Promise<void> {
        await this.loadSettings();

        // Initialise cache (load persisted entries from data.json)
        this.cacheManager = new CacheManager(this, this.app);
        await this.cacheManager.load();

        // Register the sidebar view
        this.registerView(
            DUPLICATE_REVIEW_VIEW_TYPE,
            (leaf) => (this.duplicateReviewView = new DuplicateReviewView(leaf, this))
        );

        // Add settings tab
        this.addSettingTab(new DuplicateReviewerSettingTab(this.app, this));

        // ── vault change events → invalidate cache ────────────────────────
        const markDirty = (file: TAbstractFile) => {
            if (file instanceof TFile && file.extension === "md") {
                this.cacheManager.dirtyPaths.add(file.path);
            }
        };
        this.registerEvent(this.app.vault.on("create", markDirty));
        this.registerEvent(this.app.vault.on("delete", markDirty));
        this.registerEvent(this.app.vault.on("modify", markDirty));
        this.registerEvent(
            this.app.vault.on("rename", (file: TAbstractFile, oldPath: string) => {
                if (file instanceof TFile && file.extension === "md") {
                    this.cacheManager.dirtyPaths.add(file.path);
                    this.cacheManager.dirtyPaths.add(oldPath);
                }
            })
        );

        // ── context menu ───────────────────────────────────────────────────
        this.registerEvent(
            this.app.workspace.on("file-menu", (menu, fileish: TAbstractFile) => {
                if (fileish instanceof TFolder) {
                    menu.addItem((item) => {
                        item.setTitle("Find duplicates in folder")
                            .setIcon("files")
                            .onClick(() => {
                                this.startDuplicateReview(fileish);
                            });
                    });
                }
            })
        );

        // ── commands ───────────────────────────────────────────────────────
        this.addCommand({
            id: "find-duplicates-in-vault",
            name: "Find duplicates in vault",
            callback: () => {
                new FolderSelectModal(this.app, this.settings, (folder) => {
                    this.startDuplicateReview(folder);
                }).open();
            },
        });

        this.addCommand({
            id: "find-duplicates-by-pattern",
            name: "Find duplicates by pattern",
            callback: () => {
                new PatternSelectModal(this.app, this.settings, (pattern) => {
                    this.startPatternReview(pattern);
                }).open();
            },
        });

        this.addCommand({
            id: "review-next-duplicate-group",
            name: "Review next duplicate group",
            callback: () => {
                if (this.duplicateReviewView) {
                    this.duplicateReviewView.nextGroup();
                }
            },
        });

        this.addCommand({
            id: "review-previous-duplicate-group",
            name: "Review previous duplicate group",
            callback: () => {
                if (this.duplicateReviewView) {
                    this.duplicateReviewView.previousGroup();
                }
            },
        });

        this.addCommand({
            id: "open-duplicate-review-pane",
            name: "Open duplicate review pane",
            callback: async () => {
                await this.activateView();
                await this.loadMostRecentCache();
            },
        });

        this.addCommand({
            id: "build-duplicate-cache",
            name: "Build duplicate cache in background",
            callback: () => {
                new FolderSelectModal(this.app, this.settings, (folder) => {
                    this.buildCacheInBackground(folder);
                }).open();
            },
        });
    }

    onunload(): void {
        // Abort any in-flight scans
        for (const ctrl of this.scanControllers.values()) {
            ctrl.abort();
        }
        this.app.workspace.detachLeavesOfType(DUPLICATE_REVIEW_VIEW_TYPE);
    }

    // ── settings I/O (coexists with duplicateCache in data.json) ──────────

    async loadSettings(): Promise<void> {
        const data = await this.loadData();
        const partial: Record<string, unknown> = {};
        if (data) {
            for (const key of SETTINGS_KEYS) {
                if (key in data) partial[key] = data[key];
            }
            // Load persisted dismissals
            if (Array.isArray(data["dismissedGroups"])) {
                this.dismissedGroups = data["dismissedGroups"] as string[][];
            }
        }
        this.settings = Object.assign({}, DEFAULT_SETTINGS, partial);
        this.rebuildDismissalSet();
    }

    async saveSettings(): Promise<void> {
        // Merge settings into existing data so we don't clobber the cache key
        const data = (await this.loadData()) || {};
        for (const key of SETTINGS_KEYS) {
            data[key] = this.settings[key];
        }
        await this.saveData(data);
    }

    // ── dismissal helpers ───────────────────────────────────────────────────

    /** Rebuild the O(1) lookup set from the persisted array. */
    private rebuildDismissalSet(): void {
        this.dismissedSet.clear();
        for (const group of this.dismissedGroups) {
            this.dismissedSet.add([...group].sort().join("\0"));
        }
    }

    /** Persist a group dismissal. */
    public async dismissGroup(paths: string[]): Promise<void> {
        const sorted = [...paths].sort();
        this.dismissedGroups.push(sorted);
        this.dismissedSet.add(sorted.join("\0"));
        await this.saveDismissals();
    }

    /** Check whether a group (by its file paths) has been dismissed. */
    public isDismissed(paths: string[]): boolean {
        return this.dismissedSet.has([...paths].sort().join("\0"));
    }

    /** Remove all persisted dismissals. */
    public async clearDismissals(): Promise<void> {
        this.dismissedGroups = [];
        this.dismissedSet.clear();
        await this.saveDismissals();
    }

    /** Write dismissedGroups into data.json without clobbering other keys. */
    private async saveDismissals(): Promise<void> {
        const data = (await this.loadData()) || {};
        data["dismissedGroups"] = this.dismissedGroups;
        await this.saveData(data);
    }

    /** Drop any groups whose sorted path set is in the dismissal set. */
    private filterDismissedGroups(groups: DuplicateGroup[]): DuplicateGroup[] {
        return groups.filter((g) => !this.isDismissed(g.files.map((f) => f.path)));
    }

    // ── view activation ────────────────────────────────────────────────────

    async activateView(): Promise<void> {
        const { workspace } = this.app;

        let leaf: WorkspaceLeaf | null = null;
        const leaves = workspace.getLeavesOfType(DUPLICATE_REVIEW_VIEW_TYPE);

        if (leaves.length > 0) {
            leaf = leaves[0];
        } else {
            leaf = workspace.getRightLeaf(false);
            await leaf?.setViewState({
                type: DUPLICATE_REVIEW_VIEW_TYPE,
                active: true,
            });
        }

        if (leaf) {
            workspace.revealLeaf(leaf);
        }
    }

    // ── auto-populate from cache ───────────────────────────────────────────

    /**
     * If the review pane is open but empty, load the most recently built
     * cache entry into it.  Used by "Open duplicate review pane" so that
     * a background-built cache is immediately visible.
     */
    async loadMostRecentCache(): Promise<void> {
        if (!this.duplicateReviewView || this.duplicateReviewView.hasData()) return;

        const recentPath = this.cacheManager.getMostRecentFolderPath();
        if (recentPath === null) return;

        const folder = recentPath === "/"
            ? this.app.vault.getRoot()
            : this.app.vault.getFolderByPath(recentPath);
        if (!folder) return;

        const files = collectMarkdownFiles(this.app, folder, this.settings.ignoredFolders);
        const cached = this.cacheManager.get(recentPath, files, this.settings);
        if (!cached) return;

        const displayPath = recentPath === "/" ? "Entire vault" : recentPath;
        this.duplicateReviewView.setGroups(this.filterDismissedGroups(cached), displayPath, true);
    }

    // ── duplicate review (cache-aware) ─────────────────────────────────────

    async startDuplicateReview(folder: TFolder): Promise<void> {
        await this.activateView();

        const folderPath = folder.path === "/" ? "Entire vault" : folder.path;
        const cacheKey = folder.path;

        // Show scanning state in the view
        if (this.duplicateReviewView) {
            this.duplicateReviewView.showScanning(folderPath);
        }

        // ── cache hit? ─────────────────────────────────────────────────────
        const files = collectMarkdownFiles(this.app, folder, this.settings.ignoredFolders);
        const cached = this.cacheManager.get(cacheKey, files, this.settings);
        if (cached) {
            const visible = this.filterDismissedGroups(cached);
            if (this.duplicateReviewView) {
                this.duplicateReviewView.setGroups(visible, folderPath, true);
            }
            if (visible.length === 0) {
                new Notice("No duplicates found (cached).");
            } else {
                const totalFiles = visible.reduce((sum, g) => sum + g.files.length, 0);
                new Notice(`Found ${visible.length} duplicate groups with ${totalFiles} files (cached).`);
            }
            return;
        }

        // ── cache miss — run scan ──────────────────────────────────────────
        // Abort any previous scan for the same folder
        const prev = this.scanControllers.get(cacheKey);
        if (prev) prev.abort();
        const controller = new AbortController();
        this.scanControllers.set(cacheKey, controller);

        new Notice(`Scanning for duplicates in ${folderPath}...`);

        try {
            const onProgress = (progress: ScanProgress) => {
                if (this.duplicateReviewView) {
                    this.duplicateReviewView.updateProgress(progress);
                }
            };

            const groups = await scanForDuplicates(
                this.app,
                folder,
                this.settings,
                this.settings.enableContentSimilarity,
                controller.signal,
                onProgress
            );

            if (controller.signal.aborted) return;

            // Cache the result (unfiltered — dismissals are a view-layer filter)
            this.cacheManager.put(cacheKey, files, groups, this.settings);
            this.cacheManager.clearDirtyPathsForFolder(cacheKey);
            await this.cacheManager.save();

            const visible = this.filterDismissedGroups(groups);
            if (this.duplicateReviewView) {
                this.duplicateReviewView.setGroups(visible, folderPath, false);
            }

            if (visible.length === 0) {
                new Notice("No duplicates found.");
            } else {
                const totalFiles = visible.reduce((sum, g) => sum + g.files.length, 0);
                new Notice(`Found ${visible.length} duplicate groups with ${totalFiles} files.`);
            }
        } catch (error) {
            if (controller.signal.aborted) return;
            new Notice(`Error scanning for duplicates: ${error.message}`);
            console.error("Duplicate scan error:", error);
        } finally {
            this.scanControllers.delete(cacheKey);
        }
    }

    // ── background cache build ─────────────────────────────────────────────

    async buildCacheInBackground(folder: TFolder): Promise<void> {
        const folderPath = folder.path === "/" ? "Entire vault" : folder.path;
        const cacheKey = folder.path;

        // Abort any previous scan for the same folder
        const prev = this.scanControllers.get(cacheKey);
        if (prev) prev.abort();
        const controller = new AbortController();
        this.scanControllers.set(cacheKey, controller);

        // Persistent notice that we update as progress comes in
        const notice = new Notice(`Building cache for ${folderPath}… Collecting files…`, 0);

        try {
            const files = collectMarkdownFiles(this.app, folder, this.settings.ignoredFolders);

            const onProgress = (progress: ScanProgress) => {
                if (controller.signal.aborted) return;
                const pct = progress.total > 0
                    ? Math.round((progress.current / progress.total) * 100)
                    : 0;
                notice.setMessage(`Building cache for ${folderPath}… ${progress.stage} ${pct}%`);

                // If the review pane is open and showing this folder, push progress there too
                if (this.duplicateReviewView) {
                    this.duplicateReviewView.updateProgress(progress);
                }
            };

            const groups = await scanForDuplicates(
                this.app,
                folder,
                this.settings,
                this.settings.enableContentSimilarity,
                controller.signal,
                onProgress
            );

            if (controller.signal.aborted) {
                notice.hide();
                return;
            }

            // Persist
            this.cacheManager.put(cacheKey, files, groups, this.settings);
            this.cacheManager.clearDirtyPathsForFolder(cacheKey);
            await this.cacheManager.save();

            notice.hide();
            const totalFiles = groups.reduce((sum, g) => sum + g.files.length, 0);
            new Notice(
                groups.length === 0
                    ? `Cache built for ${folderPath}: no duplicates found.`
                    : `Cache built for ${folderPath}: ${groups.length} groups, ${totalFiles} files.`
            );

            // If the review pane is currently showing this folder, refresh it
            if (this.duplicateReviewView) {
                this.duplicateReviewView.setGroups(this.filterDismissedGroups(groups), folderPath, false);
            }
        } catch (error) {
            notice.hide();
            if (controller.signal.aborted) return;
            new Notice(`Cache build failed: ${error.message}`);
            console.error("Cache build error:", error);
        } finally {
            this.scanControllers.delete(cacheKey);
        }
    }

    // ── pattern review ─────────────────────────────────────────────────────

    async startPatternReview(pattern: string): Promise<void> {
        await this.activateView();

        new Notice(`Finding notes matching "${pattern}"...`);

        try {
            const root = this.app.vault.getRoot();
            const files = collectMarkdownFiles(this.app, root, this.settings.ignoredFolders);
            const matchingFiles = findByPattern(files, [pattern]);

            if (matchingFiles.length === 0) {
                new Notice(`No files found matching "${pattern}".`);
                if (this.duplicateReviewView) {
                    this.duplicateReviewView.setGroups([], `Pattern: ${pattern}`, false);
                }
                return;
            }

            // Pattern scans are typically small — no caching, but still async + yielding
            let candidates = await findTitleDuplicates(
                matchingFiles,
                this.settings.titleSimilarityThreshold
            );

            // Apply YAML exclusions before grouping
            const exclusionMap = buildExclusionMap(this.app, matchingFiles);
            candidates = filterExcludedCandidates(candidates, exclusionMap);

            const groups = groupDuplicates(candidates);

            if (groups.length === 0 && matchingFiles.length > 1) {
                groups.push({
                    normalizedTitle: pattern.toLowerCase(),
                    originalTitles: new Set(matchingFiles.map((f) => f.basename)),
                    files: matchingFiles,
                    candidates: [],
                });
            }

            const visible = this.filterDismissedGroups(groups);
            if (this.duplicateReviewView) {
                this.duplicateReviewView.setGroups(visible, `Pattern: ${pattern}`, false);
            }

            new Notice(`Found ${matchingFiles.length} files matching "${pattern}".`);
        } catch (error) {
            new Notice(`Error during pattern search: ${error.message}`);
            console.error("Pattern search error:", error);
        }
    }

    // ── multi-pane comparison ──────────────────────────────────────────────

    async openMultiPaneComparison(files: TFile[]): Promise<void> {
        const maxPanes = this.settings.maxComparisonPanes;
        const filesToOpen = files.slice(0, maxPanes);

        if (filesToOpen.length === 0) {
            return;
        }

        let leaf = this.app.workspace.getLeaf();
        await leaf.openFile(filesToOpen[0]);

        for (let i = 1; i < filesToOpen.length; i++) {
            leaf = this.app.workspace.getLeaf("split", "vertical");
            await leaf.openFile(filesToOpen[i]);
        }

        new Notice(`Opened ${filesToOpen.length} files for comparison.`);
    }
}
