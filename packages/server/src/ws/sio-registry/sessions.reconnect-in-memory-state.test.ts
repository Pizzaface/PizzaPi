// ============================================================================
// sessions.reconnect-in-memory-state.test.ts — Health inspection A2
//
// Proves that a TUI reconnect does NOT drain/clear the per-session event
// pipeline queue or the pending chunked-snapshot assembly state.  The
// session_end / disconnect handlers only clean these up when the old socket
// fires its own lifecycle events; registerTuiSession evicts the old socket
// by setting oldSocket.data.sessionId = undefined and then calls
// endSharedSession(), which never touches sessionEventQueues or
// pendingChunkedStates.  An in-flight old event can still run after the
// session is recreated under the same sessionId, corrupting the new session's
// Redis event cache / seq counter or blocking new events behind stale work.
//
// This is distinct from snapshot throttle, chunk hydration, resync cursor,
// and pending session checks — it is an event-queue draining + reconnect
// cleanup defect in relay snapshot persistence.
// ============================================================================

import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";

const store = new Map<string, string>();

const appendCalls: Array<{ sessionId: string; event: unknown; opts?: { seq?: number; isEphemeral?: boolean } }> = [];
const seqIncrements: string[] = [];

mock.module("../../sessions/store.js", () => ({
    getEphemeralTtlMs: () => 60_000,
    getPersistedRelaySessionRunner: async () => null,
    getRelaySessionUserId: async () => null,
    getPersistedRelaySessionSnapshot: async () => null,
    recordRelaySessionStart: async () => {},
    recordRelaySessionEnd: async () => {},
    recordRelaySessionState: async () => {},
    recordRelaySessionStateSerialized: async () => {},
    touchRelaySession: async () => {},
    updateRelaySessionRunner: async () => false,
    updateRelaySessionName: async () => false,
    getActiveRelaySessionUserId: async () => null,
    recordRelaySessionEnd: async () => {},
    getPersistedRelaySessionOwner: async () => null,
    listPersistedRelaySessionsForUser: async () => [],
    listPinnedRelaySessionsForUser: async () => [],
    pinRelaySession: async () => false,
    unpinRelaySession: async () => false,
    pruneExpiredRelaySessions: async () => [],
}));

mock.module("../../sessions/redis.js", () => ({
    initializeRelayRedisCache: async () => {},
    _injectRedisForTesting: () => {},
    _resetRelayRedisCacheForTesting: () => {},
    appendRelayEventToCache: async (sessionId: string, event: unknown, opts?: { seq?: number; isEphemeral?: boolean }) => {
        appendCalls.push({ sessionId, event, opts });
    },
    getCachedRelayEvents: async () => [],
    getLatestCachedRelayEventSeq: async () => null,
    getCachedRelayEventsAfterSeq: async () => [],
    getLatestCachedSnapshotEvent: async () => null,
    deleteRelayEventCache: async () => {},
    deleteRelayEventCaches: async () => {},
}));

mock.module("../../sessions/trigger-subscription-store.js", () => ({
    clearSessionSubscriptions: async () => {},
}));

mock.module("../../sessions/trigger-store.js", () => ({
    pushTriggerHistory: async () => {},
    recordTriggerResponse: async () => {},
}));

const sessionHashKey = (s: string) => `session:${s}`;

