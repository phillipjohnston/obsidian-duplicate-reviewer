/**
 * Normalize a title for comparison.
 * Removes common prefixes, punctuation, and converts to lowercase.
 */
export function normalizeTitle(title: string): string {
    let normalized = title;

    // Remove file extension
    normalized = normalized.replace(/\.md$/i, "");

    // Remove common index prefixes like "EAD0001" or "250.25"
    normalized = normalized.replace(/^\[?[A-Z]{2,4}\d+\]?\s*/, "");
    normalized = normalized.replace(/^\d+\.\d+\s*/, "");

    // Convert to lowercase and remove punctuation
    normalized = normalized.toLowerCase();
    normalized = normalized.replace(/[^\w\s]/g, "");

    // Normalize whitespace
    normalized = normalized.split(/\s+/).filter(Boolean).join(" ");

    return normalized;
}

/**
 * Calculate similarity between two titles using Jaccard similarity on words.
 * Returns a value between 0 and 1.
 */
export function titleSimilarity(title1: string, title2: string): number {
    const norm1 = normalizeTitle(title1);
    const norm2 = normalizeTitle(title2);

    const words1 = new Set(norm1.split(/\s+/).filter(Boolean));
    const words2 = new Set(norm2.split(/\s+/).filter(Boolean));

    if (words1.size === 0 || words2.size === 0) {
        return 0.0;
    }

    // Calculate intersection
    const intersection = new Set([...words1].filter((x) => words2.has(x)));

    // Calculate union
    const union = new Set([...words1, ...words2]);

    return intersection.size / union.size;
}
