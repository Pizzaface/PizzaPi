/**
 * Durability properties for schedules (ADR-0002: routes ARE the subscriptions).
 *
 * These are written as "a schedule survives X" rather than "function Y works",
 * because every hole found so far was a lifecycle event nobody had enumerated:
 * the reconnect snapshot ignored offline sessions, the orphan sweep deleted
 * subscriptions ~2 min after a worker died, and a relay redeploy wiped Redis
 * (which runs with `--save "" --appendonly no`) and handed the runner an
 * authoritative empty snapshot that made it bin its own timers.
 *
 * X is enumerated here: runner restart, owning session ending, relay redeploy.
 * Plus the inverse property — cancellation must survive too, or durability
 * would resurrect work the user stopped.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { RedisMemoryServer } from "redis-memory-server";
import { randomUUID } from "node:crypto";
import { createTestServer } from "./harness/server.js";
import { createMockRunner } from "./harness/mock-runner.js";
import { createMockRelay } from "./harness/mock-relay.js";
import type { TestServer } from "./harness/types.js";
import { endSharedSession } from "../src/ws/sio-registry.js";
import { runWithAuthContext } from "../src/auth.js";
import type { AuthContext } from "../src/auth.js";

const TEST_TIMEOUT = 30_000;

/**
 * Run a DB-backed call the way the server does. Without the auth context
 * durable store calls silently no-op.
 */
function withAuth<T>(ctx: AuthContext, fn: () => Promise<T>): Promise<T> {
    return runWithAuthContext(ctx, fn);
}

/** Same graceful shutdown as mock-runner.test.ts — see comments there. */
async function cleanupServer(server: TestServer): Promise<void> {
    await server.io.disconnectSockets(true);
    await new Promise<void>((r) => setTimeout(r, 100));
    const httpServer = (server.io as unknown as { httpServer?: { closeIdleConnections?(): void } }).httpServer;
    if (typeof httpServer?.closeIdleConnections === "function") {
        httpServer.closeIdleConnections();
    }
    await server.cleanup();
}

async function waitFor(cond: () => boolean, timeoutMs = 5_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!cond()) {
        if (Date.now() > deadline) throw new Error("Timed out waiting for condition");
        await new Promise((r) => setTimeout(r, 25));
    }
}

/**
 * Tear down mock runners/relays in reverse order, always.
 *
 * Inline `await runner.disconnect()` at the end of a test is skipped when an
 * assertion fails, which leaves a live socket and makes server cleanup hang
 * until the 30s test timeout — so a real regression reports as an opaque
 * timeout instead of the assertion that caught it.
 */
async function disposeAll(disposers: Array<() => Promise<void>>): Promise<void> {
    for (const dispose of [...disposers].reverse()) {
        try { await dispose(); } catch { /* teardown is best-effort */ }
    }
}

