// ============================================================================
// event-pipeline.cross-node.test.ts — Regression: A2-017
//
// Verifies that stale events arriving on a superseded cross-node socket are
// silently dropped (no state updates, no viewer broadcasts) when the shared
// Redis owner token has been bumped by a replacement session on another node.
// ============================================================================

import { afterAll, describe, it, expect, beforeEach, mock } from "bun:test";

// ── Shared spy state ─────────────────────────────────────────────────────────
const stateUpdates: string[] = [];
const broadcasts: string[] = [];
let redisOwnerToken: string | null = "token-node-a";
let tokenReadShouldThrow = false;
let lockHeld = false;
let rotateOwnershipDuringUpdate = false;
let replacementWaiting = false;
const mutationOwnerTokens: Array<string | null> = [];

mock.module("../../sio-registry.js", () => ({
    // After the A2-017 expo fix, getSessionOwnerToken catches Redis errors and
    // returns null (fail-open).  Simulate that: return null when shouldThrow.
    getSessionOwnerToken: async (_sessionId: string) => {
        if (tokenReadShouldThrow) return null;
        return redisOwnerToken;
    },
    updateSessionState: async (sessionId: string) => {
        stateUpdates.push(sessionId);
        mutationOwnerTokens.push(redisOwnerToken);
        if (rotateOwnershipDuringUpdate) {
            // Model replacement registration attempting to take the same lock
            // after the event's initial owner check.
            replacementWaiting = true;
            expect(lockHeld).toBe(true);
        }
    },
    patchSessionSnapshotState: async () => {},
    touchSessionActivity: async () => {},
    updateSessionHeartbeat: async () => {},
    getSharedSession: async () => null,
    getSharedSessionSummary: async () => null,
    broadcastSessionEventToViewers: async (sessionId: string) => { broadcasts.push(sessionId); },
    publishSessionEvent: async (sessionId: string) => { broadcasts.push(sessionId); return 0; },
    consumePendingRecovery: () => false,
    updateSessionMetaState: async () => 0,
    broadcastToSessionMeta: async () => {},
    getSessionMetaState: async () => null,
}));

mock.module("../../../sessions/redis.js", () => ({
    appendRelayEventToCache: async () => {},
}));

mock.module("./viewer-gate.js", () => ({
    isDeltaEvent: () => false,
    shouldPublishDelta: () => true,
    forgetViewerGate: () => {},
}));

mock.module("../../sio-registry/meta.js", () => ({
    updateSessionMetaState: async () => 0,
    broadcastToSessionMeta: async () => {},
    getSessionMetaState: async () => null,
    buildSnapshotPatchFromMetadata: () => ({}),
    buildSnapshotPatchFromCapabilities: () => ({}),
}));

mock.module("../../sio-registry/snapshot-state.js", () => ({
    buildSnapshotPatchFromCapabilities: () => ({}),
    buildSnapshotPatchFromMetadata: () => ({}),
}));

mock.module("../../strip-images.js", () => ({
    storeAndReplaceImagesInEvent: async (_e: unknown) => _e,
    stripImagesFromPipelineEvent: async (_e: unknown) => _e,
}));

mock.module("./thinking-tracker.js", () => ({
    trackThinkingDeltas: () => {},
    augmentMessageThinkingDurations: (_e: unknown) => _e,
    clearThinkingMaps: () => {},
    thinkingDurations: new Map(),
}));

mock.module("./ack-tracker.js", () => ({
    socketAckedSeqs: new Map(),
    sendCumulativeEventAck: () => {},
}));

mock.module("./push-tracker.js", () => ({
    trackPushPendingState: async () => {},
    checkPushNotifications: async () => {},
}));

mock.module("../../../sessions/store.js", () => ({
    updateRelaySessionName: async () => {},
}));

mock.module("../../sio-state/index.js", () => ({
    acquireSessionOwnershipLock: async () => { lockHeld = true; },
    releaseSessionOwnershipLock: async () => {
        lockHeld = false;
        if (replacementWaiting) {
            redisOwnerToken = "token-node-b";
            replacementWaiting = false;
        }
    },
    updateSessionFields: async () => {},
}));

mock.module("@pizzapi/protocol", () => ({
    isMetaRelayEvent: () => false,
    metaEventToPatch: () => ({}),
}));

