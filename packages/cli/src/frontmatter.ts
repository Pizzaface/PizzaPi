/**
 * Shared frontmatter parsing for skills and agents markdown files.
 *
 * Extracted from skills.ts / agents.ts, which had byte-identical
 * implementations of this logic.
 */

/**
 * Parse the `description` field out of a frontmatter string.
 * Pure function — no filesystem access.
 */
export function parseFrontmatterDescription(content: string): { description: string } {
    if (!content.startsWith("---")) return { description: "" };
    const end = content.indexOf("\n---", 3);
    if (end === -1) return { description: "" };

    const block = content.slice(3, end);
    const match = block.match(/^description:\s*(.+)$/m);
    return { description: match ? match[1].trim().replace(/^["']|["']$/g, "") : "" };
}
