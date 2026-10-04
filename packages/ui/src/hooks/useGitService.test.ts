/**
 * Tests for useGitService — stash, history, diff-two-revs, and blame actions.
 *
 * Mocks the underlying service channel so we can verify outgoing messages and
 * simulate incoming result messages without a real runner or socket.
 */
import { describe, expect, test, mock, afterAll, afterEach, beforeEach } from "bun:test";
import { Window } from "happy-dom";
import { renderHook, act, cleanup, waitFor } from "@testing-library/react";
import type { GitBlameLine, GitLogEntry } from "./useGitService";

// ── DOM globals ─────────────────────────────────────────────────────────────
// Must be set BEFORE React or hook imports so module evaluation sees a browser
// environment.
const win = new Window({ url: "http://localhost/" });
/* eslint-disable @typescript-eslint/no-explicit-any */
(globalThis as any).window = win;
(globalThis as any).document = win.document;
(globalThis as any).navigator = win.navigator;
(globalThis as any).HTMLElement = win.HTMLElement;
(globalThis as any).Element = win.Element;
(globalThis as any).Node = win.Node;
(globalThis as any).SVGElement = win.SVGElement;
(globalThis as any).MutationObserver = win.MutationObserver;
(globalThis as any).getComputedStyle = win.getComputedStyle.bind(win);
(globalThis as any).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
};
/* eslint-enable @typescript-eslint/no-explicit-any */

// ── Mock service channel ──────────────────────────────────────────────────
const sendSpy = mock((_type: string, _payload: unknown, _requestId?: string) => {});

let capturedOnMessage:
    | ((type: string, payload: unknown, requestId?: string) => void)
    | undefined;
let channelAvailable = true;

type SocketHandler = (...args: unknown[]) => void;

function createFakeSocket(connected = true) {
    const handlers = new Map<string, Set<SocketHandler>>();
    return {
        connected,
        on(event: string, handler: SocketHandler) {
            const set = handlers.get(event) ?? new Set<SocketHandler>();
            set.add(handler);
            handlers.set(event, set);
        },
        off(event: string, handler: SocketHandler) {
            handlers.get(event)?.delete(handler);
        },
        emit: mock((_event: string, _payload?: unknown, ack?: (ok: boolean) => void) => {
            ack?.(true);
        }),
        trigger(event: string, ...args: unknown[]) {
            for (const handler of handlers.get(event) ?? []) handler(...args);
        },
    };
}

let fakeSocket = createFakeSocket(true);
let visibilityState = "visible";
Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => visibilityState,
});

const channelFactory = () => ({
    useServiceChannel: (
        _serviceId: string,
        opts: { onMessage?: (type: string, payload: unknown, requestId?: string) => void } = {}
    ) => {
        capturedOnMessage = opts.onMessage;
        return { send: sendSpy, available: channelAvailable };
    },
    getEagerServiceAvailability: () => channelAvailable,
});

mock.module("@/hooks/useServiceChannel", channelFactory);
// Also mock the relative-path import used inside useGitService.ts itself.
mock.module("./useServiceChannel", channelFactory);
mock.module("@/lib/viewer-socket-context", () => ({
    useViewerSocket: () => fakeSocket,
}));

afterAll(() => mock.restore());

// Import AFTER mock is registered
const { useGitService } = await import("./useGitService");

// ── Helpers ─────────────────────────────────────────────────────────────────
function renderGitHook(cwd = "/repo") {
    return renderHook(({ cwd }) => useGitService(cwd), {
        initialProps: { cwd },
    });
}

function lastSendCall(): { type: string; payload: Record<string, unknown>; requestId?: string } {
    const call = sendSpy.mock.calls.at(-1);
    if (!call) throw new Error("no send calls");
    return { type: call[0] as string, payload: call[1] as Record<string, unknown>, requestId: call[2] as string | undefined };
}

function findSendCall(type: string): { type: string; payload: Record<string, unknown>; requestId?: string } | undefined {
    const call = sendSpy.mock.calls.find(([t]) => t === type);
    if (!call) return undefined;
    return { type: call[0] as string, payload: call[1] as Record<string, unknown>, requestId: call[2] as string | undefined };
}

function sendCalls(type: string): Array<{ type: string; payload: Record<string, unknown>; requestId?: string }> {
    return sendSpy.mock.calls
        .filter(([t]) => t === type)
        .map((call) => ({ type: call[0] as string, payload: call[1] as Record<string, unknown>, requestId: call[2] as string | undefined }));
}