afterAll(() => mock.restore());

const { registerEventHandler, sessionEventQueues } = await import("./event-pipeline.js");

async function drainPipeline(sessionId: string): Promise<void> {
    await sessionEventQueues.get(sessionId);
}

function makeSocket(sessionId: string, token: string) {
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    return {
        socket: {
            id: "sock-x",
            data: { sessionId, token },
            on(event: string, cb: (...args: unknown[]) => unknown) {
                handlers.set(event, cb);
            },
            emit: () => {},
        } as never,
        fire: async (event: string, data?: unknown) => {
            const h = handlers.get(event);
            if (h) await h(data);
        },
    };
}

describe("A2-017: event pipeline stale cross-node socket rejection", () => {
    beforeEach(() => {
        stateUpdates.length = 0;
        broadcasts.length = 0;
        redisOwnerToken = "token-node-a";
        tokenReadShouldThrow = false;
        lockHeld = false;
        rotateOwnershipDuringUpdate = false;
        replacementWaiting = false;
        mutationOwnerTokens.length = 0;
    });

    it("rejects a stale event (token mismatch) — no state update or broadcast", async () => {
        const { socket: socketA, fire: fireA } = makeSocket("sess-1", "token-node-a");
        registerEventHandler(socketA);

        // Replacement registers on node-B — bumps shared token.
        redisOwnerToken = "token-node-b";

        // Stale event arrives on node-A socket with old token.
        await fireA("event", {
            token: "token-node-a",
            seq: 1,
            event: { type: "session_active", state: { sessionFile: "stale.json" } },
        });
        await drainPipeline("sess-1");

        expect(stateUpdates).toHaveLength(0);
        expect(broadcasts).toHaveLength(0);
    });

    it("accepts a valid event from the current owner socket", async () => {
        redisOwnerToken = "token-node-b";
        const { socket: socketB, fire: fireB } = makeSocket("sess-1", "token-node-b");
        registerEventHandler(socketB);

        await fireB("event", {
            token: "token-node-b",
            seq: 2,
            event: { type: "session_active", state: { sessionFile: "current.json" } },
        });
        await drainPipeline("sess-1");

        expect(stateUpdates).toEqual(["sess-1"]);
        expect(broadcasts).toEqual(["sess-1"]);
    });

    it("serializes replacement registration that starts after the initial ownership check", async () => {
        const { socket, fire } = makeSocket("sess-1", "token-node-a");
        registerEventHandler(socket);
        rotateOwnershipDuringUpdate = true;

        await fire("event", {
            token: "token-node-a",
            seq: 3,
            event: { type: "session_active", state: { sessionFile: "old-owner.json" } },
        });
        await drainPipeline("sess-1");

        // Every mutation completed under the old owner's lock; only then could
        // replacement registration rotate the shared token.
        expect(mutationOwnerTokens).toEqual(["token-node-a"]);
        expect(redisOwnerToken).toBe("token-node-b");
        expect(lockHeld).toBe(false);
    });

    it("Redis read throws → fail-closed: event is dropped", async () => {
        // Unknown ownership must never authorize processing a sensitive event.
        const { socket: socketA, fire: fireA } = makeSocket("sess-1", "token-node-a");
        registerEventHandler(socketA);

        tokenReadShouldThrow = true; // Redis throws on next read

        // The socket-level acknowledgement is harmless, but processing is dropped.
        await fireA("event", {
            token: "token-node-a",
            seq: 1,
            event: { type: "session_active", state: { sessionFile: "redis-error.json" } },
        });
        await drainPipeline("sess-1");

        expect(stateUpdates).toHaveLength(0);
        expect(broadcasts).toHaveLength(0);
    });

    it("drops events when Redis has no session owner token", async () => {
        redisOwnerToken = null; // session deleted or not yet written
        const { socket: socketA, fire: fireA } = makeSocket("sess-1", "token-node-a");
        registerEventHandler(socketA);

        await fireA("event", {
            token: "token-node-a",
            seq: 1,
            event: { type: "session_active", state: { sessionFile: "missing.json" } },
        });
        await drainPipeline("sess-1");

        expect(stateUpdates).toHaveLength(0);
        expect(broadcasts).toHaveLength(0);
    });
});
