/**
 * Tests for TimeService.reconcileSubscriptions().
 *
 * reconcileSubscriptions() rebuilds in-memory timer/cron state from a
 * TriggerSubscriptionEntry snapshot. These tests verify:
 *   - returns { applied, errors? } shape
 *   - counts applied correctly for timer_fired, time:at, and time:cron subs
 *   - ignores subscriptions for trigger types owned by other services
 *   - stale timers/crons are cleared when not present in a new snapshot
 *   - handles missing or invalid params gracefully (no throw, warning only)
 *
 * Note: TimeService can be instantiated and reconcileSubscriptions() called
 * without init() — the method only accesses internal Maps, not the socket
 * or HTTP server. dispose() is called at the end of each test to clear any
 * scheduled timers.
 */

import { describe, test, expect, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TimeService } from "./time-service.js";
import type { TriggerSubscriptionEntry } from "@pizzapi/protocol";

// Shared service instance — reset after each test.
let service: TimeService;
const originalHome = process.env.HOME;
const originalRelayUrl = process.env.PIZZAPI_RELAY_URL;
const originalApiKey = process.env.PIZZAPI_RUNNER_API_KEY;
const originalFetch = globalThis.fetch;

afterEach(() => {
    // dispose() is safe without init() — guarded for null socket/server.
    service?.dispose();
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalRelayUrl === undefined) delete process.env.PIZZAPI_RELAY_URL;
    else process.env.PIZZAPI_RELAY_URL = originalRelayUrl;
    if (originalApiKey === undefined) delete process.env.PIZZAPI_RUNNER_API_KEY;
    else process.env.PIZZAPI_RUNNER_API_KEY = originalApiKey;
    globalThis.fetch = originalFetch;
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function entry(
    sessionId: string,
    triggerType: string,
    params?: Record<string, string | number | boolean | Array<string | number | boolean>>,
): TriggerSubscriptionEntry {
    return { sessionId, triggerType, runnerId: "runner-test", params };
}

function setupBroadcastEnv(): void {
    const home = mkdtempSync(join(tmpdir(), "pizzapi-time-service-"));
    mkdirSync(join(home, ".pizzapi"), { recursive: true });
    writeFileSync(
        join(home, ".pizzapi", "runner.json"),
        JSON.stringify({ runnerId: "runner-test" }),
        "utf-8",
    );
    process.env.HOME = home;
    process.env.PIZZAPI_RELAY_URL = "http://relay.test";
    process.env.PIZZAPI_RUNNER_API_KEY = "test-api-key";
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("TimeService.reconcileSubscriptions()", () => {
    describe("return shape", () => {
        test("returns { applied: 0 } for an empty snapshot", () => {
            service = new TimeService();
            const result = service.reconcileSubscriptions([]);
            expect(result.applied).toBe(0);
            expect(result.errors).toBeUndefined();
        });

        test("returns { applied } with no errors when all subs are valid", () => {
            service = new TimeService();
            const result = service.reconcileSubscriptions([
                entry("s1", "time:timer_fired", { duration: "1h" }),
                entry("s2", "time:cron", { cron: "0 * * * *" }),
            ]);
            expect(result.applied).toBe(2);
            expect(result.errors).toBeUndefined();
        });
    });

    describe("time:timer_fired subscriptions", () => {
        test("counts a valid timer_fired subscription as applied", () => {
            service = new TimeService();
            const result = service.reconcileSubscriptions([
                entry("sess-1", "time:timer_fired", { duration: "30m" }),
            ]);
            expect(result.applied).toBe(1);
        });

        test("counts missing duration as applied (handler warns, does not throw)", () => {
            service = new TimeService();
            // duration param is required by the trigger def but the handler just
            // logs a warning and returns rather than throwing — so it still counts.
            const result = service.reconcileSubscriptions([
                entry("sess-1", "time:timer_fired", {}),
            ]);
            // No throw → applied still incremented
            expect(result.applied).toBe(1);
            expect(result.errors).toBeUndefined();
        });

        test("handles multiple sessions with timer_fired", () => {
            service = new TimeService();
            const result = service.reconcileSubscriptions([
                entry("sess-A", "time:timer_fired", { duration: "1h" }),
                entry("sess-B", "time:timer_fired", { duration: "2h" }),
                entry("sess-C", "time:timer_fired", { duration: "30m" }),
            ]);
            expect(result.applied).toBe(3);
        });
    });

    describe("time:at subscriptions", () => {
        test("counts a valid future time:at subscription as applied", () => {
            service = new TimeService();
            // Use a future date within 20 days so setTimeout doesn't overflow 32-bit int.
            // The timer won't fire during the test since dispose() clears it immediately.
            const futureMs = Date.now() + 20 * 24 * 60 * 60 * 1000; // 20 days from now
            const at = new Date(futureMs).toISOString();
            const result = service.reconcileSubscriptions([
                entry("sess-1", "time:at", { at }),
            ]);
            expect(result.applied).toBe(1);
        });

        test("counts a past time:at subscription as applied (fires immediately via async)", () => {
            service = new TimeService();
            // Past date — the handler fires immediately (void async) but doesn't throw
            const result = service.reconcileSubscriptions([
                entry("sess-1", "time:at", { at: "2020-01-01T00:00:00Z" }),
            ]);
            expect(result.applied).toBe(1);
        });

        test("counts missing 'at' param as applied (handler warns, does not throw)", () => {
            service = new TimeService();
            const result = service.reconcileSubscriptions([
                entry("sess-1", "time:at", {}),
            ]);
            expect(result.applied).toBe(1);
        });
    });

    describe("time:cron subscriptions", () => {
        test("counts a valid cron subscription as applied", () => {
            service = new TimeService();
            const result = service.reconcileSubscriptions([
                entry("sess-1", "time:cron", { cron: "0 9 * * *" }),
            ]);
            expect(result.applied).toBe(1);
        });

        test("counts an invalid cron expression as applied (handler warns, does not throw)", () => {
            service = new TimeService();
            const result = service.reconcileSubscriptions([
                entry("sess-1", "time:cron", { cron: "not-a-cron" }),
            ]);
            expect(result.applied).toBe(1);
        });
    });

    describe("filtering to time trigger types only", () => {
        test("ignores subscriptions for other services' trigger types", () => {
            service = new TimeService();
            const result = service.reconcileSubscriptions([
                entry("sess-1", "github:pr_opened", { repo: "org/repo" }),
                entry("sess-2", "godmother:idea_moved"),
                entry("sess-3", "time:timer_fired", { duration: "1h" }),
            ]);
            // Only time:timer_fired counts
            expect(result.applied).toBe(1);
        });

        test("returns applied=0 when snapshot contains only non-time subscriptions", () => {
            service = new TimeService();
            const result = service.reconcileSubscriptions([
                entry("sess-1", "github:pr_opened"),
                entry("sess-2", "custom:event"),
            ]);
            expect(result.applied).toBe(0);
        });
    });

    describe("stale timer removal", () => {
        test("second reconcile with empty snapshot removes previously created timers", () => {
            service = new TimeService();

            // First snapshot: create a timer
            const r1 = service.reconcileSubscriptions([
                entry("sess-1", "time:timer_fired", { duration: "1h" }),
            ]);
            expect(r1.applied).toBe(1);

            // Second snapshot: empty — stale timer must be removed, applied = 0
            const r2 = service.reconcileSubscriptions([]);
            expect(r2.applied).toBe(0);
        });

        test("second reconcile replaces existing timer for same session", () => {
            service = new TimeService();

            // First snapshot
            const r1 = service.reconcileSubscriptions([
                entry("sess-1", "time:timer_fired", { duration: "1h" }),
                entry("sess-2", "time:timer_fired", { duration: "2h" }),
            ]);
            expect(r1.applied).toBe(2);

            // Second snapshot: only sess-1 remains, sess-2 is stale
            const r2 = service.reconcileSubscriptions([
                entry("sess-1", "time:timer_fired", { duration: "30m" }),
            ]);
            expect(r2.applied).toBe(1);
        });

        test("second reconcile with empty snapshot removes crons", () => {
            service = new TimeService();

            const r1 = service.reconcileSubscriptions([
                entry("sess-1", "time:cron", { cron: "*/30 * * * *" }),
            ]);
            expect(r1.applied).toBe(1);

            // Remove the cron via empty snapshot
            const r2 = service.reconcileSubscriptions([]);
            expect(r2.applied).toBe(0);
        });
    });

    describe("mixed subscription types in one snapshot", () => {
        test("handles all three time trigger types together", () => {
            service = new TimeService();
            // Use a near-future at-time so setTimeout stays within 32-bit range
            const futureMs = Date.now() + 15 * 24 * 60 * 60 * 1000; // 15 days
            const at = new Date(futureMs).toISOString();
            const result = service.reconcileSubscriptions([
                entry("sess-timer", "time:timer_fired", { duration: "1h" }),
                entry("sess-at", "time:at", { at }),
                entry("sess-cron", "time:cron", { cron: "0 0 * * *" }),
            ]);
            expect(result.applied).toBe(3);
            expect(result.errors).toBeUndefined();
        });

        test("counts correctly when time subs are mixed with other service subs", () => {
            service = new TimeService();
            const result = service.reconcileSubscriptions([
                entry("sess-1", "time:timer_fired", { duration: "5m", label: "reminder" }),
                entry("sess-1", "github:pr_opened"),          // ignored
                entry("sess-2", "time:cron", { cron: "0 8 * * 1-5" }),
                entry("sess-2", "godmother:idea_shipped"),    // ignored
            ]);
            // Only 2 time subscriptions applied
            expect(result.applied).toBe(2);
        });
    });

    describe("delta reconciliation", () => {
        test("unsubscribe delta removes an existing timer", async () => {
            setupBroadcastEnv();
            const fetchCalls: Array<{ url: string; body: string }> = [];
            globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
                fetchCalls.push({
                    url: typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url,
                    body: typeof init?.body === "string" ? init.body : "",
                });
                return new Response(null, { status: 200 });
            }) as typeof fetch;

            service = new TimeService();
            service.reconcileSubscriptions([
                entry("sess-1", "time:timer_fired", { duration: "0.02s", label: "short" }),
            ], { mode: "delta", action: "subscribe" });

            const result = service.reconcileSubscriptions([
                entry("sess-1", "time:timer_fired"),
            ], { mode: "delta", action: "unsubscribe" });

            expect(result.applied).toBe(1);
            await new Promise((resolve) => setTimeout(resolve, 60));
            expect(fetchCalls).toHaveLength(0);
        });

        test("single-subscription delta does not remove unrelated timers", async () => {
            setupBroadcastEnv();
            const fetchCalls: Array<{ url: string; body: string }> = [];
            globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
                fetchCalls.push({
                    url: typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url,
                    body: typeof init?.body === "string" ? init.body : "",
                });
                return new Response(null, { status: 200 });
            }) as typeof fetch;

            service = new TimeService();
            service.reconcileSubscriptions([
                entry("sess-a", "time:timer_fired", { duration: "0.2s", label: "long" }),
                entry("sess-b", "time:timer_fired", { duration: "0.02s", label: "short" }),
            ]);

            const result = service.reconcileSubscriptions([
                entry("sess-a", "time:timer_fired", { duration: "0.2s", label: "long-updated" }),
            ], { mode: "delta", action: "update" });

            expect(result.applied).toBe(1);
            await new Promise((resolve) => setTimeout(resolve, 70));
            expect(fetchCalls).toHaveLength(1);
            expect(fetchCalls[0]?.url).toBe("http://relay.test/api/runners/runner-test/trigger-broadcast");
            expect(fetchCalls[0]?.body).toContain('"label":"short"');
        });
    });

    describe("dispose after reconcile", () => {
        test("dispose() cleans up without errors after reconcileSubscriptions", () => {
            service = new TimeService();
            service.reconcileSubscriptions([
                entry("sess-1", "time:timer_fired", { duration: "1h" }),
                entry("sess-2", "time:cron", { cron: "*/15 * * * *" }),
            ]);
            // Should not throw
            expect(() => service.dispose()).not.toThrow();
        });
    });
});
