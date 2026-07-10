import { describe, expect, test, beforeEach, afterEach, mock } from "bun:test";
import { render, act, waitFor } from "@testing-library/react";
import { Window } from "happy-dom";
import * as React from "react";
import type { HubSession } from "@/components/SessionSidebar";
import { useSessionLifecycle, type UseSessionLifecycleResult } from "./use-session-lifecycle";

// happy-dom provides a minimal DOM for React rendering.
const win = new Window({ url: "http://localhost/" });
(globalThis as unknown as Record<string, unknown>).window = win;
(globalThis as unknown as Record<string, unknown>).document = win.document;
(globalThis as unknown as Record<string, unknown>).navigator = win.navigator;
(globalThis as unknown as Record<string, unknown>).HTMLElement = win.HTMLElement;
(globalThis as unknown as Record<string, unknown>).Element = win.Element;
(globalThis as unknown as Record<string, unknown>).Event = win.Event;

const originalFetch = globalThis.fetch;

function TestHarness({
  liveSessions,
  expose,
  spawnTimeoutMs,
}: {
  liveSessions: HubSession[];
  expose: (api: UseSessionLifecycleResult) => void;
  spawnTimeoutMs?: number;
}) {
  const lifecycle = useSessionLifecycle({ liveSessions, spawnTimeoutMs });
  React.useEffect(() => {
    expose(lifecycle);
  }, [lifecycle, expose]);
  return null;
}

function renderHarness(liveSessions: HubSession[] = [], spawnTimeoutMs?: number) {
  const apiRef: { current: UseSessionLifecycleResult | null } = { current: null };
  const expose = (api: UseSessionLifecycleResult) => {
    apiRef.current = api;
  };
  const utils = render(
    React.createElement(TestHarness, { liveSessions, expose, spawnTimeoutMs }),
  );
  return { apiRef, utils };
}

describe("useSessionLifecycle", () => {
  beforeEach(() => {
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(JSON.stringify({ sessionId: "session-abc" }), { status: 200 }),
      ),
    ) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("initial state is idle", () => {
    const { apiRef } = renderHarness();
    expect(apiRef.current!.state.phase).toBe("idle");
    expect(apiRef.current!.viewerStatus).toBe("Idle");
    expect(apiRef.current!.state.activeSessionId).toBeNull();
  });

  test("openSession selects a session and returns a generation", () => {
    const { apiRef } = renderHarness();
    let generation = 0;
    act(() => {
      generation = apiRef.current!.openSession("session-abc");
    });
    expect(generation).toBeGreaterThan(0);
    expect(apiRef.current!.state.activeSessionId).toBe("session-abc");
    expect(apiRef.current!.state.phase).toBe("connecting");
    expect(apiRef.current!.viewerStatus).toBe("Connecting…");
    expect(apiRef.current!.refs.activeSessionId.current).toBe("session-abc");
  });

  test("spawnSession resolves when the session is already live", async () => {
    // Delay the fetch so we exercise the waiter path after the API response.
    globalThis.fetch = mock(
      () =>
        new Promise((resolve) =>
          setTimeout(
            () =>
              resolve(
                new Response(JSON.stringify({ sessionId: "session-abc" }), { status: 200 }),
              ),
            50,
          ),
        ),
    ) as unknown as typeof fetch;

    const { apiRef } = renderHarness(
      [
        {
          sessionId: "session-abc",
          shareUrl: "",
          cwd: "/tmp/foo",
          startedAt: new Date().toISOString(),
        },
      ],
      500,
    );

    let resolvedSessionId: string | null = null;
    await act(async () => {
      resolvedSessionId = await apiRef.current!.spawnSession("runner-1", "/tmp/foo");
    });

    expect(resolvedSessionId).toBe("session-abc");
    expect(apiRef.current!.state.phase).toBe("registering");
  });

  test("spawnSession throws and records error on API failure", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(JSON.stringify({ error: "No runners connected" }), { status: 503 }),
      ),
    ) as unknown as typeof fetch;

    const { apiRef } = renderHarness([], 50);

    let thrown: Error | null = null;
    await act(async () => {
      try {
        await apiRef.current!.spawnSession("runner-1", undefined);
      } catch (err) {
        thrown = err as Error;
      }
    });

    expect(thrown).not.toBeNull();
    expect(apiRef.current!.state.phase).toBe("error");
    expect(apiRef.current!.state.error).toContain("runner");
    expect(apiRef.current!.state.spawn.error).toBeTruthy();
  });

  test("spawnSession throws after wait-for-live timeout", async () => {
    const { apiRef } = renderHarness([], 50);

    let thrown: Error | null = null;
    await act(async () => {
      try {
        await apiRef.current!.spawnSession("runner-1", undefined);
      } catch (err) {
        thrown = err as Error;
      }
    });

    // Without rerendering with liveSessions, the waiter times out.
    expect(thrown).not.toBeNull();
    expect(thrown!.message).toContain("sidebar soon");
    expect(apiRef.current!.state.phase).toBe("error");
    expect(apiRef.current!.state.spawn.pendingSessionId).toBe("session-abc");
  });

  test("lifecycle callbacks drive state transitions", () => {
    const { apiRef } = renderHarness();

    act(() => {
      apiRef.current!.openSession("session-abc");
    });
    act(() => {
      apiRef.current!.onViewerConnected({ replayOnly: false });
    });
    expect(apiRef.current!.state.phase).toBe("connecting");
    expect(apiRef.current!.viewerStatus).toBe("Connected");

    act(() => {
      apiRef.current!.onSnapshotStarted({ chunked: true, snapshotId: "snap-1", totalMessages: 10 });
    });
    expect(apiRef.current!.refs.chunked.current).not.toBeNull();
    expect(apiRef.current!.viewerStatus).toBe("Loading session (0 of 10 messages)…");

    act(() => {
      apiRef.current!.onChunkProgress(5, 10);
    });
    expect(apiRef.current!.viewerStatus).toBe("Loading session (5 of 10 messages)…");

    act(() => {
      apiRef.current!.onSnapshotComplete();
    });
    expect(apiRef.current!.state.phase).toBe("live");
    expect(apiRef.current!.viewerStatus).toBe("Connected");
    expect(apiRef.current!.refs.hydrated.current).toBe(true);
  });

  test("disconnected with isRestarting transitions to reconnecting", () => {
    const { apiRef } = renderHarness();

    act(() => {
      apiRef.current!.openSession("session-abc");
    });
    act(() => {
      apiRef.current!.onViewerConnected({});
    });
    act(() => {
      apiRef.current!.onSnapshotStarted({});
    });
    act(() => {
      apiRef.current!.onSnapshotComplete();
    });

    act(() => {
      apiRef.current!.onViewerDisconnected({ reason: "Session reconnected", isRestarting: true });
    });
    expect(apiRef.current!.state.phase).toBe("reconnecting");
    expect(apiRef.current!.viewerStatus).toBe("Restarting CLI…");
    expect(apiRef.current!.refs.restartPendingSessionId.current).toBe("session-abc");
  });

  test("clearSelection resets to idle", () => {
    const { apiRef } = renderHarness();

    act(() => {
      apiRef.current!.openSession("session-abc");
    });
    act(() => {
      apiRef.current!.onViewerConnected({});
    });

    act(() => {
      apiRef.current!.clearSelection();
    });
    expect(apiRef.current!.state.phase).toBe("idle");
    expect(apiRef.current!.state.activeSessionId).toBeNull();
    expect(apiRef.current!.refs.activeSessionId.current).toBeNull();
  });
});
