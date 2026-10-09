// ============================================================================
// session-lifecycle.session-end.test.ts — Regression test: a graceful
// session_end (e.g. subagent mirror finish()) is a CONFIRMED terminal end and
// must end the session with confirmedTerminal so the child is removed from
// its parent's membership set.
// ============================================================================

import { afterAll, describe, it, expect, beforeEach, mock } from "bun:test";

const endedSessions: Array<{ sessionId: string; reason?: string; opts?: unknown }> = [];
let sharedOwnerToken = "tok";
let registerSession: (...args: unknown[]) => Promise<{
    sessionId: string;
    token: string;
    shareUrl: string;
    parentSessionId: string | null;
    wasDelinked: boolean;
}> = async () => ({
    sessionId: "s",
    token: "t",
    shareUrl: "",
    parentSessionId: null,
    wasDelinked: false,
});

// Unified event engine — the register-drain hook is incidental to this test.
mock.module("../../../events/engine.js", () => ({
    drainPendingDeliveries: async () => 0,
    drainPendingResponseRelays: async () => 0,
    publishEvent: async () => ({ event: null, created: false, deliveries: [], spawnedSessions: [] }),
    sweepExpiredContracts: async () => 0,
}));
mock.module("../../../events/transport.js", () => ({
    createEngineDeps: () => ({} as never),
    emitTriggerResponse: async () => false,
    wakeOfflineSession: async () => false,
}));