function lastSendCallOfType(type: string): { type: string; payload: Record<string, unknown>; requestId?: string } | undefined {
    return sendCalls(type).at(-1);
}

function emitMessage(type: string, payload: unknown, requestId?: string) {
    act(() => {
        capturedOnMessage?.(type, payload, requestId);
    });
}

function settleStatus(requestId?: string, branch = "main") {
    emitMessage("git_full_status_result", { ok: true, status: { branch, changes: [] }, branches: [], currentBranch: branch, worktrees: [] }, requestId);
}

function settleLightStatus(requestId?: string, branch = "main") {
    emitMessage("git_status_result", { ok: true, cwd: "/repo", branch, changes: [] }, requestId);
}

const sampleLogEntries: GitLogEntry[] = [
    {
        hash: "abc1234567890abcdef1234567890abcdef123456",
        shortHash: "abc1234",
        author: "Ada Lovelace",
        authorDate: "2026-06-25T10:00:00Z",
        commitDate: "2026-06-25T10:00:00Z",
        subject: "Initial commit",
        body: "",
        refs: ["HEAD", "main"],
    },
    {
        hash: "def4567890abcdef1234567890abcdef123456789",
        shortHash: "def4567",
        author: "Grace Hopper",
        authorDate: "2026-06-25T11:00:00Z",
        commitDate: "2026-06-25T11:00:00Z",
        subject: "Add parser",
        body: "Also fixed a bug.",
        refs: [],
    },
];

const sampleBlameLines: GitBlameLine[] = [
    { hash: "abc1234", author: "Ada", authorDate: "2026-06-25T10:00:00Z", summary: "Initial commit", finalLine: 1, sourceLine: 1 },
    { hash: "abc1234", author: "Ada", authorDate: "2026-06-25T10:00:00Z", summary: "Initial commit", finalLine: 2, sourceLine: 2 },
    { hash: "def4567", author: "Grace", authorDate: "2026-06-25T11:00:00Z", summary: "Add parser", finalLine: 3, sourceLine: 1 },
];

// ── Tests ───────────────────────────────────────────────────────────────────
beforeEach(() => {
    channelAvailable = true;
    fakeSocket = createFakeSocket(true);
    visibilityState = "visible";
});

afterEach(() => {
    cleanup();
    sendSpy.mockClear();
    capturedOnMessage = undefined;
});

describe("fetchLog", () => {
    test("sends git_log with all options and resolves with entries", async () => {
        const { result } = renderGitHook();

        let promise: Promise<GitLogEntry[]> | undefined;
        act(() => {
            promise = result.current.fetchLog("src/foo.ts", 25, "main..HEAD");
        });

        const { type, payload, requestId } = lastSendCall();
        expect(type).toBe("git_log");
        expect(payload).toEqual({ cwd: "/repo", path: "src/foo.ts", limit: 25, revisionRange: "main..HEAD" });
        expect(requestId).toBeDefined();

        emitMessage("git_log_result", { ok: true, entries: sampleLogEntries }, requestId);

        await expect(promise!).resolves.toEqual(sampleLogEntries);
        expect(result.current.log).toEqual(sampleLogEntries);
    });

    test("rejects and does not update log state on error", async () => {
        const { result } = renderGitHook();

        let promise: Promise<GitLogEntry[]> | undefined;
        act(() => {
            promise = result.current.fetchLog();
        });

        const { requestId } = lastSendCall();
        emitMessage("git_log_result", { ok: false, message: "bad rev" }, requestId);

        await expect(promise!).rejects.toThrow("bad rev");
        expect(result.current.log).toEqual([]);
    });

    test("rejects when service unavailable", async () => {
        channelAvailable = false;
        const { result } = renderGitHook();

        let promise: Promise<GitLogEntry[]> | undefined;
        act(() => {
            promise = result.current.fetchLog();
        });

        await expect(promise!).rejects.toThrow("git service unavailable");
        expect(sendSpy).not.toHaveBeenCalled();
    });

    test("rejects on timeout", async () => {
        const realSetTimeout = globalThis.setTimeout;
        const realClearTimeout = globalThis.clearTimeout;
        let logTimeout: (() => void) | undefined;
        globalThis.setTimeout = ((callback: TimerHandler, delay?: number) => {
            if (delay === 15000) logTimeout = callback as () => void;
            return 234 as unknown as ReturnType<typeof setTimeout>;
        }) as typeof setTimeout;
        globalThis.clearTimeout = mock((_id: ReturnType<typeof setTimeout>) => {}) as typeof clearTimeout;

        try {
            const { result } = renderGitHook();
            let promise: Promise<GitLogEntry[]> | undefined;
            act(() => {
                promise = result.current.fetchLog();
            });

            expect(logTimeout).toBeDefined();
            act(() => logTimeout?.());
            await expect(promise!).rejects.toThrow("git log request timed out");
        } finally {
            globalThis.setTimeout = realSetTimeout;
            globalThis.clearTimeout = realClearTimeout;
        }
    });

    test("rejects on disconnect cancellation", async () => {
        const { result } = renderGitHook();
        let promise: Promise<GitLogEntry[]> | undefined;
        act(() => {
            promise = result.current.fetchLog();
        });

        act(() => {
            fakeSocket.connected = false;
            fakeSocket.trigger("disconnect");
        });

        await expect(promise!).rejects.toThrow("request cancelled");
    });
});

