import {
    Notice,
    Plugin,
    TAbstractFile,
    TFile,
    TFolder,
    WorkspaceLeaf,
} from "obsidian";

import { DuplicateReviewerSettings, DEFAULT_SETTINGS } from "./types";
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
} from "./scanner";

export default class DuplicateReviewerPlugin extends Plugin {
    settings: DuplicateReviewerSettings;
    private duplicateReviewView: DuplicateReviewView;

    async onload(): Promise<void> {
        await this.loadSettings();

        // Register the sidebar view
        this.registerView(
            DUPLICATE_REVIEW_VIEW_TYPE,
            (leaf) => (this.duplicateReviewView = new DuplicateReviewView(leaf, this))
        );

        // Add settings tab
        this.addSettingTab(new DuplicateReviewerSettingTab(this.app, this));

        // Register folder context menu
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

        // Command: Find duplicates in vault
        this.addCommand({
            id: "find-duplicates-in-vault",
            name: "Find duplicates in vault",
            callback: () => {
                new FolderSelectModal(this.app, this.settings, (folder) => {
                    this.startDuplicateReview(folder);
                }).open();
            },
        });

        // Command: Find duplicates by pattern
        this.addCommand({
            id: "find-duplicates-by-pattern",
            name: "Find duplicates by pattern",
            callback: () => {
                new PatternSelectModal(this.app, this.settings, (pattern) => {
                    this.startPatternReview(pattern);
                }).open();
            },
        });

        // Command: Review next duplicate group
        this.addCommand({
            id: "review-next-duplicate-group",
            name: "Review next duplicate group",
            callback: () => {
                if (this.duplicateReviewView) {
                    this.duplicateReviewView.nextGroup();
                }
            },
        });

        // Command: Review previous duplicate group
        this.addCommand({
            id: "review-previous-duplicate-group",
            name: "Review previous duplicate group",
            callback: () => {
                if (this.duplicateReviewView) {
                    this.duplicateReviewView.previousGroup();
                }
            },
        });

        // Command: Open duplicate review pane
        this.addCommand({
            id: "open-duplicate-review-pane",
            name: "Open duplicate review pane",
            callback: () => {
                this.activateView();
            },
        });
    }

    onunload(): void {
        this.app.workspace.detachLeavesOfType(DUPLICATE_REVIEW_VIEW_TYPE);
    }

    async loadSettings(): Promise<void> {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings(): Promise<void> {
        await this.saveData(this.settings);
    }

    /**
     * Activate the duplicate review sidebar view.
     */
    async activateView(): Promise<void> {
        const { workspace } = this.app;

        let leaf: WorkspaceLeaf | null = null;
        const leaves = workspace.getLeavesOfType(DUPLICATE_REVIEW_VIEW_TYPE);

        if (leaves.length > 0) {
            // View already open
            leaf = leaves[0];
        } else {
            // Create new view in right sidebar
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

    /**
     * Start duplicate review for a folder.
     */
    async startDuplicateReview(folder: TFolder): Promise<void> {
        // Activate the view first
        await this.activateView();

        const folderPath = folder.path === "/" ? "Entire vault" : folder.path;

        // Show scanning state
        if (this.duplicateReviewView) {
            this.duplicateReviewView.showScanning(folderPath);
        }

        new Notice(`Scanning for duplicates in ${folderPath}...`);

        try {
            // Perform the scan
            const groups = await scanForDuplicates(
                this.app,
                folder,
                this.settings,
                this.settings.enableContentSimilarity
            );

            // Update the view with results
            if (this.duplicateReviewView) {
                this.duplicateReviewView.setGroups(groups, folderPath);
            }

            if (groups.length === 0) {
                new Notice("No duplicates found.");
            } else {
                const totalFiles = groups.reduce((sum, g) => sum + g.files.length, 0);
                new Notice(`Found ${groups.length} duplicate groups with ${totalFiles} files.`);
            }
        } catch (error) {
            new Notice(`Error scanning for duplicates: ${error.message}`);
            console.error("Duplicate scan error:", error);
        }
    }

    /**
     * Start pattern-based review.
     */
    async startPatternReview(pattern: string): Promise<void> {
        // Activate the view first
        await this.activateView();

        new Notice(`Finding notes matching "${pattern}"...`);

        try {
            // Get all files in vault
            const root = this.app.vault.getRoot();
            const files = collectMarkdownFiles(this.app, root, this.settings.ignoredFolders);

            // Find files matching the pattern
            const matchingFiles = findByPattern(files, [pattern]);

            if (matchingFiles.length === 0) {
                new Notice(`No files found matching "${pattern}".`);
                if (this.duplicateReviewView) {
                    this.duplicateReviewView.setGroups([], `Pattern: ${pattern}`);
                }
                return;
            }

            // Find duplicates among matching files
            const candidates = findTitleDuplicates(
                matchingFiles,
                this.settings.titleSimilarityThreshold
            );

            const groups = groupDuplicates(candidates);

            // If no duplicates found among matches, create a single group with all matches
            if (groups.length === 0 && matchingFiles.length > 1) {
                // Create a single group containing all matching files
                const singleGroup = {
                    normalizedTitle: pattern.toLowerCase(),
                    originalTitles: new Set(matchingFiles.map((f) => f.basename)),
                    files: matchingFiles,
                    candidates: [],
                };
                groups.push(singleGroup);
            }

            // Update the view
            if (this.duplicateReviewView) {
                this.duplicateReviewView.setGroups(groups, `Pattern: ${pattern}`);
            }

            new Notice(`Found ${matchingFiles.length} files matching "${pattern}".`);
        } catch (error) {
            new Notice(`Error during pattern search: ${error.message}`);
            console.error("Pattern search error:", error);
        }
    }

    /**
     * Open multiple files in split panes for comparison.
     */
    async openMultiPaneComparison(files: TFile[]): Promise<void> {
        const maxPanes = this.settings.maxComparisonPanes;
        const filesToOpen = files.slice(0, maxPanes);

        if (filesToOpen.length === 0) {
            return;
        }

        // Open first file in current leaf
        let leaf = this.app.workspace.getLeaf();
        await leaf.openFile(filesToOpen[0]);

        // Open remaining files in vertical splits
        for (let i = 1; i < filesToOpen.length; i++) {
            leaf = this.app.workspace.getLeaf("split", "vertical");
            await leaf.openFile(filesToOpen[i]);
        }

        new Notice(`Opened ${filesToOpen.length} files for comparison.`);
    }
}
