/**
 * Pure utility: filter a list of folder paths by a case-insensitive query.
 * Matches if the query appears in the full path OR in the basename.
 *
 * Extracted from NewSessionWizardDialog so it can be unit-tested without
 * pulling in React/JSX dependencies.
 */
import { pathSegments } from "./path";

export function filterFolders(folders: string[], query: string): string[] {
    if (!query.trim()) return folders;
    const q = query.toLowerCase();
    return folders.filter((f) => {
        const basename = pathSegments(f).pop() ?? f;
        return f.toLowerCase().includes(q) || basename.toLowerCase().includes(q);
    });
}

export function getInitialFolder(runnerId: string, folders: string[], initialCwd?: string): string {
    if (initialCwd?.trim()) return initialCwd;
    try {
        const persisted = localStorage.getItem(`pp.newSession.lastFolder.${runnerId}`);
        if (persisted && folders.includes(persisted)) return persisted;
    } catch { /* storage may be unavailable */ }
    return folders[0] ?? "";
}
