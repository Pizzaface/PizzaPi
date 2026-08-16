/**
 * Integration test: trigger subscription snapshot after a runner reconnect
 * includes subscriptions owned by OFFLINE sessions.
 *
 * Regression test for "schedules aren't persisted after runner restart":
 * the reconnect snapshot used to be built only from sessions whose TUI socket
 * was connected, so a time:cron owned by an offline task silently stopped
 * firing after a daemon restart even though its subscription (and durable
 * cron state) still existed.
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
} from "../src/sessions/trigger-subscription-store.js";
import { endSharedSession } from "../src/ws/sio-registry.js";

const TEST_TIMEOUT = 30_000;

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

describe("trigger subscription snapshot — offline sessions", () => {
    test("reconnect snapshot includes subscriptions of sessions that are not connected", async () => {
        const server = await createTestServer();
        const runnerId = `runner-sched-${randomUUID().slice(0, 8)}`;
        const runnerSecret = "sched-test-secret";
        const offlineSessionId = `offline-sess-${randomUUID().slice(0, 8)}`;
        try {
            // First connection establishes the persistent runner identity.
            const first = await createMockRunner(server, { runnerId, runnerSecret, name: "sched-runner" });
            expect(first.runnerId).toBe(runnerId);

            // A session subscribed to a schedule on this runner... then it goes
            // offline (no TUI socket was ever connected for it — same shape as a
            // finished task whose worker exited).
            await subscribeSessionToTrigger(
                offlineSessionId,
                runnerId,
                "time:cron",
                undefined,
                { cron: "0 9 * * *", message: "daily standup" },
            );
            // A subscription bound to a DIFFERENT runner must not leak into this
            // runner's snapshot.
            await subscribeSessionToTrigger(offlineSessionId, "some-other-runner", "svc:event");

            // Runner restart.
            await first.disconnect();
            const second = await createMockRunner(server, { runnerId, runnerSecret, name: "sched-runner" });
            expect(second.runnerId).toBe(runnerId);

            await waitFor(() => second.getTriggerSubscriptionSnapshots().length > 0);
            const snapshot = second.getTriggerSubscriptionSnapshots()[0];
            expect(snapshot.isReconnect).toBe(true);

            const cronSub = snapshot.subscriptions.find(
                (s) => s.sessionId === offlineSessionId && s.triggerType === "time:cron",
            );
            expect(cronSub).toBeDefined();
            expect(cronSub!.runnerId).toBe(runnerId);
            expect((cronSub!.params as Record<string, unknown>).cron).toBe("0 9 * * *");

            // No cross-runner leakage.
            const leaked = snapshot.subscriptions.find((s) => s.runnerId === "some-other-runner");
            expect(leaked).toBeUndefined();

            await second.disconnect();
        } finally {
            await clearSessionSubscriptions(offlineSessionId);
            await cleanupServer(server);
        }
    }, TEST_TIMEOUT);

    test("a schedule survives its owning session ending and is restored on runner restart", async () => {
        const server = await createTestServer();
        const runnerId = `runner-end-${randomUUID().slice(0, 8)}`;
        const runnerSecret = "end-test-secret";
        let sessionId = "";
        try {
            const first = await createMockRunner(server, { runnerId, runnerSecret, name: "end-runner" });

            // A real session, with a standing schedule plus an ordinary subscription.
            const relay = await createMockRelay(server);
            const registered = await relay.registerSession({ cwd: "/tmp/test" });
            sessionId = registered.sessionId;
            await subscribeSessionToTrigger(sessionId, runnerId, "time:cron", undefined, { cron: "0 9 * * *", message: "daily standup" });
            await subscribeSessionToTrigger(sessionId, runnerId, "github:pr_comment");

            // The session ends (same path the orphan sweep takes when a worker dies).
            await endSharedSession(sessionId, "Session ended");

            // The schedule outlives it; the ordinary subscription does not.
            const surviving = await listSessionSubscriptions(sessionId);
            expect(surviving.map((s) => s.triggerType)).toEqual(["time:cron"]);

            // ...and it stays visible over HTTP (the schedule UI's fan-out), even
            // though the live session record is gone — an unlistable schedule is
            // an uncancellable one.
            const listRes = await server.fetch(`/api/sessions/${sessionId}/trigger-subscriptions`);
            expect(listRes.status).toBe(200);
            const listed = await listRes.json() as { subscriptions: Array<{ triggerType: string }> };
            expect(listed.subscriptions.map((s) => s.triggerType)).toEqual(["time:cron"]);

            // Runner restart still rebuilds the schedule.
            await relay.disconnect();
            await first.disconnect();
            const second = await createMockRunner(server, { runnerId, runnerSecret, name: "end-runner" });
            await waitFor(() => second.getTriggerSubscriptionSnapshots().length > 0);
            const snapshot = second.getTriggerSubscriptionSnapshots()[0];
            const cronSub = snapshot.subscriptions.find(
                (s) => s.sessionId === sessionId && s.triggerType === "time:cron",
            );
            expect(cronSub).toBeDefined();
            expect((cronSub!.params as Record<string, unknown>).message).toBe("daily standup");

            await second.disconnect();
        } finally {
            if (sessionId) await clearSessionSubscriptions(sessionId);
            await cleanupServer(server);
        }
    }, TEST_TIMEOUT);

    test("a schedule owned by an ended session can still be cancelled over HTTP", async () => {
        const server = await createTestServer();
        const runnerId = `runner-cancel-${randomUUID().slice(0, 8)}`;
        let sessionId = "";
        try {
            const runner = await createMockRunner(server, { runnerId, runnerSecret: "cancel-secret", name: "cancel-runner" });
            const relay = await createMockRelay(server);
            const registered = await relay.registerSession({ cwd: "/tmp/test" });
            sessionId = registered.sessionId;
            await subscribeSessionToTrigger(sessionId, runnerId, "time:cron", undefined, { cron: "0 9 * * *" });
            await endSharedSession(sessionId, "Session ended");

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

            await relay.disconnect();
            await runner.disconnect();
        } finally {
            if (sessionId) await clearSessionSubscriptions(sessionId);
            await cleanupServer(server);
        }
    }, TEST_TIMEOUT);
});