mock.module("../sio-state/index.js", () => ({
    initStateRedis: async () => {},
    setSession: async (sessionId: string, data: Record<string, unknown>) => {
        store.set(sessionHashKey(sessionId), JSON.stringify(data));
    },
    getSession: async (sessionId: string) => {
        const raw = store.get(sessionHashKey(sessionId));
        return raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
    },
    getSessionSummary: async (sessionId: string) => {
        const raw = store.get(sessionHashKey(sessionId));
        return raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
    },
    getSessionField: async () => null,
    updateSessionFields: async () => {},
    upsertSessionFields: async () => {},
    deleteSession: async (sessionId: string) => {
        store.delete(sessionHashKey(sessionId));
    },
    getAllSessionSummaries: async () => [],
    getAllSessions: async () => [],
    refreshSessionTTL: async () => {},
    incrementSeq: async (sessionId: string) => {
        seqIncrements.push(sessionId);
        return 1;
    },
    getSeq: async () => 0,
    setPendingRunnerLink: async () => {},
    getPendingRunnerLink: async () => null,
    deletePendingRunnerLink: async () => {},
    getRunnerAssociation: async () => null,
    setRunnerAssociation: async () => {},
    refreshRunnerAssociationTTL: async () => {},
    scanExpiredSessions: async () => [],
    cleanStaleIndexEntries: async () => {},
    addChildSession: async () => {},
    addChildSessionMembership: async () => {},
    removeChildSession: async () => {},
    getChildSessions: async () => [],
    isChildOfParent: async () => false,
    isLinkedChildForSuppression: async () => false,
    addPendingParentDelinkChildren: async () => {},
    getPendingParentDelinkChildren: async () => [],
    isPendingParentDelinkChild: async () => false,
    removePendingParentDelinkChild: async () => {},
    markChildAsDelinked: async () => {},
    isChildDelinked: async () => false,
    clearDelinkedMark: async () => {},
    clearParentSessionId: async () => {},
    refreshChildSessionsTTL: async () => {},
    clearAllChildren: async () => [],
    removeChildren: async () => {},
    // runner state re-exported by sio-registry/runners.ts
    setRunner: async () => {},
    getRunner: async () => null,
    updateRunnerFields: async () => {},
    deleteRunner: async () => {},
    getAllRunners: async () => [],
    refreshRunnerTTL: async () => {},
    deleteRunnerAssociation: async () => {},
    // push pending helpers re-exported by relay/push-tracker.ts (via sio-registry)
    setPushPendingQuestion: async () => {},
    getPushPendingQuestion: async () => null,
    consumePushPendingQuestionIfMatches: async () => false,
    clearPushPendingQuestion: async () => {},
    // terminal state re-exported by sio-registry/terminals.ts
    setTerminal: async () => {},
    getTerminal: async () => null,
    claimTerminalSpawn: async () => null,
    updateTerminalFields: async () => {},
    deleteTerminal: async () => {},
    getTerminalsForRunner: async () => [],
}));

mock.module("./hub.js", () => ({
    broadcastToHub: async () => {},
    addHubClient: () => {},
    removeHubClient: () => {},
}));

afterAll(() => mock.restore());

const { registerTuiSession, endSharedSession } = await import("./sessions.js");
const { initSioRegistry } = await import("./context.js");
const {
    sessionEventQueues,
    pendingChunkedStates,
    enqueueSessionEvent,
} = await import("../namespaces/relay/event-pipeline.js");

const fakeNamespace = {
    to: () => ({ emit: () => ({}) }),
    local: { to: () => ({ emit: () => ({}) }) },
    in: () => ({ disconnectSockets: () => {} }),
    emit: () => {},
};
initSioRegistry({ of: () => fakeNamespace } as never);

function fakeSocket() {
    return { join: async () => {}, data: {} } as never;
}

async function seedSession(sessionId: string) {
    store.set(
        sessionHashKey(sessionId),
        JSON.stringify({
            sessionId,
            userId: "u1",
            token: "old-token",
            startedAt: new Date().toISOString(),
            parentSessionId: null,
            linkedParentId: null,
            isEphemeral: false,
            seq: 0,
        }),
    );
}

