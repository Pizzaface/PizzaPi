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
const toUrl = (calls: RecordedCall[], substr: string) => calls.filter((c) => c.url.includes(substr));

/** URL-aware fetch mock: routes each request through `handler`. */
function routedFetch(handler: (url: string, init?: RequestInit) => { status: number; body?: unknown }): RecordedCall[] {
    const calls: RecordedCall[] = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        calls.push({
            method: init?.method ?? "GET",
            url,
            body: typeof init?.body === "string" ? init.body : "",
        });
        const r = handler(url, init);
        return new Response(r.body !== undefined ? JSON.stringify(r.body) : null, {
            status: r.status,
            headers: { "content-type": "application/json" },
        });
    }) as typeof fetch;
    return calls;
}

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

    test("delivery asks the relay to wake an offline session (wakeSession flag)", async () => {
        setupEnv();
        const calls = mockFetch([200]);
        service = new TimeService([10, 20]);

        service.reconcileSubscriptions([
            entry("sess-1", "time:timer_fired", { duration: "0.01s" }, "sub-1"),
        ]);

        await new Promise((resolve) => setTimeout(resolve, 40));
        const fire = posts(calls)[0];
        expect(fire).toBeDefined();
        expect(JSON.parse(fire!.body).wakeSession).toBe(true);
    });

    test("session gone (404): starts a replacement session with the instruction as prompt and settles", async () => {
        setupEnv();
        const calls = routedFetch((url) => {
            if (url.includes("/api/runners/spawn")) return { status: 200, body: { ok: true, sessionId: "replacement-1" } };
            return { status: 404 };
        });
        service = new TimeService([10, 20]);

        service.reconcileSubscriptions([
            entry("sess-1", "time:timer_fired", { duration: "0.01s", message: "Check the build", _cwd: "/tmp/proj", _resumePath: "/tmp/proj/sess-1.jsonl" }, "sub-1"),
        ]);

        await new Promise((resolve) => setTimeout(resolve, 80));
        const spawns = toUrl(posts(calls), "/api/runners/spawn");
        expect(spawns).toHaveLength(1);
        const spawnBody = JSON.parse(spawns[0]!.body);
        expect(spawnBody.runnerId).toBe("runner-test");
        expect(spawnBody.cwd).toBe("/tmp/proj");
        expect(spawnBody.prompt).toContain("Check the build");
        // The replacement resumes the scheduling session's transcript, so it
        // wakes up with the conversation that set the timer.
        expect(spawnBody.resumePath).toBe("/tmp/proj/sess-1.jsonl");
        // Settled — exactly one trigger attempt, no retries.
        expect(toUrl(posts(calls), "/trigger")).toHaveLength(1);
        // The dead subscription is retired once a live session owns the work,
        // or it would re-arm on the next reconnect snapshot and spawn again.
        expect(deletes(calls)).toHaveLength(1);
        expect(deletes(calls)[0]!.url).toContain("subscriptionId=sub-1");
    });

    test("session gone and the spawn is rejected permanently (4xx): retries once without cwd, then gives up", async () => {
        setupEnv();
        const calls = routedFetch((url) => {
            // e.g. the schedule's workspace was deleted, so cwd is rejected.
            if (url.includes("/api/runners/spawn")) return { status: 400, body: { error: "Runner cannot access cwd" } };
            return { status: 404 };
        });
        service = new TimeService([10, 20]);

        service.reconcileSubscriptions([
            entry("sess-1", "time:timer_fired", { duration: "0.01s", message: "Check the build", _cwd: "/tmp/deleted" }, "sub-1"),
        ]);

        await new Promise((resolve) => setTimeout(resolve, 120));
        const spawns = toUrl(posts(calls), "/api/runners/spawn");
        // Two attempts: with the recorded cwd, then once without it.
        expect(spawns).toHaveLength(2);
        expect(JSON.parse(spawns[0]!.body).cwd).toBe("/tmp/deleted");
        expect(JSON.parse(spawns[1]!.body).cwd).toBeUndefined();
        // Then it stops: no endless 30-minute retry loop against a spawn that
        // cannot succeed. One delivery attempt, and the subscription is left in
        // place so the schedule stays visible and cancellable.
        expect(toUrl(posts(calls), "/trigger")).toHaveLength(1);
        expect(deletes(calls)).toHaveLength(0);
    });

    test("session gone but replacement spawn fails: retries instead of dropping the schedule", async () => {
        setupEnv();
        const calls = routedFetch((url) => {
            if (url.includes("/api/runners/spawn")) return { status: 502 };
            return { status: 404 };
        });
        service = new TimeService([10, 20]);

        service.reconcileSubscriptions([
            entry("sess-1", "time:timer_fired", { duration: "0.01s", message: "Check the build" }, "sub-1"),
        ]);

        await new Promise((resolve) => setTimeout(resolve, 80));
        expect(toUrl(posts(calls), "/trigger").length).toBeGreaterThan(1); // re-armed and retried
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

    test("subscription removal is retried on transient failure (a lost removal resurrects the schedule)", async () => {
        setupEnv();
        let deleteCount = 0;
        const calls = routedFetch((url, init) => {
            const method = init?.method ?? "GET";
            if (method === "POST" && url.endsWith("/trigger")) return { status: 200 };
            if (method === "DELETE") {
                deleteCount++;
                return { status: deleteCount < 3 ? 503 : 200 };
            }
            return { status: 404 };
        });
        service = new TimeService([10, 20], 30_000, 15_000, 5); // 5ms removal-retry delay

        service.reconcileSubscriptions([
            entry("sess-1", "time:timer_fired", { duration: "0.01s" }, "sub-1"),
        ]);

        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(deletes(calls)).toHaveLength(3); // 503, 503, 200
    });

    test("a snapshot re-apply during an in-flight one-shot fire does not double-fire", async () => {
        setupEnv();
        let posts = 0;
        globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
            const method = init?.method ?? "GET";
            const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
            if (method === "POST" && url.endsWith("/trigger")) {
                posts++;
                await new Promise((resolve) => setTimeout(resolve, 40)); // delivery in flight
                return new Response(null, { status: 200 });
            }
            return new Response(null, { status: 200 }); // DELETE etc.
        }) as typeof fetch;
        service = new TimeService([10, 20], 30_000, 15_000, 5);

        const sub = entry("sess-1", "time:timer_fired", { duration: "0.01s" }, "sub-1");
        service.reconcileSubscriptions([sub]);
        await new Promise((resolve) => setTimeout(resolve, 15)); // fired, delivery in flight
        service.reconcileSubscriptions([sub]); // snapshot re-apply mid-flight
        await new Promise((resolve) => setTimeout(resolve, 120));
        expect(posts).toBe(1);
    });

    test("schedule deliveries carry a stable fireId across retries", async () => {
        setupEnv();
        const calls = mockFetch([503, 200]);
        service = new TimeService([10, 20]);

        service.reconcileSubscriptions([
            entry("sess-1", "time:timer_fired", { duration: "0.01s" }, "sub-1"),
        ]);

        await new Promise((resolve) => setTimeout(resolve, 80));
        const fired = posts(calls);
        expect(fired).toHaveLength(2);
        const first = JSON.parse(fired[0]!.body).fireId;
        expect(typeof first).toBe("string");
        expect(JSON.parse(fired[1]!.body).fireId).toBe(first); // same fire, retried — not a new fire id
    });

    test("a legacy type-wide unsubscribe delta disarms every cron the session holds", async () => {
        const home = setupEnv();
        routedFetch(() => ({ status: 503 })); // deliveries would fail — schedule must be DISARMED, not retrying
        service = new TimeService([10, 20], 10, 15_000, 5);

        service.reconcileSubscriptions([
            entry("sess-1", "time:cron", { cron: "0 9 * * *", message: "a" }, "sub-a"),
            entry("sess-1", "time:cron", { cron: "0 12 * * *", message: "b" }, "sub-b"),
        ]);
        expect(JSON.parse(readFileSync(join(home, ".pizzapi", "time-service-state.json"), "utf-8"))).toEqual({
            "sub-a": expect.anything(),
            "sub-b": expect.anything(),
        });

        // Type-wide DELETE without subscriptionId: server emits ONE synthetic delta.
        service.reconcileSubscriptions([
            entry("sess-1", "time:cron", undefined, "legacy:all:time:cron"),
        ], { mode: "delta", action: "unsubscribe" });

        // Both durable entries dropped — both crons disarmed.
        expect(JSON.parse(readFileSync(join(home, ".pizzapi", "time-service-state.json"), "utf-8"))).toEqual({});
    });

    test("cron owner gone: spawns a replacement session, re-owns the cron under it, and stops the old cron", async () => {
        const home = setupEnv();
        const calls = routedFetch((url) => {
            if (url.includes("/api/runners/spawn")) return { status: 200, body: { ok: true, sessionId: "replacement-2" } };
            if (url.includes("/trigger-subscriptions")) return { status: 200, body: { ok: true, subscriptionId: "sub-new" } };
            return { status: 404 };
        });
        writeFileSync(
            join(home, ".pizzapi", "time-service-state.json"),
            JSON.stringify({ "sub-cron": { nextFireAt: Date.now() - 1000, iteration: 2 } }),
            "utf-8",
        );
        service = new TimeService([10, 20], 10);

        service.reconcileSubscriptions([
            entry("sess-1", "time:cron", { cron: "0 0 * * *", message: "daily standup", _cwd: "/tmp/proj", _resumePath: "/tmp/proj/sess-1.jsonl" }, "sub-cron"),
        ]);

        await new Promise((resolve) => setTimeout(resolve, 100));
        const spawns = toUrl(posts(calls), "/api/runners/spawn");
        expect(spawns).toHaveLength(1);
        expect(JSON.parse(spawns[0]!.body).prompt).toContain("daily standup");
        expect(JSON.parse(spawns[0]!.body).resumePath).toBe("/tmp/proj/sess-1.jsonl");

        // The recurring schedule is re-owned by the replacement session.
        const resubs = toUrl(posts(calls), "/api/sessions/replacement-2/trigger-subscriptions");
        expect(resubs).toHaveLength(1);
        const resubBody = JSON.parse(resubs[0]!.body);
        expect(resubBody.triggerType).toBe("time:cron");
        expect(resubBody.params.cron).toBe("0 0 * * *");
        expect(resubBody.params._cwd).toBe("/tmp/proj");
        // Resume appends to the same transcript, so the migrated cron keeps
        // pointing at it and every future wake continues the same thread.
        expect(resubBody.params._resumePath).toBe("/tmp/proj/sess-1.jsonl");

        // Old durable state dropped and the old cron stops firing.
        expect(JSON.parse(readFileSync(join(home, ".pizzapi", "time-service-state.json"), "utf-8")).hasOwnProperty("sub-cron")).toBe(false);
        const fires = posts(calls).filter((c) => c.url.endsWith("/trigger"));
        expect(fires).toHaveLength(1);

        // The old subscription is retired. Leaving it would restore it on the
        // next reconnect snapshot, re-arm this cron against a dead session and
        // migrate again — one extra subscription and session per restart.
        const cleanup = deletes(calls);
        expect(cleanup).toHaveLength(1);
        expect(cleanup[0]!.url).toContain("subscriptionId=sub-cron");
    });

    test("cron migration whose handover fails keeps the recurrence instead of downgrading to a one-off", async () => {
        const home = setupEnv();
        const calls = routedFetch((url) => {
            if (url.includes("/api/runners/spawn")) return { status: 200, body: { ok: true, sessionId: "replacement-3" } };
            // Handing the recurrence to the new session keeps failing (5xx).
            if (url.includes("/trigger-subscriptions")) return { status: 503 };
            return { status: 404 };
        });
        writeFileSync(
            join(home, ".pizzapi", "time-service-state.json"),
            JSON.stringify({ "sub-cron": { nextFireAt: Date.now() - 1000, iteration: 0 } }),
            "utf-8",
        );
        service = new TimeService([5, 5], 10);

        service.reconcileSubscriptions([
            entry("sess-1", "time:cron", { cron: "0 0 * * *", message: "nightly" }, "sub-cron"),
        ]);

        await new Promise((resolve) => setTimeout(resolve, 150));
        // The fire itself was handled by a replacement session...
        expect(toUrl(posts(calls), "/api/runners/spawn")).toHaveLength(1);
        // ...the handover was retried rather than abandoned after one failure...
        expect(toUrl(posts(calls), "/trigger-subscriptions").length).toBeGreaterThan(1);
        // ...and the original subscription is NOT retired, so the schedule still
        // exists and will retry the handover on its next fire.
        expect(deletes(calls)).toHaveLength(0);
        const state = JSON.parse(readFileSync(join(home, ".pizzapi", "time-service-state.json"), "utf-8"));
        expect(state.hasOwnProperty("sub-cron")).toBe(true);
        expect(state["sub-cron"].nextFireAt).toBeGreaterThan(Date.now());
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

    test("a hung delivery times out and retries instead of wedging the cron", async () => {
        const home = setupEnv();
        let calls = 0;
        // A fetch that never resolves on its own — it only rejects when the
        // delivery timeout aborts the signal. Without the timeout, the cron's
        // `delivering` flag would stay true forever and it would never fire again.
        globalThis.fetch = ((_input: string | URL | Request, init?: RequestInit) => {
            calls++;
            return new Promise((_resolve, reject) => {
                init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
            });
        }) as typeof fetch;
        writeFileSync(
            join(home, ".pizzapi", "time-service-state.json"),
            JSON.stringify({ "sub-cron": { nextFireAt: Date.now() - 1000, iteration: 0 } }),
            "utf-8",
        );
        service = new TimeService([10, 20], 10, 20); // 10ms check interval, 20ms delivery timeout

        service.reconcileSubscriptions([
            entry("sess-1", "time:cron", { cron: "0 0 * * *" }, "sub-cron"),
        ]);

        await new Promise((resolve) => setTimeout(resolve, 120));
        // Timed out and retried (not wedged on the first in-flight delivery).
        expect(calls).toBeGreaterThan(1);
    });
});
