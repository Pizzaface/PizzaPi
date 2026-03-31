/**
 * useGitService — typed wrapper around useServiceChannel("git").
 *
 * Provides methods for all git operations (status, diff, branches,
 * checkout, stage, unstage, commit, push) and reactive state that
 * updates when responses arrive from the runner's GitService.
 */
import { useState, useCallback, useRef, useEffect } from "react";
import { useServiceChannel } from "./useServiceChannel";
import { createPostMutationRefreshScheduler } from "./git-status-refresh-scheduler";
import {
    applyOptimisticMutation,
    cloneStatusSnapshot,
    consumeRollbackSnapshot,
} from "./git-optimistic-status";

// ── Types ───────────────────────────────────────────────────────────────────

export interface GitChange {
    status: string;
    path: string;
    originalPath?: string;
}

export interface GitStatus {
    branch: string;
    changes: GitChange[];
    ahead: number;
    behind: number;
    /** Whether the current branch has an upstream tracking branch configured. */
    hasUpstream: boolean;
    diffStaged: string;
}

export interface GitBranch {
    name: string;
    shortHash: string;
    lastCommit: string;
    isCurrent: boolean;
    isRemote: boolean;
}

export interface GitWorktree {
    path: string;
    displayPath: string;
    branch: string;
    shortHash: string;
    isDetached: boolean;
    isMain: boolean;
    changeCount: number;
    ahead: number;
    behind: number;
}

export interface GitOperationResult {
    ok: boolean;
    message?: string;
    [key: string]: unknown;
}

// ── Hook ────────────────────────────────────────────────────────────────────

export interface UseGitServiceReturn {
    available: boolean;

    // State
    status: GitStatus | null;
    branches: GitBranch[];
    worktrees: GitWorktree[];
    currentBranch: string;
    loading: boolean;
    error: string | null;

    // Operation feedback
    operationInProgress: string | null;
    lastOperationResult: GitOperationResult | null;

    // Actions
    fetchStatus: () => void;
    fetchWorktrees: () => void;
    fetchDiff: (path: string, staged?: boolean) => Promise<string>;
    fetchBranches: () => void;
    checkout: (branch: string, isRemote?: boolean) => void;
    stage: (paths: string[]) => void;
    stageAll: () => void;
    unstage: (paths: string[]) => void;
    unstageAll: () => void;
    commit: (message: string) => void;
    push: (setUpstream?: boolean) => void;
    pull: () => void;
    clearOperationResult: () => void;
}

const POST_MUTATION_STATUS_REFRESH_DEBOUNCE_MS = 100;

