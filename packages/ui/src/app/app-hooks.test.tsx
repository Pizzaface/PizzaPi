/**
 * Render-level tests for state hooks extracted from App.tsx. These cross the
 * React commit boundary (setter identity across renders, layout-effect ref
 * sync, RAF-batched streaming flushes) that the pure-helper tests can't.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { HubSession } from "@/components/SessionSidebar";
import type { RelayMessage } from "@/components/SessionViewer";

const win = new Window({ url: "http://localhost/" });
(globalThis as any).window = win;
(globalThis as any).document = win.document;

const { useSessionState, createInitialSessionState } = await import("./useSessionState");
const { useStreamingMessages } = await import("./useStreamingMessages");
const { useToasts } = await import("./useToasts");
const { useLiveSessionBadges } = await import("./useLiveSessionBadges");

// Deterministic requestAnimationFrame: queue callbacks, flush on demand.
let rafQueue: Array<{ id: number; cb: FrameRequestCallback }> = [];
let nextRafId = 1;
const originalRaf = globalThis.requestAnimationFrame;
const originalCaf = globalThis.cancelAnimationFrame;
function flushRaf() {
  const queue = rafQueue;
  rafQueue = [];
  for (const { cb } of queue) cb(0);
}

beforeEach(() => {
  rafQueue = [];
  (globalThis as any).requestAnimationFrame = (cb: FrameRequestCallback) => {
    const id = nextRafId++;
    rafQueue.push({ id, cb });
    return id;
  };
  (globalThis as any).cancelAnimationFrame = (id: number) => {
    rafQueue = rafQueue.filter((entry) => entry.id !== id);
  };
});

afterEach(() => {
  cleanup();
  (globalThis as any).requestAnimationFrame = originalRaf;
  (globalThis as any).cancelAnimationFrame = originalCaf;
});

describe("useSessionState", () => {
  test("setters are stable across renders and support functional updates", () => {
    const { result, rerender } = renderHook(() => useSessionState());
    const firstSetMessages = result.current.setMessages;
    const firstSetGoal = result.current.setGoal;

    act(() => { result.current.setSessionName("one"); });
    act(() => { result.current.setSessionName((prev) => `${prev}-two`); });
    rerender();

    expect(result.current.sessionState.sessionName).toBe("one-two");
    expect(result.current.setMessages).toBe(firstSetMessages);
    expect(result.current.setGoal).toBe(firstSetGoal);
  });

  test("setAgentActive mirrors the value into agentActiveRef synchronously", () => {
    const { result } = renderHook(() => useSessionState());
    act(() => { result.current.setAgentActive(true); });
    expect(result.current.agentActiveRef.current).toBe(true);
    expect(result.current.sessionState.agentActive).toBe(true);
  });

  test("messagesRef / activeModelRef track committed state", () => {
    const { result } = renderHook(() => useSessionState());
    const message: RelayMessage = { key: "a", role: "user", content: "hi" };
    act(() => {
      result.current.setMessages([message]);
      result.current.setActiveModel({ provider: "p", id: "m" } as never);
    });
    expect(result.current.messagesRef.current).toEqual([message]);
    expect(result.current.activeModelRef.current).toEqual({ provider: "p", id: "m" });
  });

  test("setSessionState(createInitialSessionState()) resets every field", () => {
    const { result } = renderHook(() => useSessionState());
    act(() => {
      result.current.setSessionName("x");
      result.current.setUsageRefreshing(true);
    });
    act(() => { result.current.setSessionState(createInitialSessionState()); });
    expect(result.current.sessionState).toEqual(createInitialSessionState());
  });
});

describe("useStreamingMessages", () => {
  function setup() {
    return renderHook(() => {
      const state = useSessionState();
      const streaming = useStreamingMessages(state.setMessages);
      return { state, streaming };
    });
  }

  test("debounced deltas are batched into one flush per frame", () => {
    const { result } = setup();
    act(() => {
      result.current.streaming.upsertMessageDebounced({ role: "assistant", id: "m1", content: "h" }, "p");
      result.current.streaming.upsertMessageDebounced({ role: "assistant", id: "m1", content: "he" }, "p");
    });
    expect(rafQueue).toHaveLength(1);
    expect(result.current.state.sessionState.messages).toHaveLength(0);

    act(() => { flushRaf(); });
    expect(result.current.state.sessionState.messages.map((m) => m.content)).toEqual(["he"]);
  });

  test("final message evicts the in-flight partial and cancels its pending flush", () => {
    const { result } = setup();
    act(() => {
      result.current.streaming.upsertMessageDebounced({ role: "assistant", id: "p1", content: "partial" }, "stream");
    });
    act(() => { flushRaf(); });
    expect(result.current.state.sessionState.messages.map((m) => m.key)).toEqual(["assistant:id:p1"]);

    act(() => {
      result.current.streaming.upsertMessageDebounced({ role: "assistant", id: "p1", content: "partial 2" }, "stream");
      result.current.streaming.upsertMessage({ role: "assistant", timestamp: 7, content: "final" }, "end", true);
    });
    // The queued frame was cancelled because its only pending partial was evicted.
    expect(rafQueue).toHaveLength(0);
    expect(result.current.state.sessionState.messages.map((m) => m.key)).toEqual(["assistant:ts:7"]);
  });

  test("cancelPendingDeltas drops queued deltas and tool-stream partials", () => {
    const { result } = setup();
    act(() => {
      result.current.streaming.upsertMessageDebounced({ role: "assistant", content: "x" }, "s");
      result.current.streaming.pendingToolStreamRef.current.set("t1", { role: "toolResult", toolCallId: "t1", content: "out" });
      result.current.streaming.scheduleToolStreamFlush();
      result.current.streaming.thinkingDurationsRef.current.set(0, 3);
    });
    expect(rafQueue).toHaveLength(2);
    act(() => { result.current.streaming.cancelPendingDeltas(); });
    expect(rafQueue).toHaveLength(0);
    expect(result.current.streaming.pendingToolStreamRef.current.size).toBe(0);
    expect(result.current.streaming.thinkingDurationsRef.current.size).toBe(0);
  });

  test("tool stream flush upserts partial tool output", () => {
    const { result } = setup();
    act(() => {
      result.current.streaming.pendingToolStreamRef.current.set("t1", { role: "toolResult", toolCallId: "t1", content: "a" });
      result.current.streaming.scheduleToolStreamFlush();
      result.current.streaming.scheduleToolStreamFlush(); // already scheduled → no second frame
    });
    expect(rafQueue).toHaveLength(1);
    act(() => { flushRaf(); });
    expect(result.current.state.sessionState.messages.map((m) => m.key)).toEqual(["tool-call:t1"]);
  });
});

describe("useToasts", () => {
  test("pushToast adds a toast and dismissToast removes it", () => {
    const { result } = renderHook(() => useToasts());
    const pushToast = result.current.pushToast;
    act(() => { result.current.pushToast("hello", "warning"); });
    expect(result.current.toasts).toHaveLength(1);
    expect(result.current.toasts[0]).toMatchObject({ message: "hello", type: "warning" });
    expect(result.current.pushToast).toBe(pushToast);

    act(() => { result.current.dismissToast(result.current.toasts[0].id); });
    expect(result.current.toasts).toHaveLength(0);
  });
});

describe("useLiveSessionBadges", () => {
  test("prunes badge entries for sessions that are no longer live", () => {
    const live = (ids: string[]) => ids.map((sessionId) => ({ sessionId }) as HubSession);
    const { result, rerender } = renderHook(({ sessions }) => useLiveSessionBadges(sessions), {
      initialProps: { sessions: live(["a", "b"]) },
    });
    act(() => {
      result.current.setSessionsAwaitingInput(new Set(["a", "b"]));
      result.current.setSessionsCompacting(new Set(["b"]));
    });
    rerender({ sessions: live(["a"]) });
    expect([...result.current.sessionsAwaitingInput]).toEqual(["a"]);
    expect([...result.current.sessionsCompacting]).toEqual([]);
  });
});
