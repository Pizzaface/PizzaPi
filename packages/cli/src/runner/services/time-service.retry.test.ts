/**
 * Tests for TimeService delivery retry and durable cron state.
 *
 * A schedule must not be lost because its owning session is offline:
 *   - one-shot (time:timer_fired / time:at) re-arms with backoff on a
 *     transient failure and removes the subscription only on success;
 *   - a 404 (session gone) settles without retrying;
 *   - cron retries a failed fire without advancing, and its next-fire /
 *     iteration survive a restart via ~/.pizzapi/time-service-state.json.
 */

import { describe, test, expect, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TimeService } from "./time-service.js";
import type { TriggerSubscriptionEntry } from "@pizzapi/protocol";

let service: TimeService;
const originalHome = process.env.HOME;
const originalRelayUrl = process.env.PIZZAPI_RELAY_URL;
const originalApiKey = process.env.PIZZAPI_RUNNER_API_KEY;
const originalFetch = globalThis.fetch;

afterEach(() => {
    service?.dispose();
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalRelayUrl === undefined) delete process.env.PIZZAPI_RELAY_URL;
    else process.env.PIZZAPI_RELAY_URL = originalRelayUrl;
    if (originalApiKey === undefined) delete process.env.PIZZAPI_RUNNER_API_KEY;
    else process.env.PIZZAPI_RUNNER_API_KEY = originalApiKey;
    globalThis.fetch = originalFetch;
});

function entry(
    sessionId: string,
    triggerType: string,
    params?: Record<string, string | number | boolean | Array<string | number | boolean>>,
    subscriptionId?: string,
): TriggerSubscriptionEntry {
    return { sessionId, triggerType, subscriptionId: subscriptionId ?? `${sessionId}-${triggerType}`, runnerId: "runner-test", params };
}

interface RecordedCall { method: string; url: string; body: string }

/** Install a fetch mock that returns the given statuses in order (last repeats). */
function mockFetch(statuses: number[]): RecordedCall[] {
    const calls: RecordedCall[] = [];
    let i = 0;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        calls.push({
            method: init?.method ?? "GET",
            url: typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url,
            body: typeof init?.body === "string" ? init.body : "",
        });
        const status = statuses[Math.min(i, statuses.length - 1)] ?? 200;
        i++;
        return new Response(null, { status });
    }) as typeof fetch;
    return calls;
}

const posts = (calls: RecordedCall[]) => calls.filter((c) => c.method === "POST");
const deletes = (calls: RecordedCall[]) => calls.filter((c) => c.method === "DELETE");

function setupEnv(): string {
    const home = mkdtempSync(join(tmpdir(), "pizzapi-time-retry-"));
    mkdirSync(join(home, ".pizzapi"), { recursive: true });
    writeFileSync(join(home, ".pizzapi", "runner.json"), JSON.stringify({ runnerId: "runner-test" }), "utf-8");
    process.env.HOME = home;
    process.env.PIZZAPI_RELAY_URL = "http://relay.test";
    process.env.PIZZAPI_RUNNER_API_KEY = "test-api-key";
    return home;
}

describe("one-shot delivery retry", () => {
    test("re-arms with backoff on a transient failure and removes the subscription on success", async () => {
        setupEnv();
        const calls = mockFetch([503, 200]);
        service = new TimeService([10, 20]); // 10ms, 20ms backoff

        service.reconcileSubscriptions([
            entry("sess-1", "time:timer_fired", { duration: "0.01s" }, "sub-1"),
        ]);

        await new Promise((resolve) => setTimeout(resolve, 60));
        expect(posts(calls)).toHaveLength(2); // first 503, retry 200
        expect(deletes(calls)).toHaveLength(1); // removed only after success
    });

    test("settles without retrying when the session is gone (404)", async () => {
        setupEnv();
        const calls = mockFetch([404]);
        service = new TimeService([10, 20]);

        service.reconcileSubscriptions([
            entry("sess-1", "time:timer_fired", { duration: "0.01s" }, "sub-1"),
        ]);

        await new Promise((resolve) => setTimeout(resolve, 60));
        expect(posts(calls)).toHaveLength(1); // no retry
        expect(deletes(calls)).toHaveLength(0); // nothing to clean up
    });
});

describe("cron delivery retry and durable state", () => {
    test("retries a failed fire without advancing, and catches up a fire missed while down", async () => {
        const home = setupEnv();
        const calls = mockFetch([503, 200]);
        // Persist a cron whose next fire is already past (missed while the
        // runner was down) with a non-zero iteration count.
        writeFileSync(
            join(home, ".pizzapi", "time-service-state.json"),
            JSON.stringify({ "sub-cron": { nextFireAt: Date.now() - 1000, iteration: 3 } }),
            "utf-8",
        );
        service = new TimeService([10, 20], 10); // 10ms backoff, 10ms check interval

        service.reconcileSubscriptions([
            entry("sess-1", "time:cron", { cron: "0 0 * * *" }, "sub-cron"),
        ]);

        await new Promise((resolve) => setTimeout(resolve, 80));
        const fires = posts(calls);
        expect(fires).toHaveLength(2); // catch-up 503, retry 200
        // Iteration continues from the persisted 3, not a reset 0.
        expect(JSON.parse(fires[0]!.body).payload.iteration).toBe(4);
    });

    test("persists cron state on subscribe and drops it on unsubscribe", () => {
        const home = setupEnv();
        service = new TimeService();

        service.reconcileSubscriptions([
            entry("sess-1", "time:cron", { cron: "0 0 * * *" }, "sub-cron"),
        ]);

        const statePath = join(home, ".pizzapi", "time-service-state.json");
        expect(existsSync(statePath)).toBe(true);
        expect(JSON.parse(readFileSync(statePath, "utf-8")).hasOwnProperty("sub-cron")).toBe(true);

        service.reconcileSubscriptions([
            entry("sess-1", "time:cron", undefined, "sub-cron"),
        ], { mode: "delta", action: "unsubscribe" });

        expect(JSON.parse(readFileSync(statePath, "utf-8")).hasOwnProperty("sub-cron")).toBe(false);
    });
});
