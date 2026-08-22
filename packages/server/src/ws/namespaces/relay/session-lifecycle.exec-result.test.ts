// ============================================================================
// session-lifecycle.exec-result.test.ts
// Regression: exec_result forwarded to viewers must be stamped with the
// originating sessionId so viewers can drop stale results after a switch.
// ============================================================================

import { afterAll, describe, it, expect, mock, beforeEach } from "bun:test";
import type { RelaySocket } from "./types.js";

// ── Captures ──────────────────────────────────────────────────────────────────

const broadcasts: Array<{ sessionId: string; event: string; data: unknown }> = [];

const mockBroadcastToViewers = mock(
    (sessionId: string, event: string, data: unknown) => {
        broadcasts.push({ sessionId, event, data });
    },
);

// ── Mocks ─────────────────────────────────────────────────────────────────────

mock.module("../../sio-registry.js", () => ({
    registerTuiSession: async () => ({
        sessionId: "sess-A",
        token: "tok",
        shareUrl: "",
        parentSessionId: null,
        wasDelinked: false,
    }),
    getLocalTuiSocket: () => undefined,
    getSessionOwnerToken: async () => "tok",
    broadcastToViewers: mockBroadcastToViewers,
    endSharedSession: async () => {},
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

function makeSocket(sessionId: string | undefined, token = "tok") {
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const socket = {
        id: "sock-1",
        data: { sessionId, token },
        on(event: string, cb: (...args: unknown[]) => unknown) {
            handlers.set(event, cb);
        },
        emit: () => {},
    } as unknown as RelaySocket;
    const fire = (event: string, data?: unknown) => handlers.get(event)!(data);
    return { socket, fire };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("exec_result forwarding", () => {
    beforeEach(() => {
        broadcasts.length = 0;
        mockBroadcastToViewers.mockClear();
    });

    it("stamps sessionId onto the broadcast payload", async () => {
        const { socket, fire } = makeSocket("sess-A");
        registerSessionLifecycleHandlers(socket);

        // Register the session so socket.data.sessionId is populated
        await fire("register", { sessionId: "sess-A", token: "tok", cwd: "/", shareUrl: "" });

        const payload = { id: "req-1", ok: true, command: "list_resume_sessions", result: [] };
        fire("exec_result", payload);

        expect(mockBroadcastToViewers).toHaveBeenCalledTimes(1);
        const [broadcastedSessionId, event, data] = mockBroadcastToViewers.mock.calls[0] as [string, string, unknown];
        expect(broadcastedSessionId).toBe("sess-A");
        expect(event).toBe("exec_result");
        // sessionId must be stamped
        expect((data as Record<string, unknown>).sessionId).toBe("sess-A");
        // original fields preserved
        expect((data as Record<string, unknown>).id).toBe("req-1");
        expect((data as Record<string, unknown>).command).toBe("list_resume_sessions");
    });

    it("does not forward if socket has no sessionId", () => {
        const { socket, fire } = makeSocket(undefined);
        registerSessionLifecycleHandlers(socket);

        fire("exec_result", { id: "req-2", ok: false, command: "get_fork_messages", error: "no" });

        expect(mockBroadcastToViewers).not.toHaveBeenCalled();
    });
});
