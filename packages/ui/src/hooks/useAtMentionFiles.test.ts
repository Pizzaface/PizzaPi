/**
 * Tests for useAtMentionFiles — scope isolation across session/runner/cwd
 * switches.
 *
 * The hook keeps a path-keyed cache for the lifetime of the hook instance
 * (the popover that owns it stays mounted across session switches). Without
 * invalidating that cache — and cancelling any in-flight request — on a scope
 * change, revisiting the same relative path (e.g. the root "") after
 * switching sessions/runners/cwd would silently serve the PREVIOUS scope's
 * stale listing, or let a late response from the old scope overwrite the new
 * scope's result.
 */
import { afterEach, describe, expect, test, mock } from "bun:test";
import { Window } from "happy-dom";

// ── DOM globals ─────────────────────────────────────────────────────────────
const win = new Window({ url: "http://localhost/" });
/* eslint-disable @typescript-eslint/no-explicit-any */
(win as any).SyntaxError = SyntaxError;
(globalThis as any).window = win;
(globalThis as any).document = win.document;
(globalThis as any).navigator = win.navigator;
(globalThis as any).HTMLElement = win.HTMLElement;
(globalThis as any).Element = win.Element;
(globalThis as any).Node = win.Node;
(globalThis as any).MutationObserver = win.MutationObserver;
(globalThis as any).getComputedStyle = win.getComputedStyle.bind(win);
/* eslint-enable @typescript-eslint/no-explicit-any */

const { renderHook, cleanup, waitFor } = await import("@testing-library/react");
// Use the pre-captured real function (see test-setup.ts) rather than a fresh
// import() — AtMentionPopover.test.tsx mock.module()s this same hook, and
// Bun's module mocks overwrite the module's exports IN PLACE with no
// per-test undo, so a normal import() here (this file sorts after that one)
// would silently get that mock.
const useAtMentionFiles = (globalThis as any).__realUseAtMentionFiles as typeof import("./useAtMentionFiles").useAtMentionFiles;

afterEach(() => {
    cleanup();
    mock.restore();
});

function jsonResponse(files: Array<{ name: string; path: string; isDirectory: boolean; isSymlink: boolean }>) {
    return { ok: true, status: 200, json: async () => ({ ok: true, files }) } as unknown as Response;
}

describe("useAtMentionFiles scope isolation", () => {
    test("switching scope (session/cwd) does NOT serve the previous scope's cached entries for the same relative path", async () => {
        const calls: Array<{ path: string; sessionId?: string }> = [];
        (globalThis as any).fetch = mock(async (_url: string, init: RequestInit) => {
            const body = JSON.parse(init.body as string);
            calls.push({ path: body.path, sessionId: body.sessionId });
            if (body.sessionId === "sess-a") {
                return jsonResponse([{ name: "old-session-file.ts", path: "src/old-session-file.ts", isDirectory: false, isSymlink: false }]);
            }
            return jsonResponse([{ name: "new-session-file.ts", path: "src/new-session-file.ts", isDirectory: false, isSymlink: false }]);
        });

        const { result, rerender } = renderHook(
            (props: { runnerId: string; basePath: string; sessionId: string }) =>
                useAtMentionFiles(props.runnerId, "src", true, props.basePath, props.sessionId),
            { initialProps: { runnerId: "runner-1", basePath: "/proj-a", sessionId: "sess-a" } },
        );

        // Scope A resolves and populates the "src" cache entry.
        await waitFor(() => expect(result.current.entries.map((e) => e.name)).toEqual(["old-session-file.ts"]));
        expect(calls).toHaveLength(1);

        // Switch to a DIFFERENT scope (different session + cwd) while revisiting
        // the SAME relative path "src". A stale per-path cache would serve scope
        // A's entries immediately, with no new network request at all.
        rerender({ runnerId: "runner-1", basePath: "/proj-b", sessionId: "sess-b" });

        await waitFor(() => expect(calls).toHaveLength(2));
        expect(calls[1]).toEqual({ path: "/proj-b/src", sessionId: "sess-b" });

        await waitFor(() => expect(result.current.entries.map((e) => e.name)).toEqual(["new-session-file.ts"]));
        // The regression this test pins: entries must never transiently (or
        // permanently) show scope A's file for scope B's "src" path.
        expect(result.current.entries.some((e) => e.name === "old-session-file.ts")).toBe(false);
    });

    test("a late response from the OLD scope does not overwrite the NEW scope's listing", async () => {
        let resolveOld!: (value: Response) => void;
        const oldPromise = new Promise<Response>((resolve) => { resolveOld = resolve; });

        const calls: Array<{ sessionId?: string }> = [];
        (globalThis as any).fetch = mock(async (_url: string, init: RequestInit) => {
            const body = JSON.parse(init.body as string);
            calls.push({ sessionId: body.sessionId });
            if (body.sessionId === "sess-a") return oldPromise;
            return jsonResponse([{ name: "fast-new-scope.ts", path: "docs/fast-new-scope.ts", isDirectory: false, isSymlink: false }]);
        });

        const { result, rerender } = renderHook(
            (props: { runnerId: string; basePath: string; sessionId: string; path: string }) =>
                useAtMentionFiles(props.runnerId, props.path, true, props.basePath, props.sessionId),
            { initialProps: { runnerId: "runner-1", basePath: "/proj-a", sessionId: "sess-a", path: "docs" } },
        );

        // Scope A's request is in flight (never resolved yet).
        await waitFor(() => expect(calls).toHaveLength(1));

        // Switch scope AND path so the new request bypasses any cache hit —
        // this isolates the "late write" race from the cache-staleness bug
        // covered by the test above.
        rerender({ runnerId: "runner-1", basePath: "/proj-b", sessionId: "sess-b", path: "docs2" });
        await waitFor(() => expect(result.current.entries.map((e) => e.name)).toEqual(["fast-new-scope.ts"]));

        // NOW let the old scope's slow request resolve late.
        resolveOld(jsonResponse([{ name: "slow-old-scope.ts", path: "docs/slow-old-scope.ts", isDirectory: false, isSymlink: false }]));
        await new Promise((r) => setTimeout(r, 20));

        // The late response must not have clobbered the fast scope B result.
        expect(result.current.entries.map((e) => e.name)).toEqual(["fast-new-scope.ts"]);
    });
});
