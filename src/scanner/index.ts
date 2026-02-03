import { App, TFile, TFolder } from "obsidian";
import { normalizeTitle, titleSimilarity, contentSimilarity } from "src/similarity";
import { DuplicateCandidate, DuplicateGroup, DuplicateReviewerSettings, ScanProgress } from "src/types";

function yieldToEventLoop(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Check if a file path should be skipped based on ignored folders.
 */
export function shouldSkipPath(path: string, ignoredFolders: string[]): boolean {
    for (const ignore of ignoredFolders) {
        if (path.includes(ignore)) {
            return true;
        }
    }
    const parts = path.split("/");
    for (const part of parts) {
        if (part.startsWith(".")) {
            return true;
        }
    }
    return false;
}

/**
 * Collect markdown files scoped to a folder, using vault.getMarkdownFiles().
 */
export function collectMarkdownFiles(
    app: App,
    folder: TFolder,
    ignoredFolders: string[]
): TFile[] {
    const prefix = folder.path === "/" ? "" : folder.path + "/";
    return app.vault.getMarkdownFiles().filter((file) =>
        (prefix === "" || file.path.startsWith(prefix)) &&
        !shouldSkipPath(file.path, ignoredFolders)
    );
}

/**
 * Compute the normalised word set for a filename (the unit the inverted index keys on).
 */
function wordSet(basename: string): Set<string> {
    const norm = normalizeTitle(basename);
    return new Set(norm.split(/\s+/).filter(Boolean));
}

/**
 * Find potential duplicate notes using an inverted-index single-pass algorithm.
 *
 * For each file processed, its words are looked up in the index to find
 * previously-seen files that share at least one word.  Only those candidate
 * pairs are scored with full Jaccard similarity — the vast majority of the
 * vault never needs to be compared at all.  Yields to the event loop after
 * every file so Obsidian stays responsive on large vaults.
 */
export async function findTitleDuplicates(
    files: TFile[],
    titleThreshold: number,
    signal?: AbortSignal,
    onProgress?: (progress: ScanProgress) => void
): Promise<DuplicateCandidate[]> {
    const duplicates: DuplicateCandidate[] = [];

    // inverted index: normalised word → indices into `files` already processed
    const index = new Map<string, number[]>();
    // pre-computed word sets, keyed by file index
    const wordSets = new Map<number, Set<string>>();

    for (let i = 0; i < files.length; i++) {
        if (signal?.aborted) break;

        const file = files[i];
        const words = wordSet(file.basename);
        wordSets.set(i, words);

        // Collect candidate indices: files already in the index that share ≥1 word
        const candidateIndices = new Set<number>();
        for (const w of words) {
            const bucket = index.get(w);
            if (bucket) {
                for (const idx of bucket) {
                    candidateIndices.add(idx);
                }
            }
        }

        // Score only the candidates
        for (const j of candidateIndices) {
            const otherWords = wordSets.get(j)!;
            // Jaccard on pre-computed word sets (same logic as titleSimilarity)
            let intersectionCount = 0;
            for (const w of words) {
                if (otherWords.has(w)) intersectionCount++;
            }
            const unionSize = words.size + otherWords.size - intersectionCount;
            const sim = unionSize === 0 ? 0 : intersectionCount / unionSize;

            if (sim >= titleThreshold) {
                duplicates.push({
                    file1: files[j],
                    file2: file,
                    titleSimilarity: sim,
                });
            }
        }

        // Insert this file into the index
        for (const w of words) {
            let bucket = index.get(w);
            if (!bucket) {
                bucket = [];
                index.set(w, bucket);
            }
            bucket.push(i);
        }

        // Yield + progress every file
        await yieldToEventLoop();
        if (onProgress) {
            onProgress({ stage: "comparing", current: i + 1, total: files.length });
        }
    }

    duplicates.sort((a, b) => b.titleSimilarity - a.titleSimilarity);
    return duplicates;
}

/**
 * Refine duplicate candidates by adding content similarity scores.
 */
export async function refineWithContent(
    app: App,
    candidates: DuplicateCandidate[],
    contentThreshold: number,
    maxChars: number,
    signal?: AbortSignal,
    onProgress?: (progress: ScanProgress) => void
): Promise<DuplicateCandidate[]> {
    const refined: DuplicateCandidate[] = [];

    for (let i = 0; i < candidates.length; i++) {
        if (signal?.aborted) break;

        const item = candidates[i];
        try {
            const content1 = await app.vault.cachedRead(item.file1);
            const content2 = await app.vault.cachedRead(item.file2);

            const cSim = contentSimilarity(content1, content2, maxChars);

            refined.push({
                ...item,
                contentSimilarity: cSim,
                likelyDuplicate: cSim >= contentThreshold,
            });
        } catch {
            refined.push({
                ...item,
                contentSimilarity: undefined,
                likelyDuplicate: false,
            });
        }

        await yieldToEventLoop();
        if (onProgress) {
            onProgress({ stage: "refining", current: i + 1, total: candidates.length });
        }
    }

    refined.sort((a, b) => {
        const scoreA = a.titleSimilarity + (a.contentSimilarity || 0);
        const scoreB = b.titleSimilarity + (b.contentSimilarity || 0);
        return scoreB - scoreA;
    });

    return refined;
}

/**
 * Group duplicate candidates by normalized title.
 */
export function groupDuplicates(candidates: DuplicateCandidate[]): DuplicateGroup[] {
    const titleGroups = new Map<string, DuplicateGroup>();

    for (const candidate of candidates) {
        const normTitle = normalizeTitle(candidate.file1.basename);

        if (!titleGroups.has(normTitle)) {
            titleGroups.set(normTitle, {
                normalizedTitle: normTitle,
                originalTitles: new Set(),
                files: [],
                candidates: [],
            });
        }

        const group = titleGroups.get(normTitle)!;
        group.originalTitles.add(candidate.file1.basename);
        group.originalTitles.add(candidate.file2.basename);
        group.candidates.push(candidate);

        if (!group.files.some((f) => f.path === candidate.file1.path)) {
            group.files.push(candidate.file1);
        }
        if (!group.files.some((f) => f.path === candidate.file2.path)) {
            group.files.push(candidate.file2);
        }
    }

    const groups = Array.from(titleGroups.values());
    groups.sort((a, b) => b.files.length - a.files.length);
    return groups;
}

/**
 * Find files matching a pattern (for pattern-based review).
 */
export function findByPattern(
    files: TFile[],
    patterns: string[]
): TFile[] {
    const lowerPatterns = patterns.map((p) => p.toLowerCase());

    return files.filter((file) => {
        const lowerName = file.basename.toLowerCase();
        return lowerPatterns.some((pattern) => lowerName.includes(pattern));
    });
}

/**
 * Full scan for duplicates in a folder.
 */
export async function scanForDuplicates(
    app: App,
    folder: TFolder,
    settings: DuplicateReviewerSettings,
    refine: boolean = true,
    signal?: AbortSignal,
    onProgress?: (progress: ScanProgress) => void
): Promise<DuplicateGroup[]> {
    const files = collectMarkdownFiles(app, folder, settings.ignoredFolders);

    if (files.length < 2) {
        return [];
    }

    if (onProgress) {
        onProgress({ stage: "collecting", current: files.length, total: files.length });
    }

    let candidates = await findTitleDuplicates(
        files,
        settings.titleSimilarityThreshold,
        signal,
        onProgress
    );

    if (signal?.aborted) return [];

    if (refine && candidates.length > 0) {
        candidates = await refineWithContent(
            app,
            candidates,
            settings.contentSimilarityThreshold,
            settings.contentCharsToAnalyze,
            signal,
            onProgress
        );
    }

    if (signal?.aborted) return [];

    if (onProgress) {
        onProgress({ stage: "grouping", current: 0, total: candidates.length });
    }

    const groups = groupDuplicates(candidates);

    if (onProgress) {
        onProgress({ stage: "done", current: groups.length, total: groups.length });
    }

    return groups;
}