describe("fetchDiffRevs", () => {
    test("sends git_diff_revs and resolves with diff text", async () => {
        const { result } = renderGitHook();

        let promise: Promise<string> | undefined;
        act(() => {
            promise = result.current.fetchDiffRevs("main", "feature", "src/foo.ts");
        });

        const { type, payload, requestId } = lastSendCall();
        expect(type).toBe("git_diff_revs");
        expect(payload).toEqual({ cwd: "/repo", base: "main", head: "feature", path: "src/foo.ts" });
        expect(requestId).toBeDefined();

        emitMessage("git_diff_revs_result", { ok: true, diff: "+added line" }, requestId);

        await expect(promise!).resolves.toBe("+added line");
    });

    test("resolves error message on failure", async () => {
        const { result } = renderGitHook();

        let promise: Promise<string> | undefined;
        act(() => {
            promise = result.current.fetchDiffRevs("a", "b");
        });

        const { requestId } = lastSendCall();
        emitMessage("git_diff_revs_result", { ok: false, message: "bad revision" }, requestId);

        await expect(promise!).resolves.toBe("bad revision");
    });
});

describe("fetchBlame", () => {
    test("sends git_blame and resolves with blame lines", async () => {
        const { result } = renderGitHook();

        let promise: Promise<GitBlameLine[]> | undefined;
        act(() => {
            promise = result.current.fetchBlame("src/foo.ts", "HEAD~1");
        });

        const { type, payload, requestId } = lastSendCall();
        expect(type).toBe("git_blame");
        expect(payload).toEqual({ cwd: "/repo", path: "src/foo.ts", revision: "HEAD~1" });
        expect(requestId).toBeDefined();

        const content = ["line1", "line2", "line3"];
        emitMessage("git_blame_result", { ok: true, lines: sampleBlameLines, content }, requestId);

        await expect(promise!).resolves.toEqual(sampleBlameLines);
        expect(result.current.blame).toEqual({ lines: sampleBlameLines, content });
    });

    test("resolves empty array and clears blame state on error", async () => {
        const { result } = renderGitHook();

        let promise: Promise<GitBlameLine[]> | undefined;
        act(() => {
            promise = result.current.fetchBlame("src/foo.ts");
        });

        const { requestId } = lastSendCall();
        emitMessage("git_blame_result", { ok: false, message: "not a blob" }, requestId);

        await expect(promise!).resolves.toEqual([]);
        expect(result.current.blame).toEqual({ lines: [], content: [] });
    });
});

