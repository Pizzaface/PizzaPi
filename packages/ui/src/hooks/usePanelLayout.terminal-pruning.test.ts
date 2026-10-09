/**
 * Regression tests for bz-022 / GM VD0KKFpB: TerminalManager kept zombie
 * terminals from ended sessions mounted forever (with live WebSockets)
 * because nothing ever removed a tab once its session went away.
 *
 * Earlier rounds found two issues with a naive fix:
 *   1. A same-ID reconnect broadcasts session_removed *before*
 *      session_added (server: registerTuiSession -> endSharedSessionUnlocked),
 *      so a reconnecting session is briefly, transiently absent.
 *   2. An empty/partial "sessions" resync snapshot can transiently drop an
 *      entry the same way.
 * Both are handled by a grace period (TERMINAL_PRUNE_GRACE_MS) plus an
 * independent, fresh reconfirmation (confirmSessionEnded) before pruning,
 * and a per-session generation token guards against a session reappearing
 * WHILE confirmSessionEnded's fetch is still in flight.
 *
 * REDESIGN (959-r4): the remote PTY kill is now entirely SERVER-authoritative
 * on confirmed session end (see sio-registry/sessions.ts endSharedSession) —
 * the UI never emits kill_terminal and pruning here is pure tab bookkeeping,
 * so a confirmed-ended session's tab is removed immediately after the grace
 * period + reconfirm, with no pendingKill flag or wait for a kill
 * confirmation.
 *
 * Exercises the real usePanelLayout hook (not a reimplemented helper) via
 * @testing-library/react's renderHook, so it fails if the production
 * pruning effect regresses.
 */
import { afterEach, describe, expect, jest, test } from "bun:test";
import { Window } from "happy-dom";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { TerminalTab } from "../components/TerminalManager";

// ── DOM globals ─────────────────────────────────────────────────────────────
// Must be set BEFORE the hook module is imported so module evaluation sees a
// browser environment (React effects need a DOM).
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
/* eslint-enable @typescript-eslint/no-explicit-any */

const { usePanelLayout } = await import("./usePanelLayout");

// Mirrors the hook's internal TERMINAL_PRUNE_GRACE_MS.
// Deliberately overshoots it so timing drift in CI can't flake these.
const PAST_GRACE_MS = 6000;

afterEach(() => {
  cleanup();
  jest.useRealTimers();
  try {
    localStorage.clear();
  } catch {}
});

function makeTab(terminalId: string, sessionId: string | null): TerminalTab {
  return { terminalId, runnerId: "r1", label: terminalId, sessionId };
}

/** Advance fake timers and flush the microtask queue so the async
 * confirmSessionEnded chain inside the hook's timer callback settles. */
