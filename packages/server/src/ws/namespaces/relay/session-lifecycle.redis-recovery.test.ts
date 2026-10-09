// ============================================================================
// session-lifecycle.redis-recovery.test.ts
//
// Drives the REAL relay disconnect handler (registerSessionLifecycleHandlers)
// with a socket marked by the real redis-adapter-recovery module, instead of
// only asserting on the WeakSet flag in isolation (redis-adapter-recovery.test.ts).
//
// Regression (P2, class of bug): every early-return in this disconnect
// handler — recovery mark, Redis owner-lookup failure, stale owner,
// shutdown-preserve — used to leave the disconnecting socket behind in
// `localTuiSockets`. If the worker never reconnects, that dead entry pins
// the session as "has a live local socket" forever, and
// `sweepOrphanedSessions` can never reclaim it. The handler must forget the
// local socket entry (when it's still the current one) on every one of
// those early returns.
// ============================================================================

import { afterAll, describe, it, expect, mock } from "bun:test";
import type { RelaySocket } from "./types.js";

const endedSessions: Array<{ sessionId: string }> = [];
const forgottenCalls: Array<{ sessionId: string; socket: unknown }> = [];

// Node-local socket map — mirrors the real localTuiSockets Map so
// getLocalTuiSocket/forgetLocalTuiSocketIfCurrent behave like the real
// sio-registry implementation (same-socket match only).
const localSocketMap = new Map<string, unknown>();

let sharedOwnerToken = "tok";
let ownerLookupShouldThrow = false;
let shouldPreserveForShutdown = false;

mock.module("../../../events/engine.js", () => ({
    drainPendingDeliveries: async () => 0,
    drainPendingResponseRelays: async () => 0,
}));
mock.module("../../../events/transport.js", () => ({
    createEngineDeps: () => ({} as never),
}));

mock.module("../../sio-registry.js", () => ({
    registerTuiSession: async () => ({
        sessionId: "sess-A",
        token: "tok",
        shareUrl: "",
        parentSessionId: null,
        wasDelinked: false,
    }),
    getLocalTuiSocket: (sessionId: string) => localSocketMap.get(sessionId),
    forgetLocalTuiSocketIfCurrent: (sessionId: string, socket: unknown) => {
        forgottenCalls.push({ sessionId, socket });
        if (localSocketMap.get(sessionId) === socket) localSocketMap.delete(sessionId);
    },
    broadcastToViewers: () => {},
    endSharedSession: async (sessionId: string) => {
        endedSessions.push({ sessionId });
        return true;
    },
    getSessionOwnerToken: async () => {
        if (ownerLookupShouldThrow) throw new Error("redis down (test)");
        return sharedOwnerToken;
    },
    suspendSharedSession: async () => true,
    cancelSuspendedSession: async () => false,
    getSharedSession: async () => null,
    emitToRunner: () => {},
    getLocalRunnerSocket: () => null,
    waitForLocalTuiSocket: async () => false,
    emitToRelaySessionVerified: async () => false,
    linkSessionToRunner: async () => {},
    recordRunnerSession: async () => {},
    broadcastToSessionViewers: () => {},
}));

