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
import type { TestServer } from "./harness/types.js";
import {
    subscribeSessionToTrigger,
    clearSessionSubscriptions,
} from "../src/sessions/trigger-subscription-store.js";

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
});
