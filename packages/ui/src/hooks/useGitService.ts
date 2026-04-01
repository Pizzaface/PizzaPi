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
    const pendingDiffTimeoutsRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());
    const pendingFullStatusRequestRef = useRef<string | null>(null);
    const fullStatusFallbackTimersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());
    const statusRequestRetireTimersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());
    const statusRequestsInFlightRef = useRef(new Set<string>());
    const optimisticSnapshotsRef = useRef(new Map<string, GitStatus | null>());
    const requestGenerationRef = useRef(new Map<string, number>());

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

    const markStatusRequestInFlight = useCallback((requestId: string) => {
        statusRequestsInFlightRef.current.add(requestId);
    }, []);

    const markStatusRequestSettled = useCallback((requestId?: string) => {
        if (!requestId) return;
        statusRequestsInFlightRef.current.delete(requestId);
    }, []);

    const registerRequestGeneration = useCallback((requestId: string) => {
        requestGenerationRef.current.set(requestId, generationRef.current);
    }, []);

    const consumeRequestGeneration = useCallback((requestId?: string): number | null => {
        if (!requestId) return null;
        const generation = requestGenerationRef.current.get(requestId) ?? null;
        requestGenerationRef.current.delete(requestId);
        return generation;
    }, []);

    const isRequestCurrentGeneration = useCallback((requestId?: string): boolean => {
        const requestGeneration = consumeRequestGeneration(requestId);
        if (requestGeneration === null) return false;
        return requestGeneration === generationRef.current;
    }, [consumeRequestGeneration]);

    const sendStatusRequest = useCallback((targetCwd: string) => {
        statusGenRef.current = generationRef.current;
        const requestId = makeRequestId();
        registerRequestGeneration(requestId);
        markStatusRequestInFlight(requestId);
        setLoading(true);
        setError(null);
        sendRef.current("git_status", { cwd: targetCwd }, requestId);

        const retireTimer = setTimeout(() => {
            statusRequestRetireTimersRef.current.delete(requestId);
            requestGenerationRef.current.delete(requestId);
            markStatusRequestSettled(requestId);
        }, 8000);
        statusRequestRetireTimersRef.current.set(requestId, retireTimer);
    }, [makeRequestId, markStatusRequestInFlight, markStatusRequestSettled, registerRequestGeneration]);

    const sendLegacySnapshotRequests = useCallback((targetCwd: string) => {
        sendStatusRequest(targetCwd);

        const branchesReqId = makeRequestId();
        registerRequestGeneration(branchesReqId);
        sendRef.current("git_branches", { cwd: targetCwd }, branchesReqId);

        const worktreesReqId = makeRequestId();
        registerRequestGeneration(worktreesReqId);
        sendRef.current("git_worktrees", { cwd: targetCwd }, worktreesReqId);
    }, [makeRequestId, registerRequestGeneration, sendStatusRequest]);

    const sendFullStatusRequest = useCallback((targetCwd: string, options?: { asInitial?: boolean; fallbackToStatus?: boolean; fallbackMs?: number }) => {
        const asInitial = options?.asInitial === true;
        const fallbackToStatus = options?.fallbackToStatus === true;
        const fallbackMs = options?.fallbackMs ?? 1200;

        statusGenRef.current = generationRef.current;
        const requestId = makeRequestId();
        registerRequestGeneration(requestId);
        markStatusRequestInFlight(requestId);
        if (asInitial) {
            pendingFullStatusRequestRef.current = requestId;
        }
        setLoading(true);
        setError(null);
        sendRef.current("git_full_status", { cwd: targetCwd }, requestId);

        if (fallbackToStatus) {
            const timerId = setTimeout(() => {
                fullStatusFallbackTimersRef.current.delete(requestId);
                if (statusGenRef.current !== generationRef.current) return;
                if (asInitial && pendingFullStatusRequestRef.current !== requestId) return;
                if (asInitial) pendingFullStatusRequestRef.current = null;
                // Retire this full-status request so late responses are ignored.
                requestGenerationRef.current.delete(requestId);
                markStatusRequestSettled(requestId);
                sendLegacySnapshotRequests(cwdRef.current);
            }, fallbackMs);
            fullStatusFallbackTimersRef.current.set(requestId, timerId);
        }

        return requestId;
    }, [makeRequestId, markStatusRequestInFlight, markStatusRequestSettled, registerRequestGeneration, sendLegacySnapshotRequests]);
    const clearPendingDiffs = useCallback((resolution: string) => {
        for (const timeoutId of pendingDiffTimeoutsRef.current.values()) {
            clearTimeout(timeoutId);
        }
        pendingDiffTimeoutsRef.current.clear();

        for (const [requestId, resolveDiff] of pendingDiffsRef.current.entries()) {
            requestGenerationRef.current.delete(requestId);
            resolveDiff(resolution);
        }
        pendingDiffsRef.current.clear();
    }, []);

    const postMutationRefreshSchedulerRef = useRef(
        createPostMutationRefreshScheduler({
            debounceMs: POST_MUTATION_STATUS_REFRESH_DEBOUNCE_MS,
            getGeneration: () => generationRef.current,
            isStatusRequestInFlight: () => statusRequestsInFlightRef.current.size > 0,
            triggerRefresh: () => {
                sendFullStatusRequest(cwdRef.current, { asInitial: false, fallbackToStatus: true, fallbackMs: 1200 });
            },
        })
    );

    const { send, available } = useServiceChannel<unknown, unknown>("git", {
        onMessage: (type, rawPayload, requestId) => {
            const payload = rawPayload as Record<string, unknown>;

            switch (type) {
                case "git_status_result": {
                    if (requestId) {
                        const timerId = statusRequestRetireTimersRef.current.get(requestId);
                        if (timerId) {
                            clearTimeout(timerId);
                            statusRequestRetireTimersRef.current.delete(requestId);
                        }
                        if (!isRequestCurrentGeneration(requestId)) break;
                        markStatusRequestSettled(requestId);
                    } else {
                        // Proactive push with no requestId: accept only for current cwd.
                        const payloadCwd = typeof payload.cwd === "string" ? payload.cwd : null;
                        if (!payloadCwd || payloadCwd !== cwdRef.current) break;
                    }
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
                    if (!isRequestCurrentGeneration(requestId)) break;
                    markStatusRequestSettled(requestId);
                    if (requestId) {
                        const timerId = fullStatusFallbackTimersRef.current.get(requestId);
                        if (timerId) {
                            clearTimeout(timerId);
                            fullStatusFallbackTimersRef.current.delete(requestId);
                        }
                    }
                    // Ignore stale responses from a previous cwd
                    if (statusGenRef.current !== generationRef.current) break;

                    const isInitialFullStatus = !!requestId && pendingFullStatusRequestRef.current === requestId;
                    if (isInitialFullStatus) {
                        pendingFullStatusRequestRef.current = null;
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
                        sendLegacySnapshotRequests(cwdRef.current);
                    }
                    break;
                }
                case "git_diff_result": {
                    if (requestId && pendingDiffsRef.current.has(requestId)) {
                        const timeoutId = pendingDiffTimeoutsRef.current.get(requestId);
                        if (timeoutId) {
                            clearTimeout(timeoutId);
                            pendingDiffTimeoutsRef.current.delete(requestId);
                        }
                        requestGenerationRef.current.delete(requestId);
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
                    if (!isRequestCurrentGeneration(requestId)) break;
                    if (payload.ok) {
                        setBranches((payload.branches as GitBranch[]) ?? []);
                        setCurrentBranch((payload.currentBranch as string) ?? "");
                    }
                    break;
                }
                case "git_worktrees_result": {
                    if (!isRequestCurrentGeneration(requestId)) break;
                    if (payload.ok) {
                        setWorktrees((payload.worktrees as GitWorktree[]) ?? []);
                    }
                    break;
                }
                case "git_checkout_result":
                case "git_commit_result":
                case "git_push_result":
                case "git_pull_result": {
                    if (!isRequestCurrentGeneration(requestId)) break;
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
                    if (!isRequestCurrentGeneration(requestId)) break;
                    setOperationInProgress(null);
                    setLastOperationResult(payload as GitOperationResult);

                    consumeRollbackSnapshot(
                        optimisticSnapshotsRef.current,
                        requestId,
                        payload.ok === true,
                    );

                    if (payload.ok) {
                        postMutationRefreshSchedulerRef.current.schedule();
                    } else {
                        // Avoid stale rollback races across overlapping optimistic mutations.
                        // Re-sync from authoritative runner state instead.
                        sendStatusRequest(cwdRef.current);
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
            clearPendingDiffs("(diff request cancelled)");
            optimisticSnapshotsRef.current.clear();
            statusRequestsInFlightRef.current.clear();
            requestGenerationRef.current.clear();
            postMutationRefreshSchedulerRef.current.dispose();
            for (const timerId of fullStatusFallbackTimersRef.current.values()) {
                clearTimeout(timerId);
            }
            fullStatusFallbackTimersRef.current.clear();
            for (const timerId of statusRequestRetireTimersRef.current.values()) {
                clearTimeout(timerId);
            }
            statusRequestRetireTimersRef.current.clear();
        };
    }, [clearPendingDiffs]);

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
            registerRequestGeneration(reqId);
            pendingDiffsRef.current.set(reqId, resolve);
            send("git_diff", { cwd, path, staged }, reqId);

            // Timeout after 15s
            const timeoutId = setTimeout(() => {
                pendingDiffTimeoutsRef.current.delete(reqId);
                requestGenerationRef.current.delete(reqId);
                if (pendingDiffsRef.current.has(reqId)) {
                    pendingDiffsRef.current.delete(reqId);
                    resolve("(diff request timed out)");
                }
            }, 15000);
            pendingDiffTimeoutsRef.current.set(reqId, timeoutId);
        });
    }, [available, send, cwd, makeRequestId, registerRequestGeneration]);

    const fetchBranches = useCallback(() => {
        if (!available) return;
        const requestId = makeRequestId();
        registerRequestGeneration(requestId);
        send("git_branches", { cwd }, requestId);
    }, [available, send, cwd, makeRequestId, registerRequestGeneration]);

    const fetchWorktrees = useCallback(() => {
        if (!available) return;
        const requestId = makeRequestId();
        registerRequestGeneration(requestId);
        send("git_worktrees", { cwd }, requestId);
    }, [available, send, cwd, makeRequestId, registerRequestGeneration]);

    const checkout = useCallback((branch: string, isRemote = false) => {
        if (!available) return;
        const requestId = makeRequestId();
        registerRequestGeneration(requestId);
        setOperationInProgress("checkout");
        setLastOperationResult(null);
        send("git_checkout", { cwd, branch, isRemote }, requestId);
    }, [available, send, cwd, makeRequestId, registerRequestGeneration]);

    const stage = useCallback((paths: string[]) => {
        if (!available) return;
        const requestId = makeRequestId();
        registerRequestGeneration(requestId);
        setOperationInProgress("stage");
        setLastOperationResult(null);
        setStatus((prev: GitStatus | null) => {
            optimisticSnapshotsRef.current.set(requestId, cloneStatusSnapshot(prev));
            return applyOptimisticMutation(prev, { type: "stage", paths });
        });
        send("git_stage", { cwd, paths }, requestId);
    }, [available, send, cwd, makeRequestId, registerRequestGeneration]);

    const stageAll = useCallback(() => {
        if (!available) return;
        const requestId = makeRequestId();
        registerRequestGeneration(requestId);
        setOperationInProgress("stage");
        setLastOperationResult(null);
        setStatus((prev: GitStatus | null) => {
            optimisticSnapshotsRef.current.set(requestId, cloneStatusSnapshot(prev));
            return applyOptimisticMutation(prev, { type: "stage", all: true });
        });
        send("git_stage", { cwd, all: true }, requestId);
    }, [available, send, cwd, makeRequestId, registerRequestGeneration]);

    const unstage = useCallback((paths: string[]) => {
        if (!available) return;
        const requestId = makeRequestId();
        registerRequestGeneration(requestId);
        setOperationInProgress("unstage");
        setLastOperationResult(null);
        setStatus((prev: GitStatus | null) => {
            optimisticSnapshotsRef.current.set(requestId, cloneStatusSnapshot(prev));
            return applyOptimisticMutation(prev, { type: "unstage", paths });
        });
        send("git_unstage", { cwd, paths }, requestId);
    }, [available, send, cwd, makeRequestId, registerRequestGeneration]);

    const unstageAll = useCallback(() => {
        if (!available) return;
        const requestId = makeRequestId();
        registerRequestGeneration(requestId);
        setOperationInProgress("unstage");
        setLastOperationResult(null);
        setStatus((prev: GitStatus | null) => {
            optimisticSnapshotsRef.current.set(requestId, cloneStatusSnapshot(prev));
            return applyOptimisticMutation(prev, { type: "unstage", all: true });
        });
        send("git_unstage", { cwd, all: true }, requestId);
    }, [available, send, cwd, makeRequestId, registerRequestGeneration]);

    const commit = useCallback((message: string) => {
        if (!available) return;
        const requestId = makeRequestId();
        registerRequestGeneration(requestId);
        setOperationInProgress("commit");
        setLastOperationResult(null);
        send("git_commit", { cwd, message }, requestId);
    }, [available, send, cwd, makeRequestId, registerRequestGeneration]);

    const push = useCallback((setUpstream = false) => {
        if (!available) return;
        const requestId = makeRequestId();
        registerRequestGeneration(requestId);
        setOperationInProgress("push");
        setLastOperationResult(null);
        send("git_push", { cwd, setUpstream }, requestId);
    }, [available, send, cwd, makeRequestId, registerRequestGeneration]);

    const pull = useCallback(() => {
        if (!available) return;
        const requestId = makeRequestId();
        registerRequestGeneration(requestId);
        setOperationInProgress("pull");
        setLastOperationResult(null);
        send("git_pull", { cwd }, requestId);
    }, [available, send, cwd, makeRequestId, registerRequestGeneration]);

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
        clearPendingDiffs("(diff request cancelled)");
        requestGenerationRef.current.clear();
        pendingFullStatusRequestRef.current = null;
        optimisticSnapshotsRef.current.clear();
        postMutationRefreshSchedulerRef.current.cancel();
        statusRequestsInFlightRef.current.clear();
        for (const timerId of fullStatusFallbackTimersRef.current.values()) {
            clearTimeout(timerId);
        }
        fullStatusFallbackTimersRef.current.clear();
        for (const timerId of statusRequestRetireTimersRef.current.values()) {
            clearTimeout(timerId);
        }
        statusRequestRetireTimersRef.current.clear();

        if (available && cwd) {
            statusGenRef.current = generationRef.current;
            setLoading(true);

            // Initial load optimization: request status + branches + worktrees in one round-trip.
            // Compatibility fallback: if an older runner doesn't support git_full_status,
            // fall back to git_status after a short delay.
            sendFullStatusRequest(cwd, { asInitial: true, fallbackToStatus: true, fallbackMs: 1200 });
        } else {
            setLoading(false);
        }
    }, [available, clearPendingDiffs, cwd, markStatusRequestSettled, sendFullStatusRequest, sendStatusRequest]);

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
