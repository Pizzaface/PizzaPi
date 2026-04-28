import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

const mockGetSharedSession = mock(async (_id: string) => null as any);
const mockGetLocalTuiSocket = mock((_id: string) => undefined as any);
const mockEmitToRelaySessionVerified = mock(async (_id: string, _event: string, _payload: any) => false);
const mockBroadcastToSessionViewers = mock((_sessionId: string, _event: string, _payload: any) => {});
const mockIsChildOfParent = mock(async (_parentId: string, _childId: string) => true);
const mockIsPendingParentDelinkChild = mock(async (_targetId: string, _senderId: string) => false);
const mockRefreshChildSessionsTTL = mock(async (_parentId: string) => {});
const mockPushTriggerHistory = mock(async (_sessionId: string, _entry: any) => {});
const mockRecordTriggerResponse = mock(async (_sessionId: string, _triggerId: string, _response: any) => {});

mock.module("../../sio-registry.js", () => ({
    getSharedSession: mockGetSharedSession,
    getLocalTuiSocket: mockGetLocalTuiSocket,
    emitToRelaySessionVerified: mockEmitToRelaySessionVerified,
    broadcastToSessionViewers: mockBroadcastToSessionViewers,
}));

mock.module("../../sio-state/index.js", () => ({
    isChildOfParent: mockIsChildOfParent,
    isPendingParentDelinkChild: mockIsPendingParentDelinkChild,
    refreshChildSessionsTTL: mockRefreshChildSessionsTTL,
}));

mock.module("../../../sessions/trigger-store.js", () => ({
    pushTriggerHistory: mockPushTriggerHistory,
    recordTriggerResponse: mockRecordTriggerResponse,
}));

import { registerMessagingHandlers } from "./messaging.js";

afterAll(() => mock.restore());

function createMockSocket(sessionId = "child-1") {
    const handlers = new Map<string, Function>();
    const emitted: Array<{ event: string; data: any }> = [];
    return {
        data: {
            sessionId,
            token: "relay-token",
        },
        on(event: string, handler: Function) {
            handlers.set(event, handler);
        },
        emit(event: string, data: any) {
            emitted.push({ event, data });
        },
        async fireEvent(event: string, data: any, ack?: (result: { ok: boolean; error?: string }) => void) {
            return await handlers.get(event)?.(data, ack);
        },
        _emitted: emitted,
        _handlers: handlers,
    };
}

describe("registerMessagingHandlers session_trigger acking", () => {
    beforeEach(() => {
        mockGetSharedSession.mockReset();
        mockGetLocalTuiSocket.mockReset();
        mockEmitToRelaySessionVerified.mockReset();
        mockBroadcastToSessionViewers.mockReset();
        mockIsChildOfParent.mockReset();
        mockIsPendingParentDelinkChild.mockReset();
        mockRefreshChildSessionsTTL.mockReset();
        mockPushTriggerHistory.mockReset();
        mockRecordTriggerResponse.mockReset();

        mockIsChildOfParent.mockResolvedValue(true);
        mockIsPendingParentDelinkChild.mockResolvedValue(false);
        mockRefreshChildSessionsTTL.mockResolvedValue(undefined);
        mockPushTriggerHistory.mockResolvedValue(undefined);
        mockRecordTriggerResponse.mockResolvedValue(undefined);
    });

    test("acks success after delivering a child trigger to the parent", async () => {
        const socket = createMockSocket("child-1");
        const parentSocketEmit = mock((_event: string, _data: any) => {});
        mockGetSharedSession.mockImplementation(async (id: string) => {
            if (id === "parent-1") return { userId: "u1" } as any;
            if (id === "child-1") return { userId: "u1" } as any;
            return null;
        });
        mockGetLocalTuiSocket.mockReturnValue({ connected: true, emit: parentSocketEmit } as any);

        registerMessagingHandlers(socket as any);
        const ack = mock((_result: { ok: boolean; error?: string }) => {});

        await socket.fireEvent("session_trigger", {
            token: "relay-token",
            trigger: {
                type: "session_complete",
                sourceSessionId: "child-1",
                targetSessionId: "parent-1",
                payload: { summary: "Done" },
                deliverAs: "followUp",
                expectsResponse: true,
                triggerId: "trigger-1",
                ts: new Date().toISOString(),
            },
        }, ack);

        expect(parentSocketEmit).toHaveBeenCalledWith("session_trigger", {
            trigger: expect.objectContaining({
                type: "session_complete",
                sourceSessionId: "child-1",
                targetSessionId: "parent-1",
            }),
        });
        expect(ack).toHaveBeenCalledWith({ ok: true });
    });

    test("acks failure when the parent session cannot be found", async () => {
        const socket = createMockSocket("child-1");
        mockGetSharedSession.mockImplementation(async (id: string) => {
            if (id === "child-1") return { userId: "u1" } as any;
            return null;
        });

        registerMessagingHandlers(socket as any);
        const ack = mock((_result: { ok: boolean; error?: string }) => {});

        await socket.fireEvent("session_trigger", {
            token: "relay-token",
            trigger: {
                type: "session_complete",
                sourceSessionId: "child-1",
                targetSessionId: "parent-1",
                payload: { summary: "Done" },
                deliverAs: "followUp",
                expectsResponse: true,
                triggerId: "trigger-1",
                ts: new Date().toISOString(),
            },
        }, ack);

        expect(ack).toHaveBeenCalledWith({ ok: false, error: "Target session parent-1 is not connected" });
    });
});
