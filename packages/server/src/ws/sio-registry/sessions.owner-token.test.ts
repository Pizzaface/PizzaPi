// ============================================================================
// sessions.owner-token.test.ts — Unit tests for getSessionOwnerToken (A2-017)
//
// Verifies that getSessionOwnerToken fails closed: Redis errors propagate so
// sensitive lifecycle operations can skip rather than treating unknown as owner.
// ============================================================================

import { afterAll, describe, it, expect, mock } from "bun:test";

let fieldValue: string | null = null;
let fieldShouldThrow = false;

const noopAsync = async () => {};

mock.module("../sio-state/index.js", () => ({
    setSession: noopAsync,
    getSession: async () => null,
    getSessionSummary: async () => null,
    getSessionField: async (_sessionId: string, _field: string) => {
        if (fieldShouldThrow) throw new Error("Redis ECONNRESET (test)");
        return fieldValue;
    },
    acquireSessionOwnershipLock: noopAsync,
    releaseSessionOwnershipLock: noopAsync,
    deleteSessionIfOwner: async () => true,
    updateSessionFields: noopAsync,
    deleteSession: noopAsync,
    getAllSessionSummaries: async () => [],
    refreshSessionTTL: noopAsync,
    incrementSeq: async () => 0,
    getSeq: async () => 0,
    setPendingRunnerLink: noopAsync,
    getPendingRunnerLink: async () => null,
    deletePendingRunnerLink: noopAsync,
    getRunnerAssociation: async () => null,
    setRunnerAssociation: noopAsync,
    refreshRunnerAssociationTTL: noopAsync,
    scanExpiredSessions: async () => [],
    addChildSession: noopAsync,
    addChildSessionMembership: noopAsync,
    removeChildSession: noopAsync,
    isChildDelinked: async () => false,
    clearParentSessionId: noopAsync,
    refreshChildSessionsTTL: noopAsync,
    removePendingParentDelinkChild: noopAsync,
    getRunner: async () => null,
}));

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
    touchRelaySession: noopAsync,
    updateRelaySessionName: noopAsync,
}));

mock.module("../strip-images.js", () => ({
    storeAndReplaceImages: noopAsync,
    storeAndReplaceImagesInEvent: async (event: unknown) => event,
}));

mock.module("../stale-parent-link.js", () => ({ severStaleParentLink: noopAsync }));

afterAll(() => mock.restore());

const { getSessionOwnerToken } = await import("./sessions.js");

describe("getSessionOwnerToken (A2-017 fail-closed ownership)", () => {
    it("propagates Redis errors so callers skip sensitive operations", async () => {
        fieldShouldThrow = true;
        await expect(getSessionOwnerToken("sess-1")).rejects.toThrow("Redis ECONNRESET");
        fieldShouldThrow = false;
    });

    it("returns the stored token when Redis read succeeds", async () => {
        fieldValue = "token-abc";
        const result = await getSessionOwnerToken("sess-1");
        expect(result).toBe("token-abc");
        fieldValue = null;
    });

    it("returns null when field is absent (session not yet written)", async () => {
        fieldValue = null;
        const result = await getSessionOwnerToken("sess-1");
        expect(result).toBeNull();
    });
});
