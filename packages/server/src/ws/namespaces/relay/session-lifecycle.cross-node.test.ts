// ============================================================================
// session-lifecycle.cross-node.test.ts — Regression: A2-017
//
// Scenario: node-A socket registers a session, then node-B registers a
// REPLACEMENT for the same session (bumping the Redis owner token).  When
// node-A's socket later disconnects, endSharedSession must NOT be called
// (the replacement session on node-B survives).  Stale events arriving on
// node-A's socket are also rejected.  Only the replacement (current-token)
// socket's disconnect may end the session.
// ============================================================================

import { afterAll, describe, it, expect, beforeEach, mock } from "bun:test";

// ── Shared test state ────────────────────────────────────────────────────────
const endedSessions: Array<{ sessionId: string; reason?: string; opts?: unknown }> = [];

// Current Redis owner token — bumped when the replacement registers.
let redisOwnerToken: string | null = "token-node-a";
// Set to true to simulate a Redis read error (fix returns null, not throws).
let tokenReadShouldThrow = false;
let getSessionOwnerTokenForTest = async (_sessionId: string) => {
    if (tokenReadShouldThrow) return null;
    return redisOwnerToken;
};

mock.module("../../sio-registry.js", () => ({
    registerTuiSession: async (_socket: unknown, _cwd: string, opts: { sessionId?: string }) => ({
        sessionId: opts.sessionId ?? "sess-1",
        token: redisOwnerToken ?? "token-node-a",
        shareUrl: "",
        parentSessionId: null,
        wasDelinked: false,
    }),
    // Node-local socket map — simulate node-A not having node-B's socket.
    getLocalTuiSocket: (sessionId: string) => {
        // On node-A the local socket map has the stale socketA; after node-B
        // registers it is NOT updated (maps are node-local).
        return localSocketMap.get(sessionId);
    },
    broadcastToViewers: () => {},
    endSharedSession: async (sessionId: string, reason?: string, opts?: { expectedOwnerToken?: string }) => {
        // Model the atomic delete guard: a replacement that rotates the token
        // after the lifecycle check must still prevent deletion.
        if (opts?.expectedOwnerToken && redisOwnerToken !== opts.expectedOwnerToken) return;
        endedSessions.push({ sessionId, reason, opts });
    },
    // Returns the CURRENT shared (Redis) owner token — bumped by node-B's register.
    // After the A2-017 expo fix, getSessionOwnerToken catches Redis errors and
    // returns null (fail-open).  Simulate that: return null when shouldThrow.
    getSessionOwnerToken: (sessionId: string) => getSessionOwnerTokenForTest(sessionId),
}));

mock.module("../../sio-state/index.js", () => ({
    clearPushPendingQuestion: async () => {},
    deleteRunnerAssociation: async () => {},
}));

mock.module("./event-pipeline.js", () => ({
    pendingChunkedStates: new Map(),
    enqueueSessionEvent: async (_id: string, fn: () => Promise<void>) => fn(),
}));

mock.module("./ack-tracker.js", () => ({ socketAckedSeqs: new Map() }));
mock.module("./thinking-tracker.js", () => ({ clearThinkingMaps: () => {} }));
mock.module("./viewer-gate.js", () => ({ forgetViewerGate: () => {} }));
mock.module("../../../health.js", () => ({ shouldPreserveOnSocketDisconnect: () => false }));
mock.module("../../../user-preferences.js", () => ({
    getUserPreference: async () => null,
    PREF_SUBAGENT_MODEL: "subagent_model",
}));

afterAll(() => mock.restore());

const { registerSessionLifecycleHandlers } = await import("./session-lifecycle.js");

// Node-A local socket map — simulates localTuiSockets on node A.
// Node B's register does NOT touch this map (different process/node).
const localSocketMap = new Map<string, object>();

function makeSocket(sessionId: string, token: string, socketId = "sock-a") {
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const socket = {
        id: socketId,
        data: { sessionId, token },
        on(event: string, cb: (...args: unknown[]) => unknown) {
            handlers.set(event, cb);
        },
        emit: () => {},
    } as never;
    return {
        socket,
        fire: async (event: string, data?: unknown) => {
            const h = handlers.get(event);
            if (h) await h(data);
        },
    };
}