describe("fetchCommitFiles", () => {
    test("sends git_commit_files and resolves with files", async () => {
        const { result } = renderGitHook();

        let promise: Promise<Array<{ status: string; path: string }>> | undefined;
        act(() => {
            promise = result.current.fetchCommitFiles("HEAD", "main");
        });

        const { type, payload, requestId } = lastSendCall();
        expect(type).toBe("git_commit_files");
        expect(payload).toEqual({ cwd: "/repo", revision: "HEAD", base: "main" });

        emitMessage("git_commit_files_result", { ok: true, files: [{ status: "M", path: "src/a.ts" }] }, requestId);
        await expect(promise!).resolves.toEqual([{ status: "M", path: "src/a.ts" }]);
    });

    test("rejects on failure instead of masking it as an empty commit", async () => {
        const { result } = renderGitHook();

        let promise: Promise<Array<{ status: string; path: string }>> | undefined;
        act(() => {
            promise = result.current.fetchCommitFiles("bad");
        });

        emitMessage("git_commit_files_result", { ok: false, message: "bad revision" }, lastSendCall().requestId);
        await expect(promise!).rejects.toThrow("bad revision");
    });

    test("rejects when service unavailable", async () => {
        channelAvailable = false;
        const { result } = renderGitHook();

        let promise: Promise<Array<{ status: string; path: string }>> | undefined;
        act(() => {
            promise = result.current.fetchCommitFiles("HEAD");
        });

        await expect(promise!).rejects.toThrow("git service unavailable");
        expect(sendSpy).not.toHaveBeenCalled();
    });
});

describe("stash actions", () => {
    test("stashList sends git_stash_list and updates stashes on result", () => {
        const { result } = renderGitHook();

        act(() => {
            result.current.stashList();
        });

        const { type, requestId } = lastSendCall();
        expect(type).toBe("git_stash_list");
        expect(requestId).toBeDefined();

        const stashes = [{ index: 0, ref: "stash@{0}", message: "WIP", shortHash: "abc1234", date: "2 hours ago" }];
        emitMessage("git_stash_list_result", { ok: true, stashes }, requestId);

        expect(result.current.stashes).toEqual(stashes);
    });

    test("stashPush sends git_stash_push with options", () => {
        const { result } = renderGitHook();

        act(() => {
            result.current.stashPush("save my work", true);
        });

        const { type, payload } = lastSendCall();
        expect(type).toBe("git_stash_push");
        expect(payload).toEqual({ cwd: "/repo", message: "save my work", includeUntracked: true });
        expect(result.current.operationInProgress).toBe("stash-push");
    });

    test("stashPop sends git_stash_pop with index", () => {
        const { result } = renderGitHook();

        act(() => {
            result.current.stashPop(1);
        });

        const { type, payload } = lastSendCall();
        expect(type).toBe("git_stash_pop");
        expect(payload).toEqual({ cwd: "/repo", index: 1 });
        expect(result.current.operationInProgress).toBe("stash-pop");
    });

    test("stashApply sends git_stash_apply with options", () => {
        const { result } = renderGitHook();

        act(() => {
            result.current.stashApply(2);
        });

        const { type, payload } = lastSendCall();
        expect(type).toBe("git_stash_apply");
        expect(payload).toEqual({ cwd: "/repo", index: 2 });
        expect(result.current.operationInProgress).toBe("stash-apply");
    });

    test("stashDrop sends git_stash_drop with index", () => {
        const { result } = renderGitHook();

        act(() => {
            result.current.stashDrop(0);
        });

        const { type, payload } = lastSendCall();
        expect(type).toBe("git_stash_drop");
        expect(payload).toEqual({ cwd: "/repo", index: 0 });
        expect(result.current.operationInProgress).toBe("stash-drop");
    });

    test("successful git_stash_result clears operationInProgress and schedules refresh", async () => {
        const { result } = renderGitHook();

        act(() => {
            result.current.stashPush();
        });
        const { requestId } = lastSendCall();

        emitMessage("git_stash_result", { ok: true, message: "Saved" }, requestId);

        expect(result.current.operationInProgress).toBeNull();
        expect(result.current.lastOperationResult).toEqual({ ok: true, message: "Saved" });

        await waitFor(() => {
            const refreshCall = findSendCall("git_full_status");
            expect(refreshCall).toBeDefined();
        });
    });

    test("git_stash_result with conflict sets lastConflictType and schedules refresh", async () => {
        const { result } = renderGitHook();

        act(() => {
            result.current.stashPop();
        });
        const { requestId } = lastSendCall();

        emitMessage("git_stash_result", { ok: false, conflict: true, message: "conflict" }, requestId);

        expect(result.current.lastConflictType).toBe("git_stash_result");

        await waitFor(() => {
            const refreshCall = findSendCall("git_full_status");
            expect(refreshCall).toBeDefined();
        });
    });

    test("stale cwd stash responses are discarded", () => {
        const { rerender, result } = renderGitHook("/repo-a");

        act(() => {
            result.current.stashList();
        });
        const firstRequestId = lastSendCall().requestId;

        act(() => {
            rerender({ cwd: "/repo-b" });
        });

        // Old stash list result for /repo-a should be ignored.
        emitMessage(
            "git_stash_list_result",
            { ok: true, stashes: [{ index: 0, ref: "stash@{0}", message: "old", shortHash: "old1234", date: "old" }] },
            firstRequestId
        );

        expect(result.current.stashes).toEqual([]);
    });
});

