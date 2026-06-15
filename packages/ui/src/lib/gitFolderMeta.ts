/**
 * Git metadata for a recent folder entry in the New Session dialog.
 *
 * Returned by the runner's `inspect_folders` command and surfaced by the
 * `/api/runners/:id/folders/inspect` endpoint.
 */
export interface FolderGitMetadata {
    path: string;
    isGit: boolean;
    repoRoot?: string;
    branch?: string;
    isWorktree?: boolean;
    mainRepoPath?: string;
    error?: string;
}

/** Build a path-keyed lookup from a list of folder metadata entries. */
export function buildFolderMetaMap(folders: FolderGitMetadata[]): Map<string, FolderGitMetadata> {
    const map = new Map<string, FolderGitMetadata>();
    for (const folder of folders) {
        map.set(folder.path, folder);
    }
    return map;
}

/**
 * Format a short label for a worktree entry when its main repo is also in the
 * recent list. Returns `null` when no association label is needed.
 */
export function formatWorktreeLabel(
    meta: FolderGitMetadata,
    recentPaths: Set<string>,
): string | null {
    if (!meta.isGit || !meta.isWorktree || !meta.mainRepoPath) return null;
    if (!recentPaths.has(meta.mainRepoPath)) return null;
    const basename = meta.mainRepoPath.split("/").filter(Boolean).pop() ?? meta.mainRepoPath;
    return `worktree of ${basename}`;
}
