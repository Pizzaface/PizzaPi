/**
 * Tests for FileExplorer — in-flight request isolation across
 * runner/session/cwd switches.
 *
 * The component stays mounted when the active session changes (the parent
 * does not remount it), so a slow /files response from the PREVIOUS scope
 * can resolve AFTER a fast response for the NEW scope and silently overwrite
 * it, since fetchFiles had no generation/cancellation guard tied to scope.
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
(globalThis as any).SVGElement = win.SVGElement;
(globalThis as any).MutationObserver = win.MutationObserver;
(globalThis as any).getComputedStyle = win.getComputedStyle.bind(win);
(globalThis as any).ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
/* eslint-enable @typescript-eslint/no-explicit-any */

// FileExplorer doesn't need a real git service for this test — it only reads
// git.available/git.status when blaming a file, which never happens here.
mock.module("@/hooks/useGitService", () => ({
  useGitService: () => ({ available: false, status: null }),
}));

// Dynamic imports AFTER the happy-dom globals (same ordering constraint as
// AtMentionPopover.test.tsx: react-dom probes window.document exactly once
// at import time).
const { render, cleanup, waitFor } = await import("@testing-library/react");
const React = (await import("react")).default;
void React;
const { FileExplorer } = await import("./FileExplorer");

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
  mock.restore();
});

function jsonResponse(files: Array<{ name: string; path: string; isDirectory: boolean; isSymlink: boolean }>) {
  return { ok: true, status: 200, json: async () => ({ ok: true, files }) } as unknown as Response;
}

describe("FileExplorer scope isolation", () => {
  test("a late response for the OLD session does not overwrite the NEW session's (empty) listing", async () => {
    let resolveOld!: (value: Response) => void;
    const oldPromise = new Promise<Response>((resolve) => { resolveOld = resolve; });

    (globalThis as any).fetch = mock(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      if (body.sessionId === "sess-a") return oldPromise;
      return jsonResponse([]); // scope B's directory is empty
    });

    const { rerender, getByText, queryByText } = render(
      <FileExplorer runnerId="runner-1" cwd="/proj-a" sessionId="sess-a" />,
    );

    // Scope A's request is in flight (never resolved yet) — still loading.
    await waitFor(() => expect((globalThis as any).fetch).toHaveBeenCalledTimes(1));

    // Switch to a different session AND cwd while A's request is still
    // pending. Scope B's request resolves fast with an empty directory.
    rerender(<FileExplorer runnerId="runner-1" cwd="/proj-b" sessionId="sess-b" />);
    await waitFor(() => expect(getByText("Empty directory")).toBeTruthy());

    // NOW let the old session's slow response resolve late, with a
    // non-empty file list.
    resolveOld(jsonResponse([{ name: "stale-from-session-a.ts", path: "stale-from-session-a.ts", isDirectory: false, isSymlink: false }]));
    await new Promise((r) => setTimeout(r, 20));

    // The regression this test pins: the late write from session A must not
    // replace session B's (correct) empty listing with session A's files.
    expect(queryByText("Empty directory")).toBeTruthy();
  });
});