describe("visible fallback refresh", () => {
    test("runs light status every 5s, full metadata every 30s, and does not overlap requests", () => {
        const realSetInterval = globalThis.setInterval;
        const realClearInterval = globalThis.clearInterval;
        const realNow = Date.now;
        let now = 1_000_000;
        Date.now = () => now;
        const intervalCallbacks = new Map<number, () => void>();
        globalThis.setInterval = ((callback: TimerHandler, delay?: number) => {
            intervalCallbacks.set(delay ?? 0, callback as () => void);
            return (delay ?? 0) as unknown as ReturnType<typeof setInterval>;
        }) as typeof setInterval;
        globalThis.clearInterval = mock((_id: ReturnType<typeof setInterval>) => {}) as typeof clearInterval;

        try {
            const { unmount } = renderGitHook("/repo");
            settleStatus(findSendCall("git_full_status")?.requestId);
            sendSpy.mockClear();

            for (let elapsed = 5000; elapsed <= 30000; elapsed += 5000) {
                now = 1_000_000 + elapsed;
                const tick = () => {
                    for (const [delay, callback] of intervalCallbacks) {
                        if (elapsed % delay === 0) callback();
                    }
                };
                act(tick);
                const calls = sendSpy.mock.calls.length;
                act(tick);
                expect(sendSpy.mock.calls.length).toBe(calls); // no overlap
                const request = lastSendCall();
                if (request.type === "git_full_status") settleStatus(request.requestId);
                else settleLightStatus(request.requestId);
            }
            expect(sendCalls("git_full_status")).toHaveLength(1);
            expect(sendCalls("git_status")).toHaveLength(5);

            unmount();
            expect(globalThis.clearInterval).toHaveBeenCalled();
        } finally {
            Date.now = realNow;
            globalThis.setInterval = realSetInterval;
            globalThis.clearInterval = realClearInterval;
        }
    });

    test("starts polling after a panel mounted in a hidden tab becomes visible", () => {
        const realSetInterval = globalThis.setInterval;
        const realClearInterval = globalThis.clearInterval;
        const callbacks: Array<() => void> = [];
        globalThis.setInterval = ((callback: TimerHandler) => {
            callbacks.push(callback as () => void);
            return 456 as unknown as ReturnType<typeof setInterval>;
        }) as typeof setInterval;
        globalThis.clearInterval = mock(() => {}) as typeof clearInterval;
        try {
            visibilityState = "hidden";
            const { unmount } = renderGitHook("/repo");
            expect(sendSpy).not.toHaveBeenCalled();
            visibilityState = "visible";
            act(() => document.dispatchEvent(new win.Event("visibilitychange")));
            settleStatus(findSendCall("git_full_status")?.requestId);
            sendSpy.mockClear();
            act(() => { for (const callback of callbacks) callback(); });
            expect(sendCalls("git_status")).toHaveLength(1);
            unmount();
        } finally {
            globalThis.setInterval = realSetInterval;
            globalThis.clearInterval = realClearInterval;
        }
    });

    test("does not send fallback refresh traffic while backgrounded", () => {
        const realSetInterval = globalThis.setInterval;
        const realClearInterval = globalThis.clearInterval;
        const intervalCallbacks: Array<() => void> = [];
        globalThis.setInterval = ((callback: TimerHandler) => {
            intervalCallbacks.push(callback as () => void);
            return 456 as unknown as ReturnType<typeof setInterval>;
        }) as typeof setInterval;
        globalThis.clearInterval = mock((_id: ReturnType<typeof setInterval>) => {}) as typeof clearInterval;

        try {
            renderGitHook("/repo");
            settleStatus(findSendCall("git_full_status")?.requestId);
            sendSpy.mockClear();

            visibilityState = "hidden";
            act(() => {
                for (const callback of intervalCallbacks) callback();
            });
            expect(findSendCall("git_full_status")).toBeUndefined();
            expect(findSendCall("git_status")).toBeUndefined();
        } finally {
            globalThis.setInterval = realSetInterval;
            globalThis.clearInterval = realClearInterval;
        }
    });

    test("does not start fallback refresh when disconnected", () => {
        const realSetInterval = globalThis.setInterval;
        const realClearInterval = globalThis.clearInterval;
        const setIntervalSpy = mock((_callback: TimerHandler, _delay?: number) => 789 as unknown as ReturnType<typeof setInterval>);
        fakeSocket = createFakeSocket(false);
        globalThis.setInterval = setIntervalSpy as typeof setInterval;
        globalThis.clearInterval = mock((_id: ReturnType<typeof setInterval>) => {}) as typeof clearInterval;

        try {
            const { result } = renderGitHook("/repo");
            expect(result.current.connected).toBe(false);
            expect(sendSpy).not.toHaveBeenCalled();
            expect(setIntervalSpy).not.toHaveBeenCalled();
        } finally {
            globalThis.setInterval = realSetInterval;
            globalThis.clearInterval = realClearInterval;
        }
    });
});