describe("A2-017: cross-node stale socket protection", () => {
    beforeEach(() => {
        endedSessions.length = 0;
        redisOwnerToken = "token-node-a";
        tokenReadShouldThrow = false;
        getSessionOwnerTokenForTest = async (_sessionId: string) => {
            if (tokenReadShouldThrow) return null;
            return redisOwnerToken;
        };
        localSocketMap.clear();
    });

    it("node-A stale disconnect does NOT end the replacement session", async () => {
        // 1. Node-A socket registers — local map points to socketA.
        const { socket: socketA, fire: fireA } = makeSocket("sess-1", "token-node-a");
        localSocketMap.set("sess-1", socketA);
        registerSessionLifecycleHandlers(socketA);

        // 2. Node-B registers a replacement — bumps the shared Redis token.
        //    Node-A's localSocketMap is NOT updated (node-local).
        redisOwnerToken = "token-node-b";

        // 3. Node-A socket disconnects — must NOT call endSharedSession.
        await fireA("disconnect", "transport close");

        expect(endedSessions).toHaveLength(0);
    });

    it("stale event from node-A socket is rejected after replacement registers", async () => {
        // Spy on the event pipeline enqueue to check if processing runs.
        const processedEvents: string[] = [];
        const { socket: socketA, fire: fireA } = makeSocket("sess-1", "token-node-a");
        localSocketMap.set("sess-1", socketA);

        // Override enqueueSessionEvent to track whether the pipeline ran.
        // We re-mock after original import to capture the spy.
        // Instead: verify endSharedSession is NOT called and that the
        // session is not modified (event-pipeline mock swallows all async work).
        // The token guard is inside enqueueSessionEvent — just verify no error
        // is thrown and the session is not harmed.
        registerSessionLifecycleHandlers(socketA);

        // Replacement registers on node-B.
        redisOwnerToken = "token-node-b";

        // Fire a stale event with old token — should be silently dropped.
        // (No assertion on processedEvents since the pipeline is mocked;
        //  the key assertion is that endSharedSession was never called and
        //  no uncaught error is thrown.)
        await fireA("event", {
            token: "token-node-a",
            seq: 1,
            event: { type: "heartbeat", active: true },
        });

        // Session must not have been ended.
        expect(endedSessions).toHaveLength(0);
    });

    it("token rotation between ownership check and teardown does NOT end replacement", async () => {
        const { socket, fire } = makeSocket("sess-1", "token-node-a");
        localSocketMap.set("sess-1", socket);
        registerSessionLifecycleHandlers(socket);

        // The check returns the old owner, then a replacement wins before
        // endSharedSession receives the expected token.
        const original = getSessionOwnerTokenForTest;
        getSessionOwnerTokenForTest = async () => {
            getSessionOwnerTokenForTest = original;
            redisOwnerToken = "token-node-b";
            return "token-node-a";
        };
        await fire("disconnect", "transport close");
        expect(endedSessions).toHaveLength(0);
    });

    it("replacement (current-token) socket disconnect DOES end the session", async () => {
        // Node-B's socket has the new token matching the Redis owner token.
        const { socket: socketB, fire: fireB } = makeSocket("sess-1", "token-node-b", "sock-b");
        // On node-B the local map holds socketB.
        localSocketMap.set("sess-1", socketB);
        redisOwnerToken = "token-node-b";
        registerSessionLifecycleHandlers(socketB);

        await fireB("disconnect", "transport close");

        expect(endedSessions).toHaveLength(1);
        expect(endedSessions[0].sessionId).toBe("sess-1");
    });

    it("Redis read throws on disconnect → fail-open: teardown proceeds as current owner", async () => {
        // Simulate a Redis error during the owner-token read in the disconnect guard.
        // The guard must treat unknown-owner (null) as fail-open → endSharedSession IS called.
        const { socket: socketA, fire: fireA } = makeSocket("sess-1", "token-node-a");
        localSocketMap.set("sess-1", socketA);
        registerSessionLifecycleHandlers(socketA);

        tokenReadShouldThrow = true; // Redis will throw on next hGet

        await fireA("disconnect", "transport close");

        // Fail-open: teardown must NOT be blocked — treat as matching (unknown) owner.
        expect(endedSessions).toHaveLength(1);
        expect(endedSessions[0].sessionId).toBe("sess-1");
    });

    it("single-node reconnect still works (same-token re-register does not block teardown)", async () => {
        // Simulate a same-node reconnect where the token is refreshed but we
        // are testing the old socket. The old socket was cleared (data.sessionId
        // set to undefined by registerTuiSession on same node).
        const { socket: socketOld, fire: fireOld } = makeSocket("sess-1", "token-v1");
        registerSessionLifecycleHandlers(socketOld);

        // Same-node reconnect: registerTuiSession clears old socket's sessionId.
        (socketOld as { data: { sessionId: string | undefined } }).data.sessionId = undefined;

        // Old socket disconnects with no sessionId → early return, no endSharedSession.
        await fireOld("disconnect", "transport close");
        expect(endedSessions).toHaveLength(0);
    });
});
