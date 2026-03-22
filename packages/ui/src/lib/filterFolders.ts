/**
 * Pure utility: filter a list of folder paths by a case-insensitive query.
 * Matches if the query appears in the full path OR in the basename.
 *
 * Extracted from NewSessionWizardDialog so it can be unit-tested without
 * pulling in React/JSX dependencies.
 */
export function filterFolders(folders: string[], query: string): string[] {
    if (!query.trim()) return folders;
    const q = query.toLowerCase();
    return folders.filter((f) => {
        const basename = f.split("/").filter(Boolean).pop() ?? f;
        return f.toLowerCase().includes(q) || basename.toLowerCase().includes(q);
    });
}