describe("status freshness", () => {
    test("request ids are unique across simultaneous hook instances", () => {
        renderGitHook("/repo-a");
        renderGitHook("/repo-b");

        const ids = sendCalls("git_full_status").map((call) => call.requestId);
        expect(ids).toHaveLength(2);
        expect(new Set(ids).size).toBe(2);
    });

    test("sets an actionable error when the final status request times out", () => {
        const realSetTimeout = globalThis.setTimeout;
        const realClearTimeout = globalThis.clearTimeout;
        let fullStatusFallback: (() => void) | undefined;
        let statusTimeout: (() => void) | undefined;
        globalThis.setTimeout = ((callback: TimerHandler, delay?: number) => {
            if (delay === 1200) fullStatusFallback = callback as () => void;
            if (delay === 8000) statusTimeout = callback as () => void;
            return (delay ?? 0) as unknown as ReturnType<typeof setTimeout>;
        }) as typeof setTimeout;
        globalThis.clearTimeout = mock((_id: ReturnType<typeof setTimeout>) => {}) as typeof clearTimeout;

        try {
            const { result } = renderGitHook("/repo");
            expect(findSendCall("git_full_status")).toBeDefined();
            sendSpy.mockClear();

            act(() => {
                result.current.fetchStatus();
            });
            expect(result.current.loading).toBe(true);
            expect(fullStatusFallback).toBeDefined();

            act(() => fullStatusFallback?.());
            expect(statusTimeout).toBeDefined();

            act(() => statusTimeout?.());
            expect(result.current.loading).toBe(false);
            expect(result.current.status).toBeNull();
            expect(result.current.error).toBe("Git status request timed out. Check the runner connection and retry.");
        } finally {
            globalThis.setTimeout = realSetTimeout;
            globalThis.clearTimeout = realClearTimeout;
        }
    });

    test("fetchStatus requests a full snapshot and exposes successful refresh metadata", () => {
        const { result } = renderGitHook("/repo");
        sendSpy.mockClear();

        act(() => {
            result.current.fetchStatus();
        });

        const { requestId, payload } = lastSendCall();
        expect(lastSendCall().type).toBe("git_full_status");
        expect(payload).toEqual({ cwd: "/repo" });
        expect(result.current.refreshKey).toBe(0);
        expect(result.current.lastUpdated).toBeNull();

        emitMessage("git_full_status_result", {
            ok: true,
            status: { branch: "feature", changes: [{ status: "M", path: "src/a.ts" }], ahead: 1, behind: 0, hasUpstream: true, diffStaged: "" },
            branches: [{ name: "feature", shortHash: "abc1234", lastCommit: "work", isCurrent: true, isRemote: false }],
            currentBranch: "feature",
            worktrees: [{ path: "/repo", displayPath: "/repo", branch: "feature", shortHash: "abc1234", isDetached: false, isMain: false, changeCount: 1, ahead: 1, behind: 0 }],
        }, requestId);

        expect(result.current.status?.branch).toBe("feature");
        expect(result.current.branches).toHaveLength(1);
        expect(result.current.worktrees).toHaveLength(1);
        expect(result.current.refreshKey).toBe(1);
        expect(result.current.lastUpdated).toBeGreaterThan(0);
        expect(result.current.connected).toBe(true);
    });

    test("drops older status responses after an explicit refresh", () => {
        const { result } = renderGitHook("/repo");
        const initialRequest = findSendCall("git_full_status")!.requestId;

        act(() => {
            result.current.fetchStatus();
        });
        const refreshRequest = lastSendCallOfType("git_full_status")!.requestId;

        emitMessage("git_full_status_result", { ok: true, status: { branch: "new", changes: [] }, branches: [], currentBranch: "new", worktrees: [] }, refreshRequest);
        emitMessage("git_full_status_result", { ok: true, status: { branch: "old", changes: [] }, branches: [], currentBranch: "old", worktrees: [] }, initialRequest);

        expect(result.current.status?.branch).toBe("new");
        expect(result.current.refreshKey).toBe(1);
    });

    test("drops pre-reconnect status responses and refreshes after reconnect", async () => {
        const { result } = renderGitHook("/repo");
        const initialRequest = findSendCall("git_full_status")!.requestId;

        act(() => {
            fakeSocket.connected = false;
            fakeSocket.trigger("disconnect");
        });
        expect(result.current.connected).toBe(false);

        act(() => {
            fakeSocket.connected = true;
            fakeSocket.trigger("connect");
        });

        await waitFor(() => {
            expect(sendCalls("git_full_status").length).toBeGreaterThanOrEqual(2);
        });
        const reconnectRequest = lastSendCallOfType("git_full_status")!.requestId;
        emitMessage("git_full_status_result", { ok: true, status: { branch: "new", changes: [] }, branches: [], currentBranch: "new", worktrees: [] }, reconnectRequest);
        emitMessage("git_full_status_result", { ok: true, status: { branch: "old", changes: [] }, branches: [], currentBranch: "old", worktrees: [] }, initialRequest);

        expect(result.current.connected).toBe(true);
        expect(result.current.status?.branch).toBe("new");
    });
});

