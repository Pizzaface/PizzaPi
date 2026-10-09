// ============================================================================
// connection.disconnect.test.ts — disconnect() must never send session_end
// for a suspending session (the relay record must survive the worker exit),
// and must forward `final` through to a real quit's session_end otherwise.
// ============================================================================

import { describe, expect, mock, test } from "bun:test";
import { disconnect } from "./connection.js";

function makeRctx(overrides: Record<string, unknown> = {}) {
    const emit = mock(() => {});
    const removeAllListeners = mock(() => {});
    const disconnectSocket = mock(() => {});
    const sioSocket = {
        connected: true,
        emit,
        removeAllListeners,
        disconnect: disconnectSocket,
    };
    const rctx = {
        relay: { sessionId: "s1", token: "tok", shareUrl: "u", seq: 0, ackedSeq: 0 },
        sioSocket,
        suspending: false,
        pendingAskUserQuestion: null,
        pendingPlanMode: null,
        pendingApproval: null,
        setRelayStatus: () => {},
        disconnectedStatusText: () => "Disconnected",
        ...overrides,
    };
    return { rctx: rctx as any, sioSocket, emit };
}

describe("disconnect", () => {
    test("suspending session: no session_end is emitted, socket is still torn down", () => {
        const { rctx, emit, sioSocket } = makeRctx({ suspending: true });

        disconnect(rctx);

        expect(emit).not.toHaveBeenCalled();
        expect(sioSocket.disconnect).toHaveBeenCalledTimes(1);
        expect(rctx.relay).toBeNull();
    });

    test("real quit (final:true, not suspending): session_end carries final:true", () => {
        const { rctx, emit } = makeRctx({ suspending: false });

        disconnect(rctx, undefined, { final: true });

        expect(emit).toHaveBeenCalledTimes(1);
        expect(emit).toHaveBeenCalledWith("session_end", { sessionId: "s1", token: "tok", final: true });
    });

    test("reload/new/resume (no final, not suspending): session_end carries final:false", () => {
        const { rctx, emit } = makeRctx({ suspending: false });

        disconnect(rctx);

        expect(emit).toHaveBeenCalledTimes(1);
        expect(emit).toHaveBeenCalledWith("session_end", { sessionId: "s1", token: "tok", final: false });
    });
});
