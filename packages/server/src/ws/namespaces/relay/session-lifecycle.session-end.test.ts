// ============================================================================
// session-lifecycle.session-end.test.ts — Regression test: a graceful
// session_end (e.g. subagent mirror finish()) is a CONFIRMED terminal end and
// must end the session with confirmedTerminal so the child is removed from
// its parent's membership set.
// ============================================================================

import { afterAll, describe, it, expect, beforeEach, mock } from "bun:test";

const endedSessions: Array<{ sessionId: string; reason?: string; opts?: unknown }> = [];

mock.module("../../sio-registry.js", () => ({
    registerTuiSession: async () => ({ sessionId: "s", token: "t", shareUrl: "", parentSessionId: null, wasDelinked: false }),
    getLocalTuiSocket: () => undefined,
    broadcastToViewers: () => {},
    endSharedSession: async (sessionId: string, reason?: string, opts?: unknown) => {
        endedSessions.push({ sessionId, reason, opts });
    },
    // A2-017: cross-node owner token guard — return matching token so
    // the existing disconnect tests are not blocked by the stale-socket guard.
    getSessionOwnerToken: async () => "tok",
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

function makeSocket(sessionId: string, token = "tok") {
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    return {
        socket: {
            id: "sock-1",
            data: { sessionId, token },
            on(event: string, cb: (...args: unknown[]) => unknown) {
                handlers.set(event, cb);
            },
            emit: () => {},
        } as never,
        fire: async (event: string, data?: unknown) => handlers.get(event)!(data),
    };
}

describe("session_end handler", () => {
    beforeEach(() => {
        endedSessions.length = 0;
    });

    it("ends the session with confirmedTerminal so parent membership is removed", async () => {
        const { socket, fire } = makeSocket("child-mirror");
        registerSessionLifecycleHandlers(socket);

        await fire("session_end", { token: "tok" });

        expect(endedSessions).toEqual([
            { sessionId: "child-mirror", reason: "Session ended", opts: { confirmedTerminal: true } },
        ]);
    });

    it("plain disconnect does NOT mark the end as confirmed terminal", async () => {
        const { socket, fire } = makeSocket("child-mirror");
        registerSessionLifecycleHandlers(socket);

        await fire("disconnect", "transport close");

        expect(endedSessions.length).toBe(1);
        expect(endedSessions[0].sessionId).toBe("child-mirror");
        expect(endedSessions[0].opts).toBeUndefined();
    });
});
