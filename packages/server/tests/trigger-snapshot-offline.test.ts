/**
 * Durability properties for schedules.
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

import { describe, test, expect } from "bun:test";
import { randomUUID } from "node:crypto";
import { createTestServer } from "./harness/server.js";
import { createMockRunner } from "./harness/mock-runner.js";
import { createMockRelay } from "./harness/mock-relay.js";
import type { TestServer } from "./harness/types.js";
import {
    subscribeSessionToTrigger,
    listSessionSubscriptions,
    clearSessionSubscriptions,
    unsubscribeSessionSubscription,
    _dropRedisCacheForTesting,
} from "../src/sessions/trigger-subscription-store.js";
import { endSharedSession } from "../src/ws/sio-registry.js";
import { runWithAuthContext } from "../src/auth.js";
import type { AuthContext } from "../src/auth.js";

const TEST_TIMEOUT = 30_000;

/**
 * Run a DB-backed store call the way the server does. Without the auth context
 * the durable mirror silently no-ops (writes are best-effort), which would make
 * these tests pass or fail for the wrong reason.
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

describe("schedule durability", () => {
    test("survives a runner restart while its session is offline", async () => {
        const server = await createTestServer();
        const runnerId = `runner-sched-${randomUUID().slice(0, 8)}`;
        const runnerSecret = "sched-test-secret";
        const offlineSessionId = `offline-sess-${randomUUID().slice(0, 8)}`;
        const disposers: Array<() => Promise<void>> = [];
        try {
            const first = await createMockRunner(server, { runnerId, runnerSecret, name: "sched-runner" });
            disposers.push(() => first.disconnect());
            expect(first.runnerId).toBe(runnerId);

            // A session subscribed to a schedule on this runner, which is not
            // connected — the same shape as a finished task whose worker exited.
            await withAuth(server.authContext, () => subscribeSessionToTrigger(
                offlineSessionId, runnerId, "time:cron", undefined,
                { cron: "0 9 * * *", message: "daily standup" },
            ));
            // A subscription bound to a DIFFERENT runner must not leak into this
            // runner's snapshot.
            await withAuth(server.authContext, () => subscribeSessionToTrigger(offlineSessionId, "some-other-runner", "svc:event"));
            const second = await createMockRunner(server, { runnerId, runnerSecret, name: "sched-runner" });
            disposers.push(() => second.disconnect());

            await waitFor(() => second.getTriggerSubscriptionSnapshots().length > 0);
            const snapshot = second.getTriggerSubscriptionSnapshots()[0];
            expect(snapshot.isReconnect).toBe(true);

            const cronSub = snapshot.subscriptions.find(
                (s) => s.sessionId === offlineSessionId && s.triggerType === "time:cron",
            );
            expect(cronSub).toBeDefined();
            expect(cronSub!.runnerId).toBe(runnerId);
            expect((cronSub!.params as Record<string, unknown>).cron).toBe("0 9 * * *");

            expect(snapshot.subscriptions.find((s) => s.runnerId === "some-other-runner")).toBeUndefined();
        } finally {
            await withAuth(server.authContext, () => clearSessionSubscriptions(offlineSessionId));
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
            await withAuth(server.authContext, () => subscribeSessionToTrigger(
                sessionId, runnerId, "time:cron", undefined, { cron: "0 9 * * *", message: "daily standup" },
            ));
            await withAuth(server.authContext, () => subscribeSessionToTrigger(sessionId, runnerId, "github:pr_comment"));

            // The session ends — the same path the orphan sweep takes ~2 minutes
            // after a worker dies.
            await withAuth(server.authContext, () => endSharedSession(sessionId, "Session ended"));

            // The schedule outlives it; the ordinary subscription does not.
            expect((await listSessionSubscriptions(sessionId)).map((s) => s.triggerType)).toEqual(["time:cron"]);

            // ...and it stays visible over HTTP (the schedule UI's fan-out), even
            // though the live session record is gone — an unlistable schedule is
            // an uncancellable one.
            const listRes = await server.fetch(`/api/sessions/${sessionId}/trigger-subscriptions`);
            expect(listRes.status).toBe(200);
            const listed = await listRes.json() as { subscriptions: Array<{ triggerType: string }> };
            expect(listed.subscriptions.map((s) => s.triggerType)).toEqual(["time:cron"]);
            const second = await createMockRunner(server, { runnerId, runnerSecret, name: "end-runner" });
            disposers.push(() => second.disconnect());
            await waitFor(() => second.getTriggerSubscriptionSnapshots().length > 0);
            const cronSub = second.getTriggerSubscriptionSnapshots()[0].subscriptions.find(
                (s) => s.sessionId === sessionId && s.triggerType === "time:cron",
            );
            expect(cronSub).toBeDefined();
            expect((cronSub!.params as Record<string, unknown>).message).toBe("daily standup");
        } finally {
            if (sessionId) await withAuth(server.authContext, () => clearSessionSubscriptions(sessionId));
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
            await withAuth(server.authContext, () => subscribeSessionToTrigger(
                sessionId, runnerId, "time:cron", undefined, { cron: "0 9 * * *", message: "weekly report" },
            ));

            // The redeploy: Redis restarts empty, SQLite survives.
            await _dropRedisCacheForTesting();
            expect(await listSessionSubscriptions(sessionId)).toHaveLength(0);

            // The runner reconnects. Registration rehydrates from durable storage
            // BEFORE the snapshot is built, so the runner is never handed an
            // authoritative empty snapshot that would make it drop the cron and
            // discard its persisted cron state.
            const second = await createMockRunner(server, { runnerId, runnerSecret, name: "redeploy-runner" });
            disposers.push(() => second.disconnect());
            await waitFor(() => second.getTriggerSubscriptionSnapshots().length > 0);

            const cronSub = second.getTriggerSubscriptionSnapshots()[0].subscriptions.find(
                (s) => s.sessionId === sessionId && s.triggerType === "time:cron",
            );
            expect(cronSub).toBeDefined();
            expect((cronSub!.params as Record<string, unknown>).message).toBe("weekly report");
            // Redis is repopulated too, so the schedule is listable/cancellable again.
            expect(await listSessionSubscriptions(sessionId)).toHaveLength(1);
        } finally {
            if (sessionId) await withAuth(server.authContext, () => clearSessionSubscriptions(sessionId));
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
            await withAuth(server.authContext, () => subscribeSessionToTrigger(
                sessionId, runnerId, "time:cron", undefined, { cron: "0 9 * * *" },
            ));

            // The user cancels it, then the relay is redeployed.
            const [sub] = await listSessionSubscriptions(sessionId);
            await withAuth(server.authContext, () => unsubscribeSessionSubscription(sessionId, sub.subscriptionId));
            await _dropRedisCacheForTesting();

            const second = await createMockRunner(server, { runnerId, runnerSecret, name: "cancelled-runner" });
            disposers.push(() => second.disconnect());
            await waitFor(() => second.getTriggerSubscriptionSnapshots().length > 0);

            // Durability must not undo a cancellation.
            expect(second.getTriggerSubscriptionSnapshots()[0].subscriptions).toHaveLength(0);
            expect(await listSessionSubscriptions(sessionId)).toHaveLength(0);
        } finally {
            if (sessionId) await withAuth(server.authContext, () => clearSessionSubscriptions(sessionId));
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

            await withAuth(server.authContext, () => subscribeSessionToTrigger(
                liveSessionId, runnerId, "time:cron", undefined, { cron: "0 9 * * *" },
            ));
            await withAuth(server.authContext, () => subscribeSessionToTrigger(
                endedSessionId, runnerId, "time:at", undefined, { at: "14:30UTC" },
            ));
            // Non-schedule subscriptions must not appear on the schedule surface.
            await withAuth(server.authContext, () => subscribeSessionToTrigger(liveSessionId, runnerId, "github:pr_comment"));

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
            // cwd comes from the durable row, so the UI can still place an
            // ownerless schedule in its workspace.
            expect(ownerless.cwd).toBe("/tmp/ended");
            expect(body.schedules.find((s) => s.sessionId === liveSessionId)!.sessionLive).toBe(true);
        } finally {
            for (const id of [liveSessionId, endedSessionId]) {
                if (id) await withAuth(server.authContext, () => clearSessionSubscriptions(id));
            }
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
            await withAuth(server.authContext, () => subscribeSessionToTrigger(
                sessionId, runnerId, "time:cron", undefined, { cron: "0 9 * * *" },
            ));
            await withAuth(server.authContext, () => endSharedSession(sessionId, "Session ended"));

            const listed = await (await server.fetch(`/api/sessions/${sessionId}/trigger-subscriptions`)).json() as {
                subscriptions: Array<{ subscriptionId: string }>;
            };
            const subscriptionId = listed.subscriptions[0]!.subscriptionId;

            const cancelRes = await server.fetch(
                `/api/sessions/${sessionId}/trigger-subscriptions/${encodeURIComponent("time:cron")}?subscriptionId=${encodeURIComponent(subscriptionId)}`,
                { method: "DELETE" },
            );
            expect(cancelRes.status).toBe(200);
            expect(await listSessionSubscriptions(sessionId)).toHaveLength(0);
        } finally {
            if (sessionId) await withAuth(server.authContext, () => clearSessionSubscriptions(sessionId));
            await disposeAll(disposers);
            await cleanupServer(server);
        }
    }, TEST_TIMEOUT);
});
