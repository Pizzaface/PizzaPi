// Regression (2026-10-08 relay crash loop, GM GIo4GsJ9): registerTuiSession
// holds the session ownership lock while resetPerSessionRelayState drains the
// session's event queue. Every queued event handler acquires that same lock,
// so draining by RUNNING the backlog made each item wait out the 5s lock
// timeout — the registration held the lock for 5s × backlog. Stale queued
// work must be skipped, not run.
import { afterAll, describe, expect, it, mock } from "bun:test";

mock.module("../../../sessions/redis.js", () => ({ deleteRelayEventCache: async () => {} }));
afterAll(() => mock.restore());

const { enqueueSessionEvent, resetPerSessionRelayState } = await import("./relay-state.js");

describe("resetPerSessionRelayState", () => {
    it("skips work queued before the reset instead of running it under the held lock", async () => {
        let ran = 0;
        // Each queued handler stands in for an event that would block on the
        // ownership lock the registration is holding.
        const lockWait = () => new Promise<void>((r) => setTimeout(r, 100));
        for (let i = 0; i < 20; i++) {
            void enqueueSessionEvent("s1", async () => {
                ran++;
                await lockWait();
            });
        }

        const started = performance.now();
        await resetPerSessionRelayState("s1");

        expect(ran).toBe(0);
        expect(performance.now() - started).toBeLessThan(500);
    });

    it("runs work enqueued after the reset (the new generation)", async () => {
        await resetPerSessionRelayState("s2");
        let ran = false;
        await enqueueSessionEvent("s2", async () => {
            ran = true;
        });
        expect(ran).toBe(true);
    });
});