function flushMicrotasks(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("reconnect cleanup — in-memory relay state", () => {
    beforeEach(async () => {
        store.clear();
        appendCalls.length = 0;
        seqIncrements.length = 0;
        sessionEventQueues.clear();
        pendingChunkedStates.clear();
    });

    it("old queued events still write to the cache after reconnect", async () => {
        const sessionId = "sess-reconnect-leak";
        await seedSession(sessionId);

        // Simulate an old socket that has an in-flight queued event.
        let oldEventRan = false;
        const oldEventDone = enqueueSessionEvent(sessionId, async () => {
            oldEventRan = true;
            // This event races with the reconnect and writes to the Redis cache
            // using the SAME sessionId that is about to be recreated.
            const { appendRelayEventToCache } = await import("../../sessions/redis.js");
            await appendRelayEventToCache(sessionId, { type: "stale_old_event" });
        });

        // Also leave a chunked assembly in progress (memory leak).
        pendingChunkedStates.set(sessionId, {
            snapshotId: "old-snapshot",
            metadata: { sessionName: "Old" },
            chunks: [["old-msg"]],
            totalChunks: 1,
            receivedChunkIndexes: new Set<number>([0]),
            finalChunkSeen: true,
            lastActivityAt: Date.now(),
        });

        // Reconnect: registerTuiSession finds the existing session, evicts the
        // old socket, calls endSharedSession, and recreates the session under
        // the same sessionId.
        await registerTuiSession(fakeSocket(), "", {
            sessionId,
            userId: "u1",
            isEphemeral: false,
        });

        // Wait for the old queued event to drain.
        await oldEventDone;
        await flushMicrotasks();

        // BUG: the old queued event was still allowed to run and append a stale
        // event to the cache for the freshly-recreated session.
        expect(oldEventRan).toBe(true);
        expect(appendCalls).toContainEqual({
            sessionId,
            event: { type: "stale_old_event" },
            opts: undefined,
        });

        // BUG: the pending chunked state keyed by sessionId was never cleared
        // during reconnect, so stale assembly state leaks and may corrupt
        // subsequent chunk streams that reuse the same snapshotId.
        expect(pendingChunkedStates.has(sessionId)).toBe(true);
        const leaked = pendingChunkedStates.get(sessionId)!;
        expect(leaked.snapshotId).toBe("old-snapshot");
        expect(leaked.metadata).toEqual({ sessionName: "Old" });
    });

    it("new events are enqueued behind stale work from the previous socket", async () => {
        const sessionId = "sess-reconnect-order";
        await seedSession(sessionId);

        const order: string[] = [];
        let releaseOld!: () => void;
        const oldBarrier = new Promise<void>((resolve) => { releaseOld = resolve; });

        enqueueSessionEvent(sessionId, async () => {
            await oldBarrier;
            order.push("old-stale-work");
        });

        await registerTuiSession(fakeSocket(), "", {
            sessionId,
            userId: "u1",
            isEphemeral: false,
        });

        let newEventRan = false;
        const newEventDone = enqueueSessionEvent(sessionId, async () => {
            newEventRan = true;
            order.push("new-live-work");
        });

        // Even though the session has been recreated, the new event is blocked
        // behind the old socket's stale queued work because the queue is keyed
        // by sessionId and was never reset.
        await flushMicrotasks();
        expect(newEventRan).toBe(false);

        releaseOld();
        await newEventDone;

        expect(order).toEqual(["old-stale-work", "new-live-work"]);
    });

    it("endSharedSession on reconnect does not delete the relay event cache", async () => {
        const sessionId = "sess-cache-survives-reconnect";
        await seedSession(sessionId);

        // Pre-seed the Redis event cache with stale events from the old socket.
        const { appendRelayEventToCache } = await import("../../sessions/redis.js");
        await appendRelayEventToCache(sessionId, { type: "old_event_before_reconnect", seq: 5 });

        await endSharedSession(sessionId, "Session reconnected");

        // BUG: reconnect intentionally preserves the event cache because
        // endSharedSession is shared with terminal-end paths that need replay.
        // For a reconnect the old cache should be invalidated, but it is not.
        expect(store.has(sessionHashKey(sessionId))).toBe(false);
        expect(appendCalls).toHaveLength(1);
        expect(appendCalls[0]).toEqual({
            sessionId,
            event: { type: "old_event_before_reconnect", seq: 5 },
            opts: undefined,
        });
    });
});
