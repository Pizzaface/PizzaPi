import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import {
    parseHealthDegraded,
    fetchHealthDegraded,
    createHealthPoller,
    shouldTriggerRecoveryPoll,
    type HealthResponse,
} from "./DegradedBanner.logic";

// ── helpers ──────────────────────────────────────────────────────────────────

function makeResponse(data: Partial<HealthResponse>): Response {
    const full: HealthResponse = {
        status: "ok",
        redis: true,
        socketio: true,
        uptime: 100,
        ...data,
    };
    return new Response(JSON.stringify(full), {
        headers: { "content-type": "application/json" },
    });
}

// Capture the original fetch so we can restore it after mocking.
const originalFetch = globalThis.fetch;

afterEach(() => {
    globalThis.fetch = originalFetch;
});

// ── parseHealthDegraded ───────────────────────────────────────────────────────

describe("parseHealthDegraded", () => {
    test("returns false when status is ok", () => {
        expect(parseHealthDegraded({ status: "ok", redis: true, socketio: true, uptime: 10 })).toBe(false);
    });

    test("returns true when status is degraded", () => {
        expect(parseHealthDegraded({ status: "degraded", redis: false, socketio: false, uptime: 10 })).toBe(true);
    });

    test("status field is authoritative — ok overrides false redis/socketio flags", () => {
        // Edge case: server may report ok even if individual flags are false
        // (e.g. optional components). The status field wins.
        expect(parseHealthDegraded({ status: "ok", redis: false, socketio: false, uptime: 10 })).toBe(false);
    });

    test("status field is authoritative — degraded overrides true flags", () => {
        expect(parseHealthDegraded({ status: "degraded", redis: true, socketio: true, uptime: 10 })).toBe(true);
    });
});

// ── fetchHealthDegraded ───────────────────────────────────────────────────────

describe("fetchHealthDegraded", () => {
    test("returns false when server responds status ok", async () => {
        globalThis.fetch = mock(() => Promise.resolve(makeResponse({ status: "ok" }))) as unknown as typeof fetch;

        const result = await fetchHealthDegraded();
        expect(result).toBe(false);
    });

    test("returns true when server responds status degraded", async () => {
        globalThis.fetch = mock(() => Promise.resolve(makeResponse({ status: "degraded" }))) as unknown as typeof fetch;

        const result = await fetchHealthDegraded();
        expect(result).toBe(true);
    });

    test("returns true on network failure (fetch rejects)", async () => {
        globalThis.fetch = mock(() => Promise.reject(new TypeError("Network error"))) as unknown as typeof fetch;

        const result = await fetchHealthDegraded();
        expect(result).toBe(true);
    });

    test("returns true on JSON parse failure", async () => {
        globalThis.fetch = mock(() =>
            Promise.resolve(new Response("not-json", { headers: { "content-type": "application/json" } }))
        ) as unknown as typeof fetch;

        const result = await fetchHealthDegraded();
        expect(result).toBe(true);
    });

    test("returns true when response is valid JSON but missing status field (fail-safe)", async () => {
        // Schema-invalid — status is absent; should not silently return false.
        globalThis.fetch = mock(() =>
            Promise.resolve(new Response(JSON.stringify({ redis: true, socketio: true, uptime: 42 }), {
                headers: { "content-type": "application/json" },
            }))
        ) as unknown as typeof fetch;

        const result = await fetchHealthDegraded();
        expect(result).toBe(true);
    });

    test("returns true when response has an unknown status value (fail-safe)", async () => {
        // Unexpected value for status — treat as degraded, not ok.
        globalThis.fetch = mock(() =>
            Promise.resolve(new Response(JSON.stringify({ status: "unknown", redis: true, socketio: true, uptime: 42 }), {
                headers: { "content-type": "application/json" },
            }))
        ) as unknown as typeof fetch;

        const result = await fetchHealthDegraded();
        expect(result).toBe(true);
    });

    test("returns true when response is a non-object JSON value (fail-safe)", async () => {
        globalThis.fetch = mock(() =>
            Promise.resolve(new Response(JSON.stringify(null), {
                headers: { "content-type": "application/json" },
            }))
        ) as unknown as typeof fetch;

        const result = await fetchHealthDegraded();
        expect(result).toBe(true);
    });

    test("re-throws AbortError so callers can detect cancellation", async () => {
        const abortErr = Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
        globalThis.fetch = mock(() => Promise.reject(abortErr)) as unknown as typeof fetch;

        await expect(fetchHealthDegraded()).rejects.toMatchObject({ name: "AbortError" });
    });

    test("passes the AbortSignal through to fetch", async () => {
        let capturedSignal: AbortSignal | undefined;
        globalThis.fetch = mock(((_url: string, init?: RequestInit) => {
            capturedSignal = init?.signal ?? undefined;
            return Promise.resolve(makeResponse({ status: "ok" }));
        }) as unknown as typeof fetch) as unknown as typeof fetch;

        const controller = new AbortController();
        await fetchHealthDegraded(controller.signal);
        expect(capturedSignal).toBe(controller.signal);
    });
});

// ── createHealthPoller — in-flight guard ─────────────────────────────────────