describe("git_repo_changed broadcast", () => {
    /** Settle the initial mount-time full-status request so the refresh scheduler isn't blocked by it. */
    function settleInitialFullStatus() {
        const initial = findSendCall("git_full_status");
        if (initial?.requestId) {
            emitMessage("git_full_status_result", { ok: true, status: { ok: true, branch: "main", changes: [] }, branches: [], currentBranch: "main", worktrees: [] }, initial.requestId);
        }
    }

    test("triggers a debounced full-status refresh for the current cwd", async () => {
        renderGitHook("/repo");
        settleInitialFullStatus();
        sendSpy.mockClear();

        emitMessage("git_repo_changed", { cwd: "/repo", version: 1 });

        await waitFor(() => {
            expect(findSendCall("git_full_status")).toBeDefined();
        });
        expect(findSendCall("git_full_status")!.payload.cwd).toBe("/repo");
    });

    test("does not refresh while disconnected and performs one recovery refresh on reconnect", async () => {
        const { result } = renderGitHook("/repo");
        settleInitialFullStatus();
        sendSpy.mockClear();

        act(() => {
            fakeSocket.connected = false;
            fakeSocket.trigger("disconnect");
        });
        emitMessage("git_repo_changed", { cwd: "/repo", version: 1 });
        await new Promise((r) => setTimeout(r, 250));
        expect(findSendCall("git_full_status")).toBeUndefined();
        expect(result.current.connected).toBe(false);

        act(() => {
            fakeSocket.connected = true;
            fakeSocket.trigger("connect");
        });

        await waitFor(() => {
            expect(sendCalls("git_full_status")).toHaveLength(1);
        });
        expect(result.current.connected).toBe(true);
    });

    test("ignores broadcasts for another cwd and stale/duplicate versions", async () => {
        renderGitHook("/repo");
        settleInitialFullStatus();
        sendSpy.mockClear();
        emitMessage("git_repo_changed", { cwd: "/repo", version: 3 });
        await waitFor(() => {
            expect(findSendCall("git_full_status")).toBeDefined();
        });
        // Settle the triggered refresh so an in-flight request can't mask the
        // version/cwd filtering being tested below.
        settleInitialFullStatus();
        sendSpy.mockClear();

        // Other repo's broadcast — not ours.
        emitMessage("git_repo_changed", { cwd: "/elsewhere", version: 9 });
        // Stale/duplicate version — already handled.
        emitMessage("git_repo_changed", { cwd: "/repo", version: 3 });
        emitMessage("git_repo_changed", { cwd: "/repo", version: 2 });

        await new Promise((r) => setTimeout(r, 250));
        expect(findSendCall("git_full_status")).toBeUndefined();
    });
});