export function useGitService(cwd: string): UseGitServiceReturn {
    const [status, setStatus] = useState<GitStatus | null>(null);
    const [branches, setBranches] = useState<GitBranch[]>([]);
    const [worktrees, setWorktrees] = useState<GitWorktree[]>([]);
    const [currentBranch, setCurrentBranch] = useState("");
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [operationInProgress, setOperationInProgress] = useState<string | null>(null);
    const [lastOperationResult, setLastOperationResult] = useState<GitOperationResult | null>(null);

    // Track pending diff requests: requestId → resolve callback
    const pendingDiffsRef = useRef(new Map<string, (diff: string) => void>());
    const pendingFullStatusRequestRef = useRef<string | null>(null);
    const fullStatusFallbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const statusRequestsInFlightRef = useRef(0);
    const optimisticSnapshotsRef = useRef(new Map<string, GitStatus | null>());

    // Generation counter — incremented on cwd change. Responses from stale
    // generations are discarded so a slow response from the old cwd doesn't
    // overwrite the new session's state.
    const generationRef = useRef(0);
    const statusGenRef = useRef(0); // generation when last status request was sent

    // Generate unique request IDs
    const nextId = useRef(0);
    const makeRequestId = useCallback(() => `git-${Date.now()}-${nextId.current++}`, []);

    // Stable ref for cwd so the onMessage callback sees the latest value
    // without needing to re-create the service channel.
    const cwdRef = useRef(cwd);
    cwdRef.current = cwd;

    // Ref for sendGit so callbacks can access latest version
    const sendRef = useRef<(type: string, payload: unknown, requestId?: string) => void>(() => {});

    const sendStatusRequest = useCallback((targetCwd: string) => {
        statusGenRef.current = generationRef.current;
        statusRequestsInFlightRef.current += 1;
        setLoading(true);
        setError(null);
        sendRef.current("git_status", { cwd: targetCwd }, makeRequestId());
    }, [makeRequestId]);

    const postMutationRefreshSchedulerRef = useRef(
        createPostMutationRefreshScheduler({
            debounceMs: POST_MUTATION_STATUS_REFRESH_DEBOUNCE_MS,
            getGeneration: () => generationRef.current,
            isStatusRequestInFlight: () => statusRequestsInFlightRef.current > 0,
            triggerRefresh: () => {
                sendStatusRequest(cwdRef.current);
            },
        })
    );

    const { send, available } = useServiceChannel<unknown, unknown>("git", {
        onMessage: (type, rawPayload, requestId) => {
            const payload = rawPayload as Record<string, unknown>;

            switch (type) {
                case "git_status_result": {
                    statusRequestsInFlightRef.current = Math.max(0, statusRequestsInFlightRef.current - 1);
                    // Ignore stale responses from a previous cwd
                    if (statusGenRef.current !== generationRef.current) break;
                    setLoading(false);
                    if (payload.ok) {
                        setStatus({
                            branch: (payload.branch as string) ?? "",
                            changes: (payload.changes as GitChange[]) ?? [],
                            ahead: (payload.ahead as number) ?? 0,
                            behind: (payload.behind as number) ?? 0,
                            hasUpstream: (payload.hasUpstream as boolean) ?? false,
                            diffStaged: (payload.diffStaged as string) ?? "",
                        });
                        setError(null);
                    } else {
                        setError((payload.message as string) ?? "Failed to get git status");
                    }
                    break;
                }
                case "git_full_status_result": {
                    statusRequestsInFlightRef.current = Math.max(0, statusRequestsInFlightRef.current - 1);
                    // Ignore stale responses from a previous cwd
                    if (statusGenRef.current !== generationRef.current) break;
                    if (requestId && pendingFullStatusRequestRef.current === requestId) {
                        pendingFullStatusRequestRef.current = null;
                        if (fullStatusFallbackTimerRef.current) {
                            clearTimeout(fullStatusFallbackTimerRef.current);
                            fullStatusFallbackTimerRef.current = null;
                        }
                    }

                    setLoading(false);
                    if (payload.ok) {
                        const statusPayload = (payload.status as Record<string, unknown> | undefined) ?? payload;
                        setStatus({
                            branch: (statusPayload.branch as string) ?? "",
                            changes: (statusPayload.changes as GitChange[]) ?? [],
                            ahead: (statusPayload.ahead as number) ?? 0,
                            behind: (statusPayload.behind as number) ?? 0,
                            hasUpstream: (statusPayload.hasUpstream as boolean) ?? false,
                            diffStaged: (statusPayload.diffStaged as string) ?? "",
                        });
                        setBranches((payload.branches as GitBranch[]) ?? []);
                        setCurrentBranch((payload.currentBranch as string) ?? "");
                        setWorktrees((payload.worktrees as GitWorktree[]) ?? []);
                        setError(null);
                    } else {
                        setError((payload.message as string) ?? "Failed to get git status");
                    }
                    break;
                }
                case "git_diff_result": {
                    if (requestId && pendingDiffsRef.current.has(requestId)) {
                        const resolve = pendingDiffsRef.current.get(requestId)!;
                        pendingDiffsRef.current.delete(requestId);
                        resolve(
                            payload.ok
                                ? ((payload.diff as string) ?? "(no diff)")
                                : ((payload.message as string) ?? "(failed to load diff)"),
                        );
                    }
                    break;
                }
                case "git_branches_result": {
                    if (payload.ok) {
                        setBranches((payload.branches as GitBranch[]) ?? []);
                        setCurrentBranch((payload.currentBranch as string) ?? "");
                    }
                    break;
                }
                case "git_worktrees_result": {
                    if (payload.ok) {
                        setWorktrees((payload.worktrees as GitWorktree[]) ?? []);
                    }
                    break;
                }
                case "git_checkout_result":
                case "git_commit_result":
                case "git_push_result":
                case "git_pull_result": {
                    setOperationInProgress(null);
                    setLastOperationResult(payload as GitOperationResult);
                    // Auto-refresh status after successful mutating operations.
                    // Debounced/coalesced to avoid hammering git status during rapid updates.
                    if (payload.ok) {
                        postMutationRefreshSchedulerRef.current.schedule();
                    }
                    break;
                }
                case "git_stage_result":
                case "git_unstage_result": {
                    setOperationInProgress(null);
                    setLastOperationResult(payload as GitOperationResult);

                    const rollbackStatus = consumeRollbackSnapshot(
                        optimisticSnapshotsRef.current,
                        requestId,
                        payload.ok === true,
                    );
                    if (payload.ok !== true && rollbackStatus !== undefined) {
                        setStatus(rollbackStatus);
                    }

                    if (payload.ok) {
                        postMutationRefreshSchedulerRef.current.schedule();
                    }
                    break;
                }
            }
        },
    });

    // Keep send ref current
    sendRef.current = send;

    // Clean up pending diffs on unmount
    useEffect(() => {
        return () => {
            pendingDiffsRef.current.clear();
            optimisticSnapshotsRef.current.clear();
            postMutationRefreshSchedulerRef.current.dispose();
            if (fullStatusFallbackTimerRef.current) {
                clearTimeout(fullStatusFallbackTimerRef.current);
                fullStatusFallbackTimerRef.current = null;
            }
        };
    }, []);

    // ── Actions ─────────────────────────────────────────────────────────

    const fetchStatus = useCallback(() => {
        if (!available) return;
        sendStatusRequest(cwd);
    }, [available, sendStatusRequest, cwd]);

    const fetchDiff = useCallback((path: string, staged = false): Promise<string> => {
        return new Promise((resolve) => {
            if (!available) {
                resolve("(git service unavailable)");
                return;
            }
            const reqId = makeRequestId();
            pendingDiffsRef.current.set(reqId, resolve);
            send("git_diff", { cwd, path, staged }, reqId);

            // Timeout after 15s
            setTimeout(() => {
                if (pendingDiffsRef.current.has(reqId)) {
                    pendingDiffsRef.current.delete(reqId);
                    resolve("(diff request timed out)");
                }
            }, 15000);
        });
    }, [available, send, cwd, makeRequestId]);

    const fetchBranches = useCallback(() => {
        if (!available) return;
        send("git_branches", { cwd }, makeRequestId());
    }, [available, send, cwd, makeRequestId]);

    const fetchWorktrees = useCallback(() => {
        if (!available) return;
        send("git_worktrees", { cwd }, makeRequestId());
    }, [available, send, cwd, makeRequestId]);

    const checkout = useCallback((branch: string, isRemote = false) => {
        if (!available) return;
        setOperationInProgress("checkout");
        setLastOperationResult(null);
        send("git_checkout", { cwd, branch, isRemote }, makeRequestId());
    }, [available, send, cwd, makeRequestId]);

    const stage = useCallback((paths: string[]) => {
        if (!available) return;
        const requestId = makeRequestId();
        setOperationInProgress("stage");
        setLastOperationResult(null);
        setStatus((prev: GitStatus | null) => {
            optimisticSnapshotsRef.current.set(requestId, cloneStatusSnapshot(prev));
            return applyOptimisticMutation(prev, { type: "stage", paths });
        });
        send("git_stage", { cwd, paths }, requestId);
    }, [available, send, cwd, makeRequestId]);

    const stageAll = useCallback(() => {
        if (!available) return;
        const requestId = makeRequestId();
        setOperationInProgress("stage");
        setLastOperationResult(null);
        setStatus((prev: GitStatus | null) => {
            optimisticSnapshotsRef.current.set(requestId, cloneStatusSnapshot(prev));
            return applyOptimisticMutation(prev, { type: "stage", all: true });
        });
        send("git_stage", { cwd, all: true }, requestId);
    }, [available, send, cwd, makeRequestId]);

    const unstage = useCallback((paths: string[]) => {
        if (!available) return;
        const requestId = makeRequestId();
        setOperationInProgress("unstage");
        setLastOperationResult(null);
        setStatus((prev: GitStatus | null) => {
            optimisticSnapshotsRef.current.set(requestId, cloneStatusSnapshot(prev));
            return applyOptimisticMutation(prev, { type: "unstage", paths });
        });
        send("git_unstage", { cwd, paths }, requestId);
    }, [available, send, cwd, makeRequestId]);

    const unstageAll = useCallback(() => {
        if (!available) return;
        const requestId = makeRequestId();
        setOperationInProgress("unstage");
        setLastOperationResult(null);
        setStatus((prev: GitStatus | null) => {
            optimisticSnapshotsRef.current.set(requestId, cloneStatusSnapshot(prev));
            return applyOptimisticMutation(prev, { type: "unstage", all: true });
        });
        send("git_unstage", { cwd, all: true }, requestId);
    }, [available, send, cwd, makeRequestId]);

    const commit = useCallback((message: string) => {
        if (!available) return;
        setOperationInProgress("commit");
        setLastOperationResult(null);
        send("git_commit", { cwd, message }, makeRequestId());
    }, [available, send, cwd, makeRequestId]);

    const push = useCallback((setUpstream = false) => {
        if (!available) return;
        setOperationInProgress("push");
        setLastOperationResult(null);
        send("git_push", { cwd, setUpstream }, makeRequestId());
    }, [available, send, cwd, makeRequestId]);

    const pull = useCallback(() => {
        if (!available) return;
        setOperationInProgress("pull");
        setLastOperationResult(null);
        send("git_pull", { cwd }, makeRequestId());
    }, [available, send, cwd, makeRequestId]);

    const clearOperationResult = useCallback(() => {
        setLastOperationResult(null);
    }, []);

    // Clear stale state and re-fetch when cwd changes or service becomes available.
    // Bump generation so in-flight responses from the old cwd are discarded.
    useEffect(() => {
        generationRef.current++;
        // Clear state immediately so old data doesn't flash
        setStatus(null);
        setBranches([]);
        setWorktrees([]);
        setCurrentBranch("");
        setError(null);
        setOperationInProgress(null);
        setLastOperationResult(null);
        pendingDiffsRef.current.clear();
        pendingFullStatusRequestRef.current = null;
        optimisticSnapshotsRef.current.clear();
        postMutationRefreshSchedulerRef.current.cancel();
        statusRequestsInFlightRef.current = 0;
        if (fullStatusFallbackTimerRef.current) {
            clearTimeout(fullStatusFallbackTimerRef.current);
            fullStatusFallbackTimerRef.current = null;
        }

        if (available && cwd) {
            statusGenRef.current = generationRef.current;
            statusRequestsInFlightRef.current += 1;
            setLoading(true);

            // Initial load optimization: request status + branches + worktrees in one round-trip.
            // Compatibility fallback: if an older runner doesn't support git_full_status,
            // fall back to git_status after a short delay.
            const requestId = makeRequestId();
            pendingFullStatusRequestRef.current = requestId;
            send("git_full_status", { cwd }, requestId);

            fullStatusFallbackTimerRef.current = setTimeout(() => {
                fullStatusFallbackTimerRef.current = null;
                if (statusGenRef.current !== generationRef.current) return;
                if (!pendingFullStatusRequestRef.current) return;
                pendingFullStatusRequestRef.current = null;
                sendStatusRequest(cwdRef.current);
            }, 1200);
        } else {
            setLoading(false);
        }
    }, [available, cwd]); // eslint-disable-line react-hooks/exhaustive-deps

    return {
        available,
        status,
        branches,
        worktrees,
        currentBranch,
        loading,
        error,
        operationInProgress,
        lastOperationResult,
        fetchStatus,
        fetchDiff,
        fetchBranches,
        fetchWorktrees,
        checkout,
        stage,
        stageAll,
        unstage,
        unstageAll,
        commit,
        push,
        pull,
        clearOperationResult,
    };
}