async function advance(ms: number) {
  await act(async () => {
    jest.advanceTimersByTime(ms);
    // confirmSessionEnded is awaited (a promise chain of a few hops) —
    // flush enough microtask turns for it to resolve and for the follow-up
    // setTerminalTabs to apply.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("usePanelLayout — terminal tab pruning on session end", () => {
  test("drops a tab once its session is confirmed ended (absent past the grace period) — no kill_terminal involved", async () => {
    jest.useFakeTimers();
    const confirmSessionEnded = async () => true;
    const { result, rerender } = renderHook(
      ({ liveSessionIds }: { liveSessionIds: string[] }) =>
        usePanelLayout(null, liveSessionIds, confirmSessionEnded),
      { initialProps: { liveSessionIds: ["session-a"] } },
    );

    act(() => {
      result.current.handleTerminalTabAdd(makeTab("term-1", "session-a"));
    });
    expect(result.current.terminalTabs.map((t) => t.terminalId)).toEqual(["term-1"]);

    // Session ends → it drops out of liveSessionIds.
    rerender({ liveSessionIds: [] });
    // Immediately after: still present (grace period hasn't elapsed).
    expect(result.current.terminalTabs.map((t) => t.terminalId)).toEqual(["term-1"]);

    await advance(PAST_GRACE_MS);

    // Reconfirmed ended → pruned directly. No pendingKill flag, no wait for
    // a kill confirmation — the server already killed the terminal.
    expect(result.current.terminalTabs).toEqual([]);
    expect(result.current.activeTerminalId).toBeNull();
  });

  test("does NOT prune a tab before its session has ever been confirmed live", async () => {
    jest.useFakeTimers();
    // liveSessionIds starts empty (sessions feed not hydrated yet) — a tab
    // for a session we haven't seen live yet must survive, otherwise every
    // terminal would vanish on first mount.
    const confirmSessionEnded = async () => true;
    const { result, rerender } = renderHook(
      ({ liveSessionIds }: { liveSessionIds: string[] }) =>
        usePanelLayout(null, liveSessionIds, confirmSessionEnded),
      { initialProps: { liveSessionIds: [] as string[] } },
    );

    act(() => {
      result.current.handleTerminalTabAdd(makeTab("term-1", "session-a"));
    });
    rerender({ liveSessionIds: [] });
    await advance(PAST_GRACE_MS);
    expect(result.current.terminalTabs.map((t) => t.terminalId)).toEqual(["term-1"]);

    // Now the feed hydrates and reports session-a as live — tab stays.
    rerender({ liveSessionIds: ["session-a"] });
    expect(result.current.terminalTabs.map((t) => t.terminalId)).toEqual(["term-1"]);

    // session-a ends — now it gets pruned since we've confirmed it was live.
    rerender({ liveSessionIds: [] });
    await advance(PAST_GRACE_MS);
    expect(result.current.terminalTabs).toEqual([]);
  });

  test("never prunes unscoped terminals (sessionId: null)", async () => {
    jest.useFakeTimers();
    const confirmSessionEnded = async () => true;
    const { result, rerender } = renderHook(
      ({ liveSessionIds }: { liveSessionIds: string[] }) =>
        usePanelLayout(null, liveSessionIds, confirmSessionEnded),
      { initialProps: { liveSessionIds: ["session-a"] } },
    );

    act(() => {
      result.current.handleTerminalTabAdd(makeTab("term-unscoped", null));
    });
    rerender({ liveSessionIds: [] });
    await advance(PAST_GRACE_MS);
    expect(result.current.terminalTabs.map((t) => t.terminalId)).toEqual(["term-unscoped"]);
  });

  test("keeps tabs from sessions that remain live", async () => {
    jest.useFakeTimers();
    const confirmSessionEnded = async () => true;
    const { result, rerender } = renderHook(
      ({ liveSessionIds }: { liveSessionIds: string[] }) =>
        usePanelLayout(null, liveSessionIds, confirmSessionEnded),
      { initialProps: { liveSessionIds: ["session-a", "session-b"] } },
    );

    act(() => {
      result.current.handleTerminalTabAdd(makeTab("term-a", "session-a"));
      result.current.handleTerminalTabAdd(makeTab("term-b", "session-b"));
    });

    // Only session-a ends.
    rerender({ liveSessionIds: ["session-b"] });
    await advance(PAST_GRACE_MS);

    expect(result.current.terminalTabs.map((t) => t.terminalId)).toEqual(["term-b"]);
  });

  test("session_removed -> session_added same-ID reconnect keeps the tab (never prunes on transient absence)", async () => {
    jest.useFakeTimers();
    let confirmCalls = 0;
    const confirmSessionEnded = async () => {
      confirmCalls++;
      return true;
    };
    const { result, rerender } = renderHook(
      ({ liveSessionIds }: { liveSessionIds: string[] }) =>
        usePanelLayout(null, liveSessionIds, confirmSessionEnded),
      { initialProps: { liveSessionIds: ["session-a"] } },
    );

    act(() => {
      result.current.handleTerminalTabAdd(makeTab("term-1", "session-a"));
    });

    // registerTuiSession's reconnect path: session_removed fires first...
    rerender({ liveSessionIds: [] });
    // ...well within the grace period, session_added re-adds the SAME id.
    await advance(500);
    rerender({ liveSessionIds: ["session-a"] });

    // Even long past what would have been the grace period, the tab must
    // still be here, and confirmSessionEnded must never have been called —
    // the reappearance cancelled the pending countdown before it fired.
    await advance(PAST_GRACE_MS);

    expect(result.current.terminalTabs.map((t) => t.terminalId)).toEqual(["term-1"]);
    expect(confirmCalls).toBe(0);
  });

  test("an empty snapshot followed by a corrected full snapshot keeps tabs", async () => {
    jest.useFakeTimers();
    let confirmCalls = 0;
    const confirmSessionEnded = async () => {
      confirmCalls++;
      return true;
    };
    const { result, rerender } = renderHook(
      ({ liveSessionIds }: { liveSessionIds: string[] }) =>
        usePanelLayout(null, liveSessionIds, confirmSessionEnded),
      { initialProps: { liveSessionIds: ["session-a", "session-b"] } },
    );

    act(() => {
      result.current.handleTerminalTabAdd(makeTab("term-a", "session-a"));
      result.current.handleTerminalTabAdd(makeTab("term-b", "session-b"));
    });

    // A resync (e.g. REST fallback firing against a stale/incomplete read)
    // reports an empty snapshot — SessionSidebar replaces its list wholesale.
    rerender({ liveSessionIds: [] });
    // Shortly after, the next real update corrects it back to the full set.
    await advance(800);
    rerender({ liveSessionIds: ["session-a", "session-b"] });

    await advance(PAST_GRACE_MS);

    expect(result.current.terminalTabs.map((t) => t.terminalId).sort()).toEqual(["term-a", "term-b"]);
    expect(confirmCalls).toBe(0);
  });

  test("a session that reappears WHILE confirmSessionEnded's fetch is still in flight is never pruned", async () => {
    jest.useFakeTimers();
    let confirmCalls = 0;
    let resolveConfirm: ((value: boolean) => void) | null = null;
    // A deliberately slow, manually-resolved confirmSessionEnded — models a
    // real in-flight fetch that outlives a reconnect that happens after the
    // grace-period timer fired but before the confirm settles.
    const confirmSessionEnded = async () => {
      confirmCalls++;
      return new Promise<boolean>((resolve) => { resolveConfirm = resolve; });
    };
    const { result, rerender } = renderHook(
      ({ liveSessionIds }: { liveSessionIds: string[] }) =>
        usePanelLayout(null, liveSessionIds, confirmSessionEnded),
      { initialProps: { liveSessionIds: ["session-a"] } },
    );

    act(() => {
      result.current.handleTerminalTabAdd(makeTab("term-1", "session-a"));
    });

    rerender({ liveSessionIds: [] });
    await advance(PAST_GRACE_MS); // fires the grace timer → calls confirmSessionEnded, which is now pending
    expect(confirmCalls).toBe(1);
    // Still mounted — the confirm hasn't resolved yet.
    expect(result.current.terminalTabs).toHaveLength(1);

    // The session reappears WHILE the confirm is still in flight.
    rerender({ liveSessionIds: ["session-a"] });

    // Now the stale confirm finally resolves (reporting "ended", based on
    // data that's since gone stale).
    await act(async () => {
      resolveConfirm?.(true);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    // Must bail instead of pruning a live session on stale data.
    expect(result.current.terminalTabs.map((t) => t.terminalId)).toEqual(["term-1"]);
  });

  test("bounded tracking: forgets a session once its last tab closes, so a later tab for the same id isn't pruned on stale 'seen' state", async () => {
    jest.useFakeTimers();
    const confirmSessionEnded = async () => true;
    const { result, rerender } = renderHook(
      ({ liveSessionIds }: { liveSessionIds: string[] }) =>
        usePanelLayout(null, liveSessionIds, confirmSessionEnded),
      { initialProps: { liveSessionIds: ["session-a"] } },
    );

    act(() => {
      result.current.handleTerminalTabAdd(makeTab("term-1", "session-a"));
    });
    // User closes the only tab — session-a now owns none. Without bounded
    // tracking, "session-a was confirmed live" would linger forever.
    act(() => {
      result.current.handleTerminalTabClose("term-1");
    });

    // session-a is no longer reported live (e.g. it actually ended, or the
    // id gets reused) and a brand-new tab is opened for it.
    rerender({ liveSessionIds: [] });
    act(() => {
      result.current.handleTerminalTabAdd(makeTab("term-2", "session-a"));
    });

    // Long past the grace period: term-2 must survive. If the stale "seen"
    // entry had leaked, term-2 would be wrongly treated as already-confirmed
    // live and pruned here instead of waiting for a fresh confirmation.
    await advance(PAST_GRACE_MS);

    expect(result.current.terminalTabs.map((t) => t.terminalId)).toEqual(["term-2"]);
  });
});
