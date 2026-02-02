/**
 * Extract the body content after YAML frontmatter.
 */
function extractBody(content: string): string {
    if (content.startsWith("---")) {
        const parts = content.split("---");
        if (parts.length >= 3) {
            // Join everything after the second '---'
            return parts.slice(2).join("---").trim();
        }
    }
    return content.trim();
}

/**
 * Calculate similarity between two content strings.
 * Uses Jaccard similarity on word sets from the first maxChars characters.
 */
export function contentSimilarity(
    content1: string,
    content2: string,
    maxChars: number = 1000
): number {
    const body1 = extractBody(content1).substring(0, maxChars);
    const body2 = extractBody(content2).substring(0, maxChars);

    // Normalize and split into words
    const words1 = new Set(
        body1
            .toLowerCase()
            .match(/\w+/g)
            ?.filter(Boolean) || []
    );
    const words2 = new Set(
        body2
            .toLowerCase()
            .match(/\w+/g)
            ?.filter(Boolean) || []
    );

    if (words1.size === 0 || words2.size === 0) {
        return 0.0;
    }

    // Calculate intersection
    const intersection = new Set([...words1].filter((x) => words2.has(x)));

    // Calculate union
    const union = new Set([...words1, ...words2]);

    return intersection.size / union.size;
}