/** Create a session-target route through the real HTTP surface. */
async function createRoute(
    server: TestServer,
    body: Record<string, unknown>,
): Promise<{ routeId: string }> {
    const res = await server.fetch("/api/routes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`route creation failed: ${res.status} ${await res.text()}`);
    const json = (await res.json()) as { route: { routeId: string } };
    return { routeId: json.route.routeId };
}

describe("schedule durability (routes)", () => {
    // createTestServer() defaults to redis://localhost:6379 — a real, possibly
    // production Redis. Run an isolated in-memory Redis for this suite instead,
    // exactly like browser-smoke.test.ts does.
    const previousRedisUrl = process.env.PIZZAPI_REDIS_URL;
    let redisServer: RedisMemoryServer | undefined;

    beforeAll(async () => {
        redisServer = await RedisMemoryServer.create({
            instance: { ip: "127.0.0.1", port: 0 },
            autoStart: true,
        } as any);
        const redisHost = await redisServer.getHost();
        const redisPort = await redisServer.getPort();
        process.env.PIZZAPI_REDIS_URL = `redis://${redisHost}:${redisPort}`;
    }, TEST_TIMEOUT);

    afterAll(async () => {
        if (previousRedisUrl === undefined) delete process.env.PIZZAPI_REDIS_URL;
        else process.env.PIZZAPI_REDIS_URL = previousRedisUrl;
        try {
            await redisServer?.stop();
        } catch { /* ignore */ }
    });

    test("survives a runner restart while its session is offline", async () => {
        const server = await createTestServer();
        const runnerId = `runner-sched-${randomUUID().slice(0, 8)}`;
        const runnerSecret = "sched-test-secret";
        const otherRunnerId = `runner-other-${randomUUID().slice(0, 8)}`;
        let offlineSessionId = "";
        let otherSessionId = "";
        const disposers: Array<() => Promise<void>> = [];
        try {
            const relay = await createMockRelay(server);
            disposers.push(() => relay.disconnect());
            const first = await createMockRunner(server, { runnerId, runnerSecret, name: "sched-runner" });
            disposers.push(() => first.disconnect());
            expect(first.runnerId).toBe(runnerId);

            // A session subscribes to a schedule on this runner, then its worker
            // exits — the same shape as a finished task.
            offlineSessionId = (await relay.registerSession({ cwd: "/tmp/offline" })).sessionId;
            const { routeId } = await createRoute(server, {
                eventType: "time:cron",
                target: { kind: "session", sessionId: offlineSessionId, runnerId: runnerId },
                deliverAs: "followUp",
                params: { cron: "0 9 * * *", message: "daily standup" },
            });
            // A route bound to a DIFFERENT runner must not leak into this
            // runner's snapshot.
            const otherRunner = await createMockRunner(server, { runnerId: otherRunnerId, runnerSecret: "other-secret", name: "other-runner" });
            disposers.push(() => otherRunner.disconnect());
            otherSessionId = (await relay.registerSession({ cwd: "/tmp/other" })).sessionId;
            await createRoute(server, {
                eventType: "svc:event",
                target: { kind: "session", sessionId: otherSessionId, runnerId: otherRunnerId },
                deliverAs: "followUp",
            });
            // The schedule's owner goes offline before the restart.
            await withAuth(server.authContext, () => endSharedSession(offlineSessionId, "Session ended"));

            const second = await createMockRunner(server, { runnerId, runnerSecret, name: "sched-runner" });
            disposers.push(() => second.disconnect());

            await waitFor(() => second.getTriggerSubscriptionSnapshots().length > 0);
            const snapshot = second.getTriggerSubscriptionSnapshots()[0];
            expect(snapshot.isReconnect).toBe(true);

            const cronSub = snapshot.subscriptions.find(
                (s) => s.sessionId === offlineSessionId && s.triggerType === "time:cron",
            ) as { runnerId: string; params?: Record<string, unknown> } | undefined;
            expect(cronSub).toBeDefined();
            expect(cronSub!.runnerId).toBe(runnerId);
            expect(cronSub!.params!.cron).toBe("0 9 * * *");

            expect(snapshot.subscriptions.find((s) => (s as { runnerId?: string }).runnerId === otherRunnerId)).toBeUndefined();
            // cleanup: remove the schedule route
            await server.fetch(`/api/routes/${encodeURIComponent(routeId)}`, { method: "DELETE" });
        } finally {
            await disposeAll(disposers);
            await cleanupServer(server);
        }
    }, TEST_TIMEOUT);

    test("survives its owning session ending, and is restored on runner restart", async () => {
        const server = await createTestServer();
        const runnerId = `runner-end-${randomUUID().slice(0, 8)}`;
        const runnerSecret = "end-test-secret";
        let sessionId = "";
        const disposers: Array<() => Promise<void>> = [];
        try {
            const first = await createMockRunner(server, { runnerId, runnerSecret, name: "end-runner" });
            disposers.push(() => first.disconnect());

            const relay = await createMockRelay(server);
            disposers.push(() => relay.disconnect());
            sessionId = (await relay.registerSession({ cwd: "/tmp/test" })).sessionId;
            const { routeId } = await createRoute(server, {
                eventType: "time:cron",
                target: { kind: "session", sessionId, runnerId: runnerId },
                deliverAs: "followUp",
                params: { cron: "0 9 * * *", message: "daily standup" },
            });

            // The session ends — the same path the orphan sweep takes ~2 minutes
            // after a worker dies. Routes are durable by design: the schedule
            // outlives the session.
            await withAuth(server.authContext, () => endSharedSession(sessionId, "Session ended"));

            // ...and it stays visible over HTTP (the runner schedules surface),
            // even though the live session record is gone — an unlistable
            // schedule is an uncancellable one.
            const listRes = await server.fetch(`/api/runners/${runnerId}/schedules`);
            expect(listRes.status).toBe(200);
            const listed = await listRes.json() as { schedules: Array<{ subscriptionId: string; triggerType: string }> };
            expect(listed.schedules.map((s) => s.triggerType)).toEqual(["time:cron"]);
            const second = await createMockRunner(server, { runnerId, runnerSecret, name: "end-runner" });
            disposers.push(() => second.disconnect());
            await waitFor(() => second.getTriggerSubscriptionSnapshots().length > 0);
            const cronSub = second.getTriggerSubscriptionSnapshots()[0].subscriptions.find(
                (s) => s.sessionId === sessionId && s.triggerType === "time:cron",
            ) as { params?: Record<string, unknown> } | undefined;
            expect(cronSub).toBeDefined();
            expect(cronSub!.params!.message).toBe("daily standup");
            await server.fetch(`/api/routes/${encodeURIComponent(routeId)}`, { method: "DELETE" });
        } finally {
            await disposeAll(disposers);
            await cleanupServer(server);
        }
    }, TEST_TIMEOUT);

    test("survives a relay redeploy that wipes Redis", async () => {
        const server = await createTestServer();
        const runnerId = `runner-redeploy-${randomUUID().slice(0, 8)}`;
        const runnerSecret = "redeploy-secret";
        let sessionId = "";
        const disposers: Array<() => Promise<void>> = [];
        try {
            const first = await createMockRunner(server, { runnerId, runnerSecret, name: "redeploy-runner" });
            disposers.push(() => first.disconnect());
            const relay = await createMockRelay(server);
            disposers.push(() => relay.disconnect());
            sessionId = (await relay.registerSession({ cwd: "/tmp/test" })).sessionId;
            const { routeId } = await createRoute(server, {
                eventType: "time:cron",
                target: { kind: "session", sessionId, runnerId: runnerId },
                deliverAs: "followUp",
                params: { cron: "0 9 * * *", message: "weekly report" },
            });

            // The redeploy: Redis restarts empty; the routes live in SQLite.
            // The runner reconnects and the snapshot is rebuilt straight from
            // durable routes — it can never be handed an authoritative empty
            // snapshot that would make it drop the cron and discard its
            // persisted cron state.
            const second = await createMockRunner(server, { runnerId, runnerSecret, name: "redeploy-runner" });
            disposers.push(() => second.disconnect());
            await waitFor(() => second.getTriggerSubscriptionSnapshots().length > 0);

            const cronSub = second.getTriggerSubscriptionSnapshots()[0].subscriptions.find(
                (s) => s.sessionId === sessionId && s.triggerType === "time:cron",
            ) as { params?: Record<string, unknown> } | undefined;
            expect(cronSub).toBeDefined();
            expect(cronSub!.params!.message).toBe("weekly report");
            await server.fetch(`/api/routes/${encodeURIComponent(routeId)}`, { method: "DELETE" });
        } finally {
            await disposeAll(disposers);
            await cleanupServer(server);
        }
    }, TEST_TIMEOUT);

    test("a cancelled schedule is NOT resurrected by a redeploy", async () => {
        const server = await createTestServer();
        const runnerId = `runner-cancelled-${randomUUID().slice(0, 8)}`;
        const runnerSecret = "cancelled-secret";
        let sessionId = "";
        const disposers: Array<() => Promise<void>> = [];
        try {
            const first = await createMockRunner(server, { runnerId, runnerSecret, name: "cancelled-runner" });
            disposers.push(() => first.disconnect());
            const relay = await createMockRelay(server);
            disposers.push(() => relay.disconnect());
            sessionId = (await relay.registerSession({ cwd: "/tmp/test" })).sessionId;
            const { routeId } = await createRoute(server, {
                eventType: "time:cron",
                target: { kind: "session", sessionId, runnerId: runnerId },
                deliverAs: "followUp",
                params: { cron: "0 9 * * *" },
            });

            // The user cancels it, then the runner reconnects.
            const cancelRes = await server.fetch(`/api/routes/${encodeURIComponent(routeId)}`, { method: "DELETE" });
            expect(cancelRes.status).toBe(200);

            const second = await createMockRunner(server, { runnerId, runnerSecret, name: "cancelled-runner" });
            disposers.push(() => second.disconnect());
            await waitFor(() => second.getTriggerSubscriptionSnapshots().length > 0);

            // Durability must not undo a cancellation.
            expect(second.getTriggerSubscriptionSnapshots()[0].subscriptions).toHaveLength(0);
        } finally {
            await disposeAll(disposers);
            await cleanupServer(server);
        }
    }, TEST_TIMEOUT);

    test("runner-scoped listing shows schedules regardless of session age or liveness", async () => {
        const server = await createTestServer();
        const runnerId = `runner-list-${randomUUID().slice(0, 8)}`;
        let liveSessionId = "";
        let endedSessionId = "";
        const disposers: Array<() => Promise<void>> = [];
        try {
            const runner = await createMockRunner(server, { runnerId, runnerSecret: "list-secret", name: "list-runner" });
            disposers.push(() => runner.disconnect());
            const relay = await createMockRelay(server);
            disposers.push(() => relay.disconnect());

            liveSessionId = (await relay.registerSession({ cwd: "/tmp/live" })).sessionId;
            endedSessionId = (await relay.registerSession({ cwd: "/tmp/ended" })).sessionId;

            const liveRoute = await createRoute(server, {
                eventType: "time:cron",
                target: { kind: "session", sessionId: liveSessionId, runnerId: runnerId },
                deliverAs: "followUp",
                params: { cron: "0 9 * * *" },
            });
            const endedRoute = await createRoute(server, {
                eventType: "time:at",
                target: { kind: "session", sessionId: endedSessionId, runnerId: runnerId },
                deliverAs: "followUp",
                params: { at: "14:30UTC" },
            });
            // Non-schedule routes must not appear on the schedule surface.
            await createRoute(server, {
                eventType: "github:pr_comment",
                target: { kind: "session", sessionId: liveSessionId, runnerId: runnerId },
                deliverAs: "followUp",
            });

            // One owner ends — its schedule is exactly what a per-session
            // fan-out would have missed.
            await withAuth(server.authContext, () => endSharedSession(endedSessionId, "Session ended"));

            const res = await server.fetch(`/api/runners/${runnerId}/schedules`);
            expect(res.status).toBe(200);
            const body = await res.json() as {
                schedules: Array<{ sessionId: string; triggerType: string; cwd: string | null; sessionLive: boolean }>;
            };

            expect(body.schedules.map((s) => s.triggerType).sort()).toEqual(["time:at", "time:cron"]);
            const ownerless = body.schedules.find((s) => s.sessionId === endedSessionId)!;
            expect(ownerless).toBeDefined();
            expect(ownerless.sessionLive).toBe(false);
            // cwd comes from the persisted session row, so the UI can still place
            // an ownerless schedule in its workspace.
            expect(ownerless.cwd).toBe("/tmp/ended");
            expect(body.schedules.find((s) => s.sessionId === liveSessionId)!.sessionLive).toBe(true);

            for (const id of [liveRoute.routeId, endedRoute.routeId]) {
                await server.fetch(`/api/routes/${encodeURIComponent(id)}`, { method: "DELETE" });
            }
        } finally {
            await disposeAll(disposers);
            await cleanupServer(server);
        }
    }, TEST_TIMEOUT);

    test("a schedule owned by an ended session can still be cancelled over HTTP", async () => {
        const server = await createTestServer();
        const runnerId = `runner-cancel-${randomUUID().slice(0, 8)}`;
        let sessionId = "";
        const disposers: Array<() => Promise<void>> = [];
        try {
            const runner = await createMockRunner(server, { runnerId, runnerSecret: "cancel-secret", name: "cancel-runner" });
            disposers.push(() => runner.disconnect());
            const relay = await createMockRelay(server);
            disposers.push(() => relay.disconnect());
            sessionId = (await relay.registerSession({ cwd: "/tmp/test" })).sessionId;
            const { routeId } = await createRoute(server, {
                eventType: "time:cron",
                target: { kind: "session", sessionId, runnerId: runnerId },
                deliverAs: "followUp",
                params: { cron: "0 9 * * *" },
            });
            await withAuth(server.authContext, () => endSharedSession(sessionId, "Session ended"));

            // The live session record is gone: management authorization falls
            // back through the route's stamped runner owner.
            const cancelRes = await server.fetch(`/api/routes/${encodeURIComponent(routeId)}`, { method: "DELETE" });
            expect(cancelRes.status).toBe(200);

            const after = await (await server.fetch("/api/routes?eventType=time:cron")).json() as {
                routes: Array<{ routeId: string; target: { kind: string; sessionId?: string } }>;
            };
            expect(after.routes.filter((r) => r.target.kind === "session" && r.target.sessionId === sessionId)).toHaveLength(0);
        } finally {
            await disposeAll(disposers);
            await cleanupServer(server);
        }
    }, TEST_TIMEOUT);
});