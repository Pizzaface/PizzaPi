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

function emitMessage(type: string, payload: unknown, requestId?: string) {
    act(() => {
        capturedOnMessage?.(type, payload, requestId);
    });
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

    test("resolves empty array and does not update log state on error", async () => {
        const { result } = renderGitHook();

        let promise: Promise<GitLogEntry[]> | undefined;
        act(() => {
            promise = result.current.fetchLog();
        });

        const { requestId } = lastSendCall();
        emitMessage("git_log_result", { ok: false, message: "bad rev" }, requestId);

        await expect(promise!).resolves.toEqual([]);
        expect(result.current.log).toEqual([]);
    });

    test("returns empty array when service unavailable", async () => {
        channelAvailable = false;
        const { result } = renderGitHook();

        let promise: Promise<GitLogEntry[]> | undefined;
        act(() => {
            promise = result.current.fetchLog();
        });

        await expect(promise!).resolves.toEqual([]);
        expect(sendSpy).not.toHaveBeenCalled();
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
