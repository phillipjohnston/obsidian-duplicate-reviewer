import { App, TFile, TFolder } from "obsidian";
import { normalizeTitle, titleSimilarity, contentSimilarity } from "src/similarity";
import { DuplicateCandidate, DuplicateGroup, DuplicateReviewerSettings } from "src/types";

/**
 * Check if a file path should be skipped based on ignored folders.
 */
export function shouldSkipPath(path: string, ignoredFolders: string[]): boolean {
    for (const ignore of ignoredFolders) {
        if (path.includes(ignore)) {
            return true;
        }
    }
    // Skip hidden folders/files
    const parts = path.split("/");
    for (const part of parts) {
        if (part.startsWith(".")) {
            return true;
        }
    }
    return false;
}

/**
 * Collect all markdown files from a folder recursively.
 */
export function collectMarkdownFiles(
    app: App,
    folder: TFolder,
    ignoredFolders: string[]
): TFile[] {
    const files: TFile[] = [];

    const collectRecursive = (currentFolder: TFolder) => {
        for (const child of currentFolder.children) {
            if (child instanceof TFile && child.extension === "md") {
                if (!shouldSkipPath(child.path, ignoredFolders)) {
                    files.push(child);
                }
            } else if (child instanceof TFolder) {
                if (!shouldSkipPath(child.path, ignoredFolders)) {
                    collectRecursive(child);
                }
            }
        }
    };

    collectRecursive(folder);
    return files;
}

/**
 * Find potential duplicate notes based on title similarity.
 */
export function findTitleDuplicates(
    files: TFile[],
    titleThreshold: number
): DuplicateCandidate[] {
    const duplicates: DuplicateCandidate[] = [];
    const checkedPairs = new Set<string>();

    for (let i = 0; i < files.length; i++) {
        const file1 = files[i];
        const title1 = file1.basename;

        for (let j = i + 1; j < files.length; j++) {
            const file2 = files[j];
            const title2 = file2.basename;

            // Create unique pair key
            const pairKey = [file1.path, file2.path].sort().join("|");
            if (checkedPairs.has(pairKey)) {
                continue;
            }
            checkedPairs.add(pairKey);

            // Calculate title similarity
            const tSim = titleSimilarity(title1, title2);

            if (tSim >= titleThreshold) {
                duplicates.push({
                    file1,
                    file2,
                    titleSimilarity: tSim,
                });
            }
        }
    }

    // Sort by title similarity descending
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
    maxChars: number
): Promise<DuplicateCandidate[]> {
    const refined: DuplicateCandidate[] = [];

    for (const item of candidates) {
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
            // Keep item without content similarity if files can't be read
            refined.push({
                ...item,
                contentSimilarity: undefined,
                likelyDuplicate: false,
            });
        }
    }

    // Sort by combined similarity (title + content)
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

        // Add files to the group (avoiding duplicates)
        if (!group.files.some((f) => f.path === candidate.file1.path)) {
            group.files.push(candidate.file1);
        }
        if (!group.files.some((f) => f.path === candidate.file2.path)) {
            group.files.push(candidate.file2);
        }
    }

    // Convert to array and sort by file count descending
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
    refine: boolean = true
): Promise<DuplicateGroup[]> {
    // Collect files
    const files = collectMarkdownFiles(app, folder, settings.ignoredFolders);

    if (files.length < 2) {
        return [];
    }

    // Find title duplicates
    let candidates = findTitleDuplicates(files, settings.titleSimilarityThreshold);

    // Optionally refine with content
    if (refine && candidates.length > 0) {
        candidates = await refineWithContent(
            app,
            candidates,
            settings.contentSimilarityThreshold,
            settings.contentCharsToAnalyze
        );
    }

    // Group by normalized title
    return groupDuplicates(candidates);
}
