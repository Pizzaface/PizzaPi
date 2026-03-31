import type { GitChange, GitStatus } from "./useGitService";

export type GitOptimisticMutation =
    | { type: "stage"; paths?: string[]; all?: boolean }
    | { type: "unstage"; paths?: string[]; all?: boolean };

function hasStagedChanges(status: string): boolean {
    return status.length === 2 && status[0] !== " " && status[0] !== "?" && status[0] !== "!";
}

function hasUnstagedChanges(status: string): boolean {
    return status === "??" || (status.length === 2 && status[1] !== " ");
}

function cloneChange(change: GitChange): GitChange {
    return change.originalPath
        ? { status: change.status, path: change.path, originalPath: change.originalPath }
        : { status: change.status, path: change.path };
}

export function cloneStatusSnapshot(status: GitStatus | null): GitStatus | null {
    if (!status) return null;
    return {
        ...status,
        changes: status.changes.map(cloneChange),
    };
}

function applyOptimisticStage(change: GitChange): GitChange {
    if (!hasUnstagedChanges(change.status)) return change;

    if (change.status === "??") {
        return { ...change, status: "A " };
    }

    if (change.status.length !== 2) return change;

    const worktreeStatus = change.status[1];
    if (worktreeStatus === " " || worktreeStatus === "?" || worktreeStatus === "!") {
        return change;
    }

    return { ...change, status: `${worktreeStatus} ` };
}

function applyOptimisticUnstage(change: GitChange): GitChange | null {
    if (!hasStagedChanges(change.status)) return change;

    if (change.status.length !== 2) return change;

    const indexStatus = change.status[0];

    if (indexStatus === "A") {
        if (change.status[1] === "D") return null;
        return { ...change, status: "??" };
    }

    if (indexStatus === " " || indexStatus === "?" || indexStatus === "!") return change;

    return { ...change, status: ` ${indexStatus}` };
}

function shouldMutatePath(changePath: string, mutation: GitOptimisticMutation): boolean {
    if (mutation.all) return true;
    const paths = mutation.paths ?? [];
    if (paths.length === 0) return false;
    return paths.includes(changePath);
}

export function applyOptimisticMutation(
    status: GitStatus | null,
    mutation: GitOptimisticMutation,
): GitStatus | null {
    if (!status) return status;

    const nextChanges: GitChange[] = [];
    let changed = false;

    for (const change of status.changes) {
        if (!shouldMutatePath(change.path, mutation)) {
            nextChanges.push(change);
            continue;
        }

        const transformed = mutation.type === "stage"
            ? applyOptimisticStage(change)
            : applyOptimisticUnstage(change);

        if (transformed === null) {
            changed = true;
            continue;
        }

        nextChanges.push(transformed);
        if (transformed.status !== change.status || transformed.path !== change.path || transformed.originalPath !== change.originalPath) {
            changed = true;
        }
    }

    if (!changed) return status;

    return {
        ...status,
        changes: nextChanges,
    };
}

export function consumeRollbackSnapshot(
    snapshots: Map<string, GitStatus | null>,
    requestId: string | undefined,
    ok: boolean,
): GitStatus | null | undefined {
    if (!requestId) return undefined;
    if (!snapshots.has(requestId)) return undefined;

    const previous = snapshots.get(requestId);
    snapshots.delete(requestId);

    if (ok) return undefined;
    return previous;
}