describe("fetchRemote", () => {
    test("sends git_fetch only when called explicitly", () => {
        const { result } = renderGitHook("/repo");
        const initial = findSendCall("git_full_status");
        emitMessage("git_full_status_result", { ok: true, status: { branch: "main", changes: [] }, branches: [], currentBranch: "main", worktrees: [] }, initial?.requestId);
        sendSpy.mockClear();

        expect(findSendCall("git_fetch")).toBeUndefined();

        act(() => {
            result.current.fetchRemote();
        });

        const { type, payload, requestId } = lastSendCall();
        expect(type).toBe("git_fetch");
        expect(payload).toEqual({ cwd: "/repo" });
        expect(requestId).toBeDefined();
        expect(result.current.operationInProgress).toBe("fetch");
    });

    test("successful git_fetch_result clears operation and schedules refresh", async () => {
        const { result } = renderGitHook("/repo");
        const initial = findSendCall("git_full_status");
        emitMessage("git_full_status_result", { ok: true, status: { branch: "main", changes: [] }, branches: [], currentBranch: "main", worktrees: [] }, initial?.requestId);
        sendSpy.mockClear();

        act(() => {
            result.current.fetchRemote();
        });
        const { requestId } = lastSendCall();

        emitMessage("git_fetch_result", { ok: true, message: "Fetched" }, requestId);

        expect(result.current.operationInProgress).toBeNull();
        expect(result.current.lastOperationResult).toEqual({ ok: true, message: "Fetched" });

        await waitFor(() => {
            expect(findSendCall("git_full_status")).toBeDefined();
        });
    });

    test("times out ignored git_fetch on older runners", () => {
        const realSetTimeout = globalThis.setTimeout;
        const realClearTimeout = globalThis.clearTimeout;
        let fetchTimeout: (() => void) | undefined;
        globalThis.setTimeout = ((callback: TimerHandler, delay?: number) => {
            if (delay === 65000) fetchTimeout = callback as () => void;
            return 321 as unknown as ReturnType<typeof setTimeout>;
        }) as typeof setTimeout;
        globalThis.clearTimeout = mock((_id: ReturnType<typeof setTimeout>) => {}) as typeof clearTimeout;

        try {
            const { result } = renderGitHook("/repo");
            settleStatus(findSendCall("git_full_status")?.requestId);
            sendSpy.mockClear();

            act(() => {
                result.current.fetchRemote();
            });
            expect(result.current.operationInProgress).toBe("fetch");
            expect(fetchTimeout).toBeDefined();

            act(() => fetchTimeout?.());
            expect(result.current.operationInProgress).toBeNull();
            expect(result.current.lastOperationResult).toEqual({
                ok: false,
                message: "Fetch did not respond; runner may need updating. Check repository before retrying.",
            });
        } finally {
            globalThis.setTimeout = realSetTimeout;
            globalThis.clearTimeout = realClearTimeout;
        }
    });

    test("disconnect clears in-flight fetch operation", () => {
        const { result } = renderGitHook("/repo");
        settleStatus(findSendCall("git_full_status")?.requestId);
        sendSpy.mockClear();

        act(() => {
            result.current.fetchRemote();
        });
        expect(result.current.operationInProgress).toBe("fetch");

        act(() => {
            fakeSocket.connected = false;
            fakeSocket.trigger("disconnect");
        });

        expect(result.current.connected).toBe(false);
        expect(result.current.operationInProgress).toBeNull();
    });
});

describe("removeWorktree overrideInUse", () => {
    test("passes overrideInUse only when explicitly requested", () => {
        const { result } = renderGitHook("/repo");
        sendSpy.mockClear();

        act(() => result.current.removeWorktree("/repo/wt", true));
        expect(lastSendCall().type).toBe("git_worktree_remove");
        expect(lastSendCall().payload.overrideInUse).toBeUndefined();

        act(() => result.current.removeWorktree("/repo/wt", true, true));
        expect(lastSendCall().payload.overrideInUse).toBe(true);
    });
});