mock.module("../../sio-state/index.js", () => ({
    acquireSessionOwnershipLock: async () => {},
    releaseSessionOwnershipLock: async () => {},
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
mock.module("../../../health.js", () => ({
    shouldPreserveOnSocketDisconnect: () => shouldPreserveForShutdown,
}));
mock.module("../../../user-preferences.js", () => ({
    getUserPreference: async () => null,
    PREF_SUBAGENT_MODEL: "subagent_model",
}));

afterAll(() => mock.restore());

// Real module — exercises the actual mark used by the live Redis recovery path.
const { markRedisAdapterRecoverySocket } = await import("../../../redis-adapter-recovery.js");
const { registerSessionLifecycleHandlers } = await import("./session-lifecycle.js");

function makeSocket(sessionId: string, token = "tok", id = "sock-1") {
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const socket = {
        id,
        data: { sessionId, token },
        on(event: string, cb: (...args: unknown[]) => unknown) {
            handlers.set(event, cb);
        },
        emit: () => {},
    } as unknown as RelaySocket;
    return { socket, fire: (event: string, ...args: unknown[]) => handlers.get(event)!(...args) };
}

describe("session-lifecycle disconnect handler — real recovery-mark path", () => {
    it("preserves the session and forgets the local socket entry when recovery-marked", async () => {
        localSocketMap.clear();
        endedSessions.length = 0;
        forgottenCalls.length = 0;

        const { socket, fire } = makeSocket("sess-A");
        localSocketMap.set("sess-A", socket);
        registerSessionLifecycleHandlers(socket);
        markRedisAdapterRecoverySocket(socket);

        await fire("disconnect", "transport close");

        // Recovery preserves the session — no destructive teardown.
        expect(endedSessions).toHaveLength(0);
        // But the dead local-socket entry must not be left behind: if the
        // worker never reconnects, sweepOrphanedSessions must be able to
        // reclaim this session instead of treating it as permanently live.
        expect(forgottenCalls).toHaveLength(1);
        expect(forgottenCalls[0]).toEqual({ sessionId: "sess-A", socket });
        expect(localSocketMap.has("sess-A")).toBe(false);
    });

    it("forgets the local socket entry when the Redis owner-lookup fails", async () => {
        localSocketMap.clear();
        endedSessions.length = 0;
        forgottenCalls.length = 0;
        ownerLookupShouldThrow = true;

        const { socket, fire } = makeSocket("sess-B");
        localSocketMap.set("sess-B", socket);
        registerSessionLifecycleHandlers(socket);

        await fire("disconnect", "transport close");

        ownerLookupShouldThrow = false;
        expect(endedSessions).toHaveLength(0);
        expect(localSocketMap.has("sess-B")).toBe(false);
    });

    it("forgets the local socket entry on a stale/unknown owner", async () => {
        localSocketMap.clear();
        endedSessions.length = 0;
        forgottenCalls.length = 0;
        sharedOwnerToken = "someone-else";

        const { socket, fire } = makeSocket("sess-C", "tok");
        localSocketMap.set("sess-C", socket);
        registerSessionLifecycleHandlers(socket);

        await fire("disconnect", "transport close");

        sharedOwnerToken = "tok";
        expect(endedSessions).toHaveLength(0);
        expect(localSocketMap.has("sess-C")).toBe(false);
    });

    it("forgets the local socket entry during shutdown-preserve", async () => {
        localSocketMap.clear();
        endedSessions.length = 0;
        forgottenCalls.length = 0;
        shouldPreserveForShutdown = true;

        const { socket, fire } = makeSocket("sess-D");
        localSocketMap.set("sess-D", socket);
        registerSessionLifecycleHandlers(socket);

        await fire("disconnect", "server shutting down");

        shouldPreserveForShutdown = false;
        expect(endedSessions).toHaveLength(0);
        expect(localSocketMap.has("sess-D")).toBe(false);
    });

    it("does NOT forget a replacement socket that already took over (guard 1)", async () => {
        localSocketMap.clear();
        endedSessions.length = 0;
        forgottenCalls.length = 0;

        const { socket: oldSocket, fire: fireOld } = makeSocket("sess-E", "tok", "sock-old");
        const newSocket = { id: "sock-new" } as unknown as RelaySocket;
        // A newer socket already re-registered locally for this session.
        localSocketMap.set("sess-E", newSocket);
        registerSessionLifecycleHandlers(oldSocket);

        await fireOld("disconnect", "transport close");

        expect(endedSessions).toHaveLength(0);
        // The replacement's entry must survive — only the stale socket's own
        // entry (if it were still current) would ever be forgotten.
        expect(localSocketMap.get("sess-E")).toBe(newSocket);
        expect(forgottenCalls).toHaveLength(0);
    });
});
