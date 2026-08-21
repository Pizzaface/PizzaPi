// ============================================================================
// sessions.owner-token.test.ts — Unit tests for getSessionOwnerToken (A2-017)
//
// Verifies that getSessionOwnerToken is fail-open: when the underlying Redis
// read throws, it returns null (identical to "not found") instead of
// propagating the error.  A genuine stored token is still returned correctly.
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

describe("getSessionOwnerToken (A2-017 expo fix: fail-open on Redis error)", () => {
    it("returns null when Redis read throws — does NOT propagate the error", async () => {
        fieldShouldThrow = true;
        const result = await getSessionOwnerToken("sess-1");
        expect(result).toBeNull();
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