describe("shouldTriggerRecoveryPoll", () => {
    test("returns true when transitioning into connected", () => {
        expect(shouldTriggerRecoveryPoll(null, "connected")).toBe(true);
        expect(shouldTriggerRecoveryPoll("disconnected", "connected")).toBe(true);
        expect(shouldTriggerRecoveryPoll("connecting", "connected")).toBe(true);
    });

    test("returns false when already connected", () => {
        expect(shouldTriggerRecoveryPoll("connected", "connected")).toBe(false);
    });

    test("returns false for non-connected next states", () => {
        expect(shouldTriggerRecoveryPoll("disconnected", "connecting")).toBe(false);
        expect(shouldTriggerRecoveryPoll("connected", "disconnected")).toBe(false);
    });
});

describe("createHealthPoller — in-flight guard", () => {
    test("invokes onResult with false when server is healthy", async () => {
        globalThis.fetch = mock(() => Promise.resolve(makeResponse({ status: "ok" }))) as unknown as typeof fetch;

        const results: boolean[] = [];
        const poll = createHealthPoller((d) => results.push(d));
        await poll();

        expect(results).toEqual([false]);
    });

    test("invokes onResult with true when server is degraded", async () => {
        globalThis.fetch = mock(() => Promise.resolve(makeResponse({ status: "degraded" }))) as unknown as typeof fetch;

        const results: boolean[] = [];
        const poll = createHealthPoller((d) => results.push(d));
        await poll();

        expect(results).toEqual([true]);
    });

    test("invokes onResult with true on network failure", async () => {
        globalThis.fetch = mock(() => Promise.reject(new TypeError("Network error"))) as unknown as typeof fetch;

        const results: boolean[] = [];
        const poll = createHealthPoller((d) => results.push(d));
        await poll();

        expect(results).toEqual([true]);
    });

    test("skips second concurrent call while first is in-flight", async () => {
        // Use a blocking promise to simulate a slow /health response.
        let fetchCallCount = 0;
        let resolveFirst!: (r: Response) => void;
        const blockingFetch = new Promise<Response>((resolve) => {
            resolveFirst = resolve;
        });

        globalThis.fetch = mock(() => {
            fetchCallCount++;
            return blockingFetch;
        }) as unknown as typeof fetch;

        const results: boolean[] = [];
        const poll = createHealthPoller((d) => results.push(d));

        // Start first poll — it will block at the fetch call.
        // By the time the next line runs, inFlight has already been set to true
        // (the synchronous preamble of the async function ran before the first await).
        const p1 = poll();

        // Second call while first is in-flight should be a no-op.
        await poll();
        expect(fetchCallCount).toBe(1); // only one fetch initiated

        // Complete the first poll.
        resolveFirst(makeResponse({ status: "ok" }));
        await p1;

        expect(results).toHaveLength(1);
        expect(results[0]).toBe(false);
    });

    test("allows subsequent calls once in-flight request completes", async () => {
        let fetchCallCount = 0;
        globalThis.fetch = mock(() => {
            fetchCallCount++;
            return Promise.resolve(makeResponse({ status: "ok" }));
        }) as unknown as typeof fetch;

        const results: boolean[] = [];
        const poll = createHealthPoller((d) => results.push(d));

        await poll();
        await poll();

        expect(fetchCallCount).toBe(2);
        expect(results).toEqual([false, false]);
    });

    test("silently discards AbortError (component unmounted mid-fetch)", async () => {
        const controller = new AbortController();
        const abortErr = Object.assign(new Error("Aborted"), { name: "AbortError" });
        globalThis.fetch = mock(() => Promise.reject(abortErr)) as unknown as typeof fetch;

        const results: boolean[] = [];
        const poll = createHealthPoller((d) => results.push(d), controller.signal);

        // Should not throw or call onResult
        await expect(poll()).resolves.toBeUndefined();
        expect(results).toHaveLength(0);
    });

    test("resets inFlight after an error so subsequent calls can proceed", async () => {
        let callCount = 0;
        globalThis.fetch = mock(() => {
            callCount++;
            return Promise.reject(new TypeError("Network error"));
        }) as unknown as typeof fetch;

        const results: boolean[] = [];
        const poll = createHealthPoller((d) => results.push(d));

        await poll(); // error → calls onResult(true), resets inFlight
        await poll(); // should proceed, not be blocked

        expect(callCount).toBe(2);
        expect(results).toEqual([true, true]);
    });
});

// ── auto-recovery logic (state note) ─────────────────────────────────────────
//
// The dismiss + auto-recovery state transitions live inside the React component
// (DegradedBanner.tsx) and require a DOM environment with React Testing Library
// to exercise end-to-end.  The pure logic under test here covers:
//
//   ✓  degraded detection   (parseHealthDegraded)
//   ✓  polling + in-flight guard (createHealthPoller)
//   ✓  network error → degraded
//   ✓  AbortError → silent discard (unmount safety)
//
// Component-level tests for dismiss and auto-recovery reset are tracked
// separately: https://github.com/pizzaface/PizzaPi/issues (search "DegradedBanner RTL")
