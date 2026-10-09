// ============================================================================
// sessions.suspend-ttl.test.ts — a suspended session's expiresAt is cleared
// (suspendSharedSession writes expiresAt:null), so it must never surface
// as a candidate for TTL expiry (which would killTerminals on a session a
// later message is still meant to wake). Exercises the real
// scanExpiredSessions against a fake Redis hash, not a mock.
// ============================================================================

import { beforeEach, describe, expect, it } from "bun:test";
import { createSioStateRedisFixture } from "../../tests/fixtures/sio-state-redis.js";

const stateRedis = createSioStateRedisFixture();
const { initStateRedis, setSession, scanExpiredSessions } = await import("../sio-state.js");

beforeEach(async () => {
    stateRedis.reset();
    await initStateRedis(stateRedis.client as never);
});

describe("scanExpiredSessions excludes suspended sessions", () => {
    it("a suspended session (expiresAt:null) never comes back as expired", async () => {
        await setSession("suspended-1", {
            sessionId: "suspended-1",
            token: "tok",
            cwd: "/w",
            startedAt: new Date().toISOString(),
            isEphemeral: true,
            expiresAt: null,
            suspended: true,
        } as never);

        expect(await scanExpiredSessions(Date.now() + 365 * 24 * 60 * 60 * 1000)).not.toContain("suspended-1");
    });

    it("a normal ephemeral session with a past expiresAt IS returned (control case)", async () => {
        await setSession("ephemeral-1", {
            sessionId: "ephemeral-1",
            token: "tok",
            cwd: "/w",
            startedAt: new Date().toISOString(),
            isEphemeral: true,
            expiresAt: new Date(Date.now() - 1000).toISOString(),
        } as never);

        expect(await scanExpiredSessions(Date.now())).toContain("ephemeral-1");
    });
});
