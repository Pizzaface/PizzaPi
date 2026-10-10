// ============================================================================
// sessions.owner-token.test.ts — Unit tests for getSessionOwnerToken (A2-017)
//
// Verifies that getSessionOwnerToken fails closed: Redis errors propagate so
// sensitive lifecycle operations can skip rather than treating unknown as owner.
// ============================================================================

import { afterAll, beforeEach, describe, it, expect, mock } from "bun:test";
import { createSioStateRedisFixture } from "../../tests/fixtures/sio-state-redis.js";

const noopAsync = async () => {};
const stateRedis = createSioStateRedisFixture();

mock.module("./meta.js", () => ({ extractMetaFromHeartbeat: () => ({}) }));
mock.module("./hub.js", () => ({ broadcastToHub: noopAsync }));

mock.module("../../sessions/store.js", () => ({
    getEphemeralTtlMs: () => 60_000,
    getPersistedRelaySessionRunner: async () => null,
    getRelaySessionUserId: async () => null,
    getPersistedRelaySessionSnapshot: async () => null,
    recordRelaySessionStart: noopAsync,
    recordRelaySessionEnd: noopAsync,
    recordRelaySessionState: noopAsync,
    recordRelaySessionStateSerialized: noopAsync,
    recordRelaySessionOverlay: noopAsync,
    updateRelaySessionRunner: noopAsync,
    markRelaySessionSuspended: async () => {},
    touchRelaySession: noopAsync,
    updateRelaySessionName: noopAsync,
}));

mock.module("../strip-images.js", () => ({
    storeAndReplaceImages: noopAsync,
    storeAndReplaceImagesInEvent: async (event: unknown) => event,
}));

mock.module("../stale-parent-link.js", () => ({ severStaleParentLink: noopAsync }));

afterAll(() => mock.restore());

const { initStateRedis } = await import("../sio-state.js");
const { getSessionOwnerToken } = await import("./sessions.js");

describe("getSessionOwnerToken (A2-017 fail-closed ownership)", () => {
    beforeEach(async () => {
        stateRedis.reset();
        await initStateRedis(stateRedis.client as never);
    });

    it("propagates Redis errors so callers skip sensitive operations", async () => {
        stateRedis.failHGet(new Error("Redis ECONNRESET (test)"));
        await expect(getSessionOwnerToken("sess-1")).rejects.toThrow("Redis ECONNRESET");
    });

    it("returns the stored token when Redis read succeeds", async () => {
        await (stateRedis.client.hSet as (key: string, field: string, value: string) => Promise<void>)(
            "pizzapi:sio:session:sess-1",
            "token",
            "token-abc",
        );
        const result = await getSessionOwnerToken("sess-1");
        expect(result).toBe("token-abc");
    });

    it("returns null when field is absent (session not yet written)", async () => {
        const result = await getSessionOwnerToken("sess-1");
        expect(result).toBeNull();
    });
});
