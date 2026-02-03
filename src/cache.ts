import { App, TFile } from "obsidian";
import type DuplicateReviewerPlugin from "src/main";
import {
    CacheEntry,
    DuplicateGroup,
    DuplicateReviewerSettings,
    SerializedDuplicateGroup,
} from "src/types";

const CACHE_KEY = "duplicateCache";

export class CacheManager {
    private entries: Map<string, CacheEntry> = new Map();
    dirtyPaths: Set<string> = new Set();

    constructor(private plugin: DuplicateReviewerPlugin, private app: App) {}

    // ── persistence ──────────────────────────────────────────────────────────

    async load(): Promise<void> {
        const data = await this.plugin.loadData();
        if (data && data[CACHE_KEY] && typeof data[CACHE_KEY] === "object") {
            for (const [key, value] of Object.entries(data[CACHE_KEY])) {
                this.entries.set(key, value as CacheEntry);
            }
        }
    }

    async save(): Promise<void> {
        const data = (await this.plugin.loadData()) || {};
        const serialized: Record<string, CacheEntry> = {};
        for (const [key, entry] of this.entries) {
            serialized[key] = entry;
        }
        data[CACHE_KEY] = serialized;
        await this.plugin.saveData(data);
    }

    // ── validation ───────────────────────────────────────────────────────────

    /**
     * Return true if the cached entry is still usable:
     *   1. No dirty .md paths since last load
     *   2. fileCount and maxMtime still match the live file set
     *   3. Cached settings match current plugin settings
     */
    isValid(entry: CacheEntry, currentFiles: TFile[], settings: DuplicateReviewerSettings): boolean {
        // Only invalidate when a dirty path actually falls inside this entry's folder
        if (this.dirtyPaths.size > 0) {
            if (entry.folderPath === "/") {
                return false; // root covers everything
            }
            const prefix = entry.folderPath + "/";
            for (const dirtyPath of this.dirtyPaths) {
                if (dirtyPath.startsWith(prefix)) return false;
            }
        }

        // File-count + mtime fingerprint
        if (currentFiles.length !== entry.fileCount) return false;

        let maxMtime = 0;
        for (const f of currentFiles) {
            if (f.stat.mtime > maxMtime) maxMtime = f.stat.mtime;
        }
        if (maxMtime !== entry.maxMtime) return false;

        // Settings fingerprint
        if (
            entry.settings.titleThreshold !== settings.titleSimilarityThreshold ||
            entry.settings.enableContent !== settings.enableContentSimilarity ||
            entry.settings.contentThreshold !== settings.contentSimilarityThreshold ||
            entry.settings.contentChars !== settings.contentCharsToAnalyze
        ) {
            return false;
        }

        return true;
    }

    // ── read / write ─────────────────────────────────────────────────────────

    /**
     * Store a scan result.  Computes the staleness fingerprint from the live
     * file list so we can detect changes on the next access.
     */
    put(folderPath: string, files: TFile[], groups: DuplicateGroup[], settings: DuplicateReviewerSettings): void {
        let maxMtime = 0;
        for (const f of files) {
            if (f.stat.mtime > maxMtime) maxMtime = f.stat.mtime;
        }

        const serializedGroups: SerializedDuplicateGroup[] = groups.map((g) => ({
            normalizedTitle: g.normalizedTitle,
            originalTitles: Array.from(g.originalTitles),
            filePaths: g.files.map((f) => f.path),
        }));

        const entry: CacheEntry = {
            folderPath,
            scanTimestamp: Date.now(),
            fileCount: files.length,
            maxMtime,
            groups: serializedGroups,
            settings: {
                titleThreshold: settings.titleSimilarityThreshold,
                enableContent: settings.enableContentSimilarity,
                contentThreshold: settings.contentSimilarityThreshold,
                contentChars: settings.contentCharsToAnalyze,
            },
        };

        this.entries.set(folderPath, entry);
    }

    /**
     * Retrieve cached groups for a folder.  Returns null if missing or stale.
     * Caller must pass the same file list used for validation.
     */
    get(folderPath: string, currentFiles: TFile[], settings: DuplicateReviewerSettings): DuplicateGroup[] | null {
        const entry = this.entries.get(folderPath);
        if (!entry) return null;
        if (!this.isValid(entry, currentFiles, settings)) {
            this.entries.delete(folderPath);
            return null;
        }
        return this.deserialize(entry);
    }

    /** Number of live cache entries. */
    get size(): number {
        return this.entries.size;
    }

    /** Timestamp of the most recent entry, or null if empty. */
    get lastBuilt(): number | null {
        let latest: number | null = null;
        for (const entry of this.entries.values()) {
            if (latest === null || entry.scanTimestamp > latest) {
                latest = entry.scanTimestamp;
            }
        }
        return latest;
    }

    /** Return the folder-path key of the most recently built entry, or null. */
    getMostRecentFolderPath(): string | null {
        let latestTimestamp = -1;
        let latestKey: string | null = null;
        for (const [key, entry] of this.entries) {
            if (entry.scanTimestamp > latestTimestamp) {
                latestTimestamp = entry.scanTimestamp;
                latestKey = key;
            }
        }
        return latestKey;
    }

    /** Remove only dirty paths that fall within the given folder. */
    clearDirtyPathsForFolder(folderPath: string): void {
        if (folderPath === "/") {
            this.dirtyPaths.clear();
            return;
        }
        const prefix = folderPath + "/";
        for (const path of this.dirtyPaths) {
            if (path.startsWith(prefix)) {
                this.dirtyPaths.delete(path);
            }
        }
    }

    /** Remove all entries and clear dirty tracking. */
    clear(): void {
        this.entries.clear();
        this.dirtyPaths.clear();
    }

    // ── internal ─────────────────────────────────────────────────────────────

    private deserialize(entry: CacheEntry): DuplicateGroup[] {
        const groups: DuplicateGroup[] = [];

        for (const sg of entry.groups) {
            const files: TFile[] = [];
            for (const path of sg.filePaths) {
                const file = this.app.vault.getFileByPath(path);
                if (file) files.push(file);
            }
            // Drop groups whose files have all been deleted
            if (files.length < 2) continue;

            groups.push({
                normalizedTitle: sg.normalizedTitle,
                originalTitles: new Set(sg.originalTitles),
                files,
                candidates: [], // not persisted; not needed for display
            });
        }

        return groups;
    }
}
