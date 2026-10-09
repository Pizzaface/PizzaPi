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
let messagesVersion: { token: string; lastStateLength: number } | null = { token: "v0", lastStateLength: 0 };
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
    messagesVersion = { token: "v0", lastStateLength: 0 };
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
    _hasCachedSessionMessagesForTesting,
    _setMaxCachedSessionMessagesBytesForTesting,
    _pruneIdleCachedSessionMessagesForTesting,
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
        messagesVersion = { token: "v1", lastStateLength: 7 };

        expect(await getSessionMessages(sessionId)).toEqual(["cached"]);
        sessionData = { lastState: JSON.stringify({ messages: ["should-not-read"] }) };
        expect(await getSessionMessages(sessionId)).toEqual(["cached"]);
        expect(getSession).toHaveBeenCalledTimes(1);
    });

    it("re-fetches messages when a shared Redis version changes", async () => {
        const sessionId = "cache-version-regression";
        sessionData = { lastState: JSON.stringify({ messages: ["old"] }) };
        messagesVersion = { token: "v1", lastStateLength: 1 };

        expect(await getSessionMessages(sessionId)).toEqual(["old"]);

        // Represents another relay node atomically replacing lastState and
        // bumping the Redis-shared version.
        sessionData = { lastState: JSON.stringify({ messages: ["new"] }) };
        messagesVersion = { token: "v2", lastStateLength: 2 };
        expect(await getSessionMessages(sessionId)).toEqual(["new"]);
        expect(getSession).toHaveBeenCalledTimes(2);
    });

    it("does not serve a cached entry after the Redis version marker disappears", async () => {
        const sessionId = "cache-delete-regression";
        sessionData = { lastState: JSON.stringify({ messages: ["old"] }) };
        messagesVersion = { token: "v0", lastStateLength: 0 };
        expect(await getSessionMessages(sessionId)).toEqual(["old"]);

        sessionData = null;
        messagesVersion = null;
        expect(await getSessionMessages(sessionId)).toBeNull();
        expect(getSession).toHaveBeenCalledTimes(2);
    });

    it("evicts the cached entry (not just skips serving it) when the version marker reads null, so a later re-registration cannot collide with the stale stamp", async () => {
        // Regression for the cross-generation collision bug: observing a null
        // version used to leave the old cache entry in place. If a later
        // generation's version info happened to reproduce the exact same
        // stamp (plausible for a monotonic counter after TTL expiry — the
        // reason the real version is now a random token, not a counter), the
        // dead entry would be served as if it were current.
        const sessionId = "cache-null-eviction-regression";
        sessionData = { lastState: JSON.stringify({ messages: ["gen1"] }) };
        messagesVersion = { token: "v-collide", lastStateLength: 999 };
        expect(await getSessionMessages(sessionId)).toEqual(["gen1"]);
        expect(_hasCachedSessionMessagesForTesting(sessionId)).toBe(true);

        // Session torn down: this node's own process-local cache still holds
        // the gen-1 entry, but the shared Redis version marker is now gone
        // (teardown, or the key naturally expired after 24h of idle).
        sessionData = null;
        messagesVersion = null;
        expect(await getSessionMessages(sessionId)).toBeNull();
        expect(_hasCachedSessionMessagesForTesting(sessionId)).toBe(false);

        // Re-registration under the same session ID produces a fresh
        // generation whose stamp happens to collide with the evicted gen-1
        // stamp (same token + lastStateLength).
        sessionData = { lastState: JSON.stringify({ messages: ["gen2"] }) };
        messagesVersion = { token: "v-collide", lastStateLength: 999 };
        expect(await getSessionMessages(sessionId)).toEqual(["gen2"]);
    });

    it("detects an old (non-token-bumping) writer's lastState overwrite via the lastState-length check", async () => {
        // Regression for the rolling-deploy hazard: an un-upgraded relay node
        // writes a new lastState through the plain updateSessionFields path,
        // which refreshes TTLs but does not bump the shared token. HSTRLEN of
        // lastState (mirrored here via lastStateLength) still changed, so the
        // cache must not serve the pre-overwrite entry.
        const sessionId = "cache-old-writer-regression";
        const oldState = JSON.stringify({ messages: ["old"] });
        sessionData = { lastState: oldState };
        messagesVersion = { token: "v-fixed", lastStateLength: oldState.length };
        expect(await getSessionMessages(sessionId)).toEqual(["old"]);

        const newState = JSON.stringify({ messages: ["new-from-old-writer"] });
        sessionData = { lastState: newState };
        // Token intentionally unchanged — only the length moved.
        messagesVersion = { token: "v-fixed", lastStateLength: newState.length };
        expect(await getSessionMessages(sessionId)).toEqual(["new-from-old-writer"]);
    });

    it("freezes cached messages so callers cannot mutate later cache hits", async () => {
        const sessionId = "cache-mutation-regression";
        sessionData = { lastState: JSON.stringify({ messages: ["safe"] }) };
        messagesVersion = { token: "v1", lastStateLength: 1 };

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
            messagesVersion = { token: `v${i + 1}`, lastStateLength: 0 };
            expect(await getSessionMessages(sessionId)).toEqual([`old-${i}`]);
        }

        sessionData = { lastState: JSON.stringify({ messages: ["refetched"] }) };
        messagesVersion = { token: "v-refetch", lastStateLength: 0 };
        expect(await getSessionMessages("lru-0")).toEqual(["refetched"]);
    });

    it("bypasses caching for an entry over the total byte budget, and evicts older entries once the budget is exceeded", async () => {
        _clearSessionMessagesCacheForTesting();
        _setMaxCachedSessionMessagesBytesForTesting(50);
        try {
            // Small entry fits comfortably under the shrunk budget.
            sessionData = { lastState: JSON.stringify({ messages: ["small"] }) };
            messagesVersion = { token: "v-small", lastStateLength: 0 };
            expect(await getSessionMessages("budget-small")).toEqual(["small"]);
            expect(_hasCachedSessionMessagesForTesting("budget-small")).toBe(true);

            // Oversized entry (lastState alone exceeds the 50-byte budget) must be
            // served correctly but bypass caching entirely — never partially
            // cached, never evicts everything else just to make room for itself.
            const oversizedMessages = ["x".repeat(200)];
            sessionData = { lastState: JSON.stringify({ messages: oversizedMessages }) };
            messagesVersion = { token: "v-huge", lastStateLength: 0 };
            expect(await getSessionMessages("budget-huge")).toEqual(oversizedMessages);
            expect(_hasCachedSessionMessagesForTesting("budget-huge")).toBe(false);

            // The small entry survives — the oversized fetch didn't evict it.
            expect(_hasCachedSessionMessagesForTesting("budget-small")).toBe(true);
        } finally {
            _setMaxCachedSessionMessagesBytesForTesting(null);
        }
    });

    it("evicts an entry that has gone idle past the cache's idle window", async () => {
        _clearSessionMessagesCacheForTesting();
        const sessionId = "idle-eviction-regression";
        sessionData = { lastState: JSON.stringify({ messages: ["idle"] }) };
        messagesVersion = { token: "v-idle", lastStateLength: 0 };
        expect(await getSessionMessages(sessionId)).toEqual(["idle"]);
        expect(_hasCachedSessionMessagesForTesting(sessionId)).toBe(true);

        // Fast-forward well past the idle window without touching the entry.
        _pruneIdleCachedSessionMessagesForTesting(Date.now() + 60 * 60 * 1000);
        expect(_hasCachedSessionMessagesForTesting(sessionId)).toBe(false);
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