mock.module("../../sio-registry.js", () => ({
    registerTuiSession: (...args: unknown[]) => registerSession(...args),
    getLocalTuiSocket: () => undefined,
    broadcastToViewers: () => {},
    endSharedSession: async (
        sessionId: string,
        reason?: string,
        opts?: { onOwnerConfirmed?: () => void | Promise<void> },
    ) => {
        await opts?.onOwnerConfirmed?.();
        endedSessions.push({ sessionId, reason, opts });
        return true;
    },
    // A2-017: cross-node owner token guard — return matching token so
    // the existing disconnect tests are not blocked by the stale-socket guard.
    getSessionOwnerToken: async () => sharedOwnerToken,
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
    deleteChildSpawnBinding: async () => {},
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

let closed = 0;
function makeSocket(sessionId: string | undefined, token = "tok") {
    const handlers = new Map<string, (...args: any[]) => unknown>();
    const socket = {
        id: "sock-1",
        connected: true,
        data: { sessionId, token },
        on(event: string, cb: (...args: any[]) => unknown) {
            handlers.set(event, cb);
        },
        emit: () => {},
        conn: { close() { closed++; } },
    } as never;
    return {
        socket,
        fire: async (event: string, ...args: any[]) => handlers.get(event)!(...args),
        disconnect() { (socket as unknown as { connected: boolean }).connected = false; },
    };
}

describe("session_end handler", () => {
    beforeEach(() => {
        endedSessions.length = 0;
        sharedOwnerToken = "tok";
        registerSession = async () => ({
            sessionId: "s",
            token: "t",
            shareUrl: "",
            parentSessionId: null,
            wasDelinked: false,
        });
    });

    it("ends the session with confirmedTerminal so parent membership is removed", async () => {
        const { socket, fire } = makeSocket("child-mirror");
        registerSessionLifecycleHandlers(socket);

        let acknowledgement: { ended: boolean } | undefined;
        await fire("session_end", { token: "tok" }, (result: { ended: boolean }) => {
            acknowledgement = result;
        });

        expect(acknowledgement).toEqual({ ended: true });
        expect(endedSessions).toHaveLength(1);
        expect(endedSessions[0]).toEqual({
            sessionId: "child-mirror",
            reason: "Session ended",
            opts: expect.objectContaining({ confirmedTerminal: true, expectedOwnerToken: "tok" }),
        });
    });

    it("a session_end with final:true asks endSharedSession to kill terminals", async () => {
        // A real CLI quit sends `final: true` — this is the ONLY thing that
        // may authorize killing the session's terminals (see GM VD0KKFpB).
        const { socket, fire } = makeSocket("child-mirror");
        registerSessionLifecycleHandlers(socket);

        await fire("session_end", { token: "tok", final: true }, () => {});

        expect(endedSessions).toHaveLength(1);
        expect(endedSessions[0].opts).toMatchObject({ confirmedTerminal: true, killTerminals: true });
    });

    it("a session_end WITHOUT final (reload/new/resume/fork, /remote reconnect) never kills terminals", async () => {
        // Every session_shutdown reason other than a real quit — and
        // `/remote reconnect`, which re-registers the SAME session id right
        // after — must leave live PTYs running. Older CLIs that don't send
        // `final` at all must also fail safe to "not final".
        const { socket, fire } = makeSocket("child-mirror");
        registerSessionLifecycleHandlers(socket);

        await fire("session_end", { token: "tok" }, () => {});

        expect(endedSessions).toHaveLength(1);
        expect(endedSessions[0].opts).toMatchObject({ confirmedTerminal: true, killTerminals: false });
    });

    it("ignores non-function acknowledgement arguments", async () => {
        const { socket, fire } = makeSocket("child-mirror");
        registerSessionLifecycleHandlers(socket);
        await fire("session_end", { token: "tok" }, "not-a-callback");
        expect(endedSessions).toHaveLength(1);
    });

    it("stale cross-node session_end cannot end the replacement", async () => {
        const { socket, fire } = makeSocket("child-mirror", "old-token");
        sharedOwnerToken = "new-token";
        registerSessionLifecycleHandlers(socket);

        let acknowledgement: { ended: boolean } | undefined;
        await fire("session_end", { token: "old-token" }, (result: { ended: boolean }) => {
            acknowledgement = result;
        });

        expect(acknowledgement).toEqual({ ended: false });
        expect(endedSessions).toHaveLength(0);
    });

    it("a failed registration closes the transport instead of rejecting (unhandled rejection is fatal)", async () => {
        registerSession = async () => {
            throw new Error("Timed out acquiring session ownership lock for s");
        };
        closed = 0;
        const { socket, fire } = makeSocket(undefined);
        registerSessionLifecycleHandlers(socket);

        await expect(fire("register", { sessionId: "s", cwd: "/", ephemeral: true })).resolves.toBeUndefined();
        expect(closed).toBe(1);
        expect((socket as unknown as { data: { sessionId?: string } }).data.sessionId).toBeUndefined();
    });

    it("cleans up a registration that completes after disconnect", async () => {
        let resolveRegistration!: (value: Awaited<ReturnType<typeof registerSession>>) => void;
        registerSession = () =>
            new Promise((resolve) => {
                resolveRegistration = resolve;
            });
        const { socket, fire, disconnect } = makeSocket(undefined);
        registerSessionLifecycleHandlers(socket);

        const registering = fire("register", { sessionId: "late-child", cwd: "/", ephemeral: true });
        disconnect();
        await fire("disconnect", "transport close");
        resolveRegistration({
            sessionId: "late-child",
            token: "tok",
            shareUrl: "",
            parentSessionId: "parent",
            wasDelinked: false,
        });
        await registering;

        expect(endedSessions).toHaveLength(1);
        expect(endedSessions[0]).toMatchObject({ sessionId: "late-child", opts: { expectedOwnerToken: "tok" } });
    });

    it("plain disconnect does NOT mark the end as confirmed terminal", async () => {
        const { socket, fire } = makeSocket("child-mirror");
        registerSessionLifecycleHandlers(socket);

        await fire("disconnect", "transport close");

        expect(endedSessions.length).toBe(1);
        expect(endedSessions[0].sessionId).toBe("child-mirror");
        expect(endedSessions[0].opts).toEqual(expect.objectContaining({ expectedOwnerToken: "tok" }));
        expect(endedSessions[0].opts).not.toHaveProperty("confirmedTerminal", true);
    });
});
