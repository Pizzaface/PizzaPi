import { afterEach, expect, spyOn, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";
import { useEffect } from "react";
import {
  SigilProvider, useSigilGeneration, useSigilResolve, useSigilTextResolver, useSigilTriggerResolve,
} from "./SigilContext";

const sigilDefs = [{ type: "pr", label: "PR", serviceId: "github", resolve: "/resolve/{id}", resolvePort: 1234 }];
const panels: [] = [];
const originalFetch = globalThis.fetch;

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

function mountSigil(isOnline = () => true, reactStrictMode = false) {
  return renderHook(() => {
    const trigger = useSigilTriggerResolve();
    const generation = useSigilGeneration();
    // Same automatic resolution pattern as SigilPill, including its loop risk.
    useEffect(() => { trigger("pr", "1"); }, [trigger, generation]);
    return useSigilResolve("pr", "1");
  }, {
    reactStrictMode,
    wrapper: ({ children }) => (
      <SigilProvider sigilDefs={sigilDefs} panels={panels} runnerId="runner-1" runnerOnline={isOnline()}>
        {children}
      </SigilProvider>
    ),
  });
}

function captureTimers() {
  const callbacks: Array<() => void> = [];
  const delays: number[] = [];
  const timer = spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void, delay: number) => {
    callbacks.push(callback);
    delays.push(delay);
    return 123;
  }) as typeof setTimeout);
  return { callbacks, delays, restore: () => timer.mockRestore() };
}

test("retries a transient failure with unchanged metadata after transport recovers", async () => {
  let calls = 0;
  globalThis.fetch = (async () => ++calls === 1
    ? new Response(null, { status: 503 })
    : Response.json({ title: "Recovered" })) as typeof fetch;
  const timers = captureTimers();
  try {
    const { result } = mountSigil();
    await act(async () => {});
    expect(calls).toBe(1);
    expect(timers.callbacks).toHaveLength(1);
    await act(async () => { timers.callbacks.shift()!(); });
    expect(result.current.data?.title).toBe("Recovered");
    expect(calls).toBe(2);
    expect(timers.callbacks).toHaveLength(0);
  } finally { timers.restore(); }
});

test("bounds network-error retries and resets the exhausted budget on reconnect", async () => {
  let calls = 0;
  let online = true;
  let recovered = false;
  globalThis.fetch = (async () => {
    calls++;
    if (!recovered) throw new TypeError("Network unavailable");
    return Response.json({ title: "Reconnected" });
  }) as typeof fetch;
  const timers = captureTimers();
  try {
    const { result, rerender } = mountSigil(() => online);
    await act(async () => {});
    for (let i = 0; i < 3; i++) {
      expect(timers.callbacks).toHaveLength(1);
      await act(async () => { timers.callbacks.shift()!(); });
    }
    expect(calls).toBe(4);
    expect(timers.delays).toEqual([1000, 2000, 4000]);
    expect(timers.callbacks).toHaveLength(0);
    expect(result.current.error).toContain("Network unavailable");
    expect(result.current.loading).toBe(false);
    online = false;
    rerender();
    recovered = true;
    online = true;
    rerender();
    await act(async () => {});
    expect(calls).toBe(5);
    expect(result.current.data?.title).toBe("Reconnected");
  } finally { timers.restore(); }
});

test("does not retry a permanent HTTP error", async () => {
  let calls = 0;
  globalThis.fetch = (async () => { calls++; return new Response(null, { status: 404 }); }) as typeof fetch;
  const timers = captureTimers();
  try {
    const { result } = mountSigil();
    await act(async () => {});
    expect(result.current.error).toContain("404");
    expect(calls).toBe(1);
    expect(timers.callbacks).toHaveLength(0);
  } finally { timers.restore(); }
});

test("waits while runner is offline and automatically resolves when it rejoins", async () => {
  let online = false;
  let calls = 0;
  globalThis.fetch = (async () => { calls++; return Response.json({ title: "Rejoined" }); }) as typeof fetch;
  const { result, rerender } = mountSigil(() => online);
  await act(async () => {});
  expect(calls).toBe(0);
  online = true;
  rerender();
  await act(async () => {});
  expect(calls).toBe(1);
  expect(result.current.data?.title).toBe("Rejoined");
});

test.each(["success", "failure"])("ignores a stale %s arriving after reconnect", async (outcome) => {
  let online = true;
  let settleOld!: () => void;
  let calls = 0;
  globalThis.fetch = (() => ++calls === 1
    ? new Promise<Response>((resolve, reject) => {
      settleOld = () => outcome === "success"
        ? resolve(Response.json({ title: "Stale" }))
        : reject(new Error("Old runner disconnected"));
    })
    : Promise.resolve(Response.json({ title: "Fresh" }))) as typeof fetch;
  const { result, rerender } = mountSigil(() => online);
  online = false;
  rerender();
  online = true;
  rerender();
  await act(async () => {});
  expect(result.current.data?.title).toBe("Fresh");
  await act(async () => { settleOld(); });
  expect(result.current.data?.title).toBe("Fresh");
  expect(result.current.error).toBeUndefined();
  expect(calls).toBe(2);
});

test("cancels pending retry timers on unmount", async () => {
  let calls = 0;
  globalThis.fetch = (async () => { calls++; return new Response(null, { status: 503 }); }) as typeof fetch;
  const timers = captureTimers();
  const clear = spyOn(globalThis, "clearTimeout");
  try {
    const { unmount } = mountSigil();
    await act(async () => {});
    expect(timers.callbacks).toHaveLength(1);
    unmount();
    expect(clear).toHaveBeenCalledWith(123);
    await act(async () => { timers.callbacks.shift()!(); });
    expect(calls).toBe(1);
  } finally {
    clear.mockRestore();
    timers.restore();
  }
});

test("resolves a sigil to explicit text, falling back to title", async () => {
  globalThis.fetch = (async () => Response.json({ text: "Plain text", title: "Display title" })) as typeof fetch;
  const { result } = renderHook(() => useSigilTextResolver(), {
    wrapper: ({ children }) => (
      <SigilProvider sigilDefs={sigilDefs} panels={panels} runnerId="runner-1">
        {children}
      </SigilProvider>
    ),
  });

  let resolved: string | undefined;
  await act(async () => { resolved = await result.current("pr", "1"); });
  expect(resolved).toBe("Plain text");
});

test("falls back to resolved title when a service has no text field", async () => {
  globalThis.fetch = (async () => Response.json({ title: "Display title" })) as typeof fetch;
  const { result } = renderHook(() => useSigilTextResolver(), {
    wrapper: ({ children }) => (
      <SigilProvider sigilDefs={sigilDefs} panels={panels} runnerId="runner-1">
        {children}
      </SigilProvider>
    ),
  });

  let resolved: string | undefined;
  await act(async () => { resolved = await result.current("pr", "1"); });
  expect(resolved).toBe("Display title");
});

test("resolves under StrictMode effect replay", async () => {
  globalThis.fetch = (async () => Response.json({ title: "Resolved" })) as typeof fetch;
  const { result } = mountSigil(() => true, true);
  await act(async () => {});
  expect(result.current.data?.title).toBe("Resolved");
  expect(result.current.loading).toBe(false);
});
