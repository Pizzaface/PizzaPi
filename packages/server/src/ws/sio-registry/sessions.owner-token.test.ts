// ============================================================================
// sessions.owner-token.test.ts — Unit tests for getSessionOwnerToken (A2-017)
//
// Verifies that getSessionOwnerToken fails closed: Redis errors propagate so
// sensitive lifecycle operations can skip rather than treating unknown as owner.
// ============================================================================

import { afterAll, afterEach, describe, it, expect, mock } from "bun:test";
import type { RedisSessionData } from "../sio-state/index.js";

let fieldValue: string | null = null;
let fieldShouldThrow = false;
let sessionData: Record<string, unknown> | null = null;
let sessionSummary: Record<string, unknown> | null = null;
let messagesVersion: number | null = 0;
const getSession = mock(async () => sessionData);
const getSessionSummary = mock(async () => sessionSummary);
const getSessionMessagesVersion = mock(async () => messagesVersion);
const updateSessionFieldsAndBumpMessagesVersion = mock(async (_id: string, _fields: Partial<RedisSessionData>) => {});

const noopAsync = async () => {};

mock.module("../sio-state/index.js", () => ({
    setSession: noopAsync,
    getSession,
    getSessionSummary,
    getSessionField: async (_sessionId: string, _field: string) => {
        if (fieldShouldThrow) throw new Error("Redis ECONNRESET (test)");
        return fieldValue;
    },
    acquireSessionOwnershipLock: noopAsync,
    releaseSessionOwnershipLock: noopAsync,
    deleteSessionIfOwner: async () => true,
    updateSessionFields: noopAsync,
    updateSessionFieldsAndBumpMessagesVersion,
    getMessagesVersion: getSessionMessagesVersion,
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
    storeAndReplaceImages: async (state: unknown) => state,
    storeAndReplaceImagesInEvent: async (event: unknown) => event,
}));

mock.module("../stale-parent-link.js", () => ({ severStaleParentLink: noopAsync }));

afterEach(() => {
    fieldValue = null;
    fieldShouldThrow = false;
    sessionData = null;
    sessionSummary = null;
    messagesVersion = 0;
    getSession.mockClear();
    getSessionSummary.mockClear();
    getSessionMessagesVersion.mockClear();
    updateSessionFieldsAndBumpMessagesVersion.mockClear();
});

afterAll(() => mock.restore());

const {
    getSessionOwnerToken,
    getSessionMessages,
    updateSessionState,
    _clearSessionMessagesCacheForTesting,
} = await import("./sessions.js");

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

    it("fills and reuses the parsed-message cache while the shared Redis version is unchanged", async () => {
        const sessionId = "cache-fill-regression";
        sessionData = { lastState: JSON.stringify({ messages: ["cached"] }) };
        messagesVersion = 1;

        expect(await getSessionMessages(sessionId)).toEqual(["cached"]);
        sessionData = { lastState: JSON.stringify({ messages: ["should-not-read"] }) };
        expect(await getSessionMessages(sessionId)).toEqual(["cached"]);
        expect(getSession).toHaveBeenCalledTimes(1);
    });

    it("re-fetches messages when a shared Redis version changes", async () => {
        const sessionId = "cache-version-regression";
        sessionData = { lastState: JSON.stringify({ messages: ["old"] }) };
        messagesVersion = 1;

        expect(await getSessionMessages(sessionId)).toEqual(["old"]);

        // Represents another relay node atomically replacing lastState and
        // bumping the Redis-shared version.
        sessionData = { lastState: JSON.stringify({ messages: ["new"] }) };
        messagesVersion = 2;
        expect(await getSessionMessages(sessionId)).toEqual(["new"]);
        expect(getSession).toHaveBeenCalledTimes(2);
    });

    it("does not serve a cached entry after the Redis version marker disappears", async () => {
        const sessionId = "cache-delete-regression";
        sessionData = { lastState: JSON.stringify({ messages: ["old"] }) };
        messagesVersion = 0;
        expect(await getSessionMessages(sessionId)).toEqual(["old"]);

        sessionData = null;
        messagesVersion = null;
        expect(await getSessionMessages(sessionId)).toBeNull();
        expect(getSession).toHaveBeenCalledTimes(2);
    });

    it("freezes cached messages so callers cannot mutate later cache hits", async () => {
        const sessionId = "cache-mutation-regression";
        sessionData = { lastState: JSON.stringify({ messages: ["safe"] }) };
        messagesVersion = 1;

        const messages = await getSessionMessages(sessionId);
        expect(Object.isFrozen(messages)).toBe(true);
        expect(() => (messages as unknown[]).push("corrupt")).toThrow();
        expect(await getSessionMessages(sessionId)).toEqual(["safe"]);
    });

    it("evicts the least-recently-used parsed-message cache entry", async () => {
        _clearSessionMessagesCacheForTesting();

        for (let i = 0; i <= 200; i++) {
            const sessionId = `lru-${i}`;
            sessionData = { lastState: JSON.stringify({ messages: [`old-${i}`] }) };
            messagesVersion = i + 1;
            expect(await getSessionMessages(sessionId)).toEqual([`old-${i}`]);
        }

        sessionData = { lastState: JSON.stringify({ messages: ["refetched"] }) };
        messagesVersion = 1;
        expect(await getSessionMessages("lru-0")).toEqual(["refetched"]);
    });

    it("bumps the shared Redis messages version atomically with lastState updates", async () => {
        sessionSummary = {
            sessionId: "cache-update-regression",
            userId: "user-1",
            sessionName: null,
            isEphemeral: false,
            lastHeartbeat: null,
            isActive: true,
            lastHeartbeatAt: null,
        };

        await updateSessionState("cache-update-regression", { messages: ["fresh"] });

        expect(updateSessionFieldsAndBumpMessagesVersion).toHaveBeenCalledTimes(1);
        expect(updateSessionFieldsAndBumpMessagesVersion.mock.calls[0]?.[0]).toBe("cache-update-regression");
        expect(updateSessionFieldsAndBumpMessagesVersion.mock.calls[0]?.[1]).toMatchObject({
            lastState: JSON.stringify({ messages: ["fresh"] }),
            snapshotOverlay: null,
            snapshotRejectedAt: null,
        });
    });
});
