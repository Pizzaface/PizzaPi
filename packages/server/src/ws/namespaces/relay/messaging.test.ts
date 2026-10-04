import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

const mockGetSharedSession = mock(async (_id: string) => null as any);
const mockGetLocalTuiSocket = mock((_id: string) => undefined as any);
const mockEmitToRelaySessionVerified = mock(async (_id: string, _event: string, _payload: any) => false);
const mockEmitToRelaySessionInputAck = mock(async (_id: string, _event: string, _payload: any) => ({ hadListeners: false, delivered: false }));
const mockHasRelaySessionListener = mock(async (_id: string) => false);
const mockBroadcastToSessionViewers = mock((_sessionId: string, _event: string, _payload: any) => {});
const mockGetChildSessions = mock(async (_parentId: string) => [] as string[]);
const mockIsChildOfParent = mock(async (_parentId: string, _childId: string) => true);
const mockIsPendingParentDelinkChild = mock(async (_targetId: string, _senderId: string) => false);
const mockRefreshChildSessionsTTL = mock(async (_parentId: string) => {});
const mockPushTriggerHistory = mock(async (_sessionId: string, _entry: any) => {});
const mockRecordTriggerResponse = mock(async (_sessionId: string, _triggerId: string, _response: any) => {});

mock.module("../../sio-registry.js", () => ({
    getSharedSession: mockGetSharedSession,
    getSharedSessionSummary: mockGetSharedSession,
    getLocalTuiSocket: mockGetLocalTuiSocket,
    emitToRelaySessionVerified: mockEmitToRelaySessionVerified,
    emitToRelaySessionInputAck: mockEmitToRelaySessionInputAck,
    hasRelaySessionListener: mockHasRelaySessionListener,
    broadcastToSessionViewers: mockBroadcastToSessionViewers,
}));

mock.module("../../sio-state/index.js", () => ({
    acquireSessionOwnershipLock: async () => {},
    releaseSessionOwnershipLock: async () => {},
    getChildSessions: mockGetChildSessions,
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
        mockEmitToRelaySessionInputAck.mockReset();
        mockHasRelaySessionListener.mockReset();
        mockGetChildSessions.mockReset();
        mockIsChildOfParent.mockReset();
        mockIsPendingParentDelinkChild.mockReset();
        mockRefreshChildSessionsTTL.mockReset();
        mockPushTriggerHistory.mockReset();
        mockRecordTriggerResponse.mockReset();

        mockEmitToRelaySessionInputAck.mockResolvedValue({ hadListeners: false, delivered: false });
        mockHasRelaySessionListener.mockResolvedValue(false);
        mockGetChildSessions.mockResolvedValue([]);
        mockIsChildOfParent.mockResolvedValue(true);
        mockIsPendingParentDelinkChild.mockResolvedValue(false);
        mockRefreshChildSessionsTTL.mockResolvedValue(undefined);
        mockPushTriggerHistory.mockResolvedValue(undefined);
        mockRecordTriggerResponse.mockResolvedValue(undefined);
    });

    for (const local of [true, false]) {
        for (const deliverAs of ["steer", "input"] as const) {
            test(`delivers ${deliverAs} input ${local ? "locally" : "across nodes"}`, async () => {
                const socket = createMockSocket("parent-1");
                const emit = mock((_event: string, _data: any, cb?: (err: unknown, response: unknown) => void) => cb?.(null, true));
                const timeout = mock((_ms: number) => ({ emit }));
                mockGetSharedSession.mockImplementation(async (id: string) => {
                    if (id === "parent-1") return { userId: "u1", parentSessionId: null, linkedParentId: null } as any;
                    if (id === "child-1") return { userId: "u1", parentSessionId: "parent-1", linkedParentId: "parent-1" } as any;
                    return null;
                });
                mockGetLocalTuiSocket.mockReturnValue(local ? { connected: true, timeout } : undefined);
                mockEmitToRelaySessionInputAck.mockResolvedValue({ hadListeners: true, delivered: true });
                registerMessagingHandlers(socket as any);

                await socket.fireEvent("session_message", {
                    token: "relay-token", targetSessionId: "child-1", message: "Change direction", deliverAs,
                });

                const payload = {
                    text: "Message from linked session parent-1:\n\nChange direction", attachments: [], client: "agent",
                    fromSessionId: "parent-1",
                    deliverAs: deliverAs === "steer" ? "steer" : "followUp",
                };
                expect(mockIsChildOfParent).toHaveBeenCalledWith("parent-1", "child-1");
                if (local) expect(emit).toHaveBeenCalledWith("input", payload, expect.any(Function));
                else expect(mockEmitToRelaySessionInputAck).toHaveBeenCalledWith("child-1", "input", payload);
            });
        }
    }

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

    test("delivers child to parent via target parent and explicit parent sessionId", async () => {
        for (const payloadTarget of [{ target: "parent" }, { targetSessionId: "parent-1" }] as const) {
            const socket = createMockSocket("child-1");
            const ack = mock((_result: any) => {});
            mockGetSharedSession.mockImplementation(async (id: string) => {
                if (id === "child-1") return { userId: "u1", parentSessionId: null, linkedParentId: "parent-1" } as any;
                if (id === "parent-1") return { userId: "u1", parentSessionId: null, linkedParentId: null } as any;
                return null;
            });
            mockEmitToRelaySessionInputAck.mockResolvedValue({ hadListeners: true, delivered: true });
            registerMessagingHandlers(socket as any);

            await socket.fireEvent("session_message", { token: "relay-token", message: "hi", deliverAs: "steer", ...payloadTarget }, ack);

            expect(ack).toHaveBeenLastCalledWith({ ok: true, delivered: ["parent-1"], errors: [] });
            expect(mockIsChildOfParent).toHaveBeenCalledWith("parent-1", "child-1");
        }
    });

    test("broadcasts only live direct children and reports partial failures", async () => {
        const socket = createMockSocket("parent-1");
        const ack = mock((_result: any) => {});
        mockGetChildSessions.mockResolvedValue(["child-live", "child-offline", "grandchild"]);
        mockGetSharedSession.mockImplementation(async (id: string) => {
            if (id === "parent-1") return { userId: "u1", parentSessionId: null, linkedParentId: null } as any;
            if (id === "child-live") return { userId: "u1", parentSessionId: "parent-1", linkedParentId: "parent-1" } as any;
            if (id === "child-offline") return { userId: "u1", parentSessionId: "parent-1", linkedParentId: "parent-1" } as any;
            if (id === "grandchild") return { userId: "u1", parentSessionId: "child-live", linkedParentId: "child-live" } as any;
            return null;
        });
        mockHasRelaySessionListener.mockImplementation(async (id: string) => id === "child-live");
        mockEmitToRelaySessionInputAck.mockImplementation(async (id: string) => ({ hadListeners: true, delivered: id === "child-live" }));
        registerMessagingHandlers(socket as any);

        await socket.fireEvent("session_message", { token: "relay-token", target: "children", message: "go", deliverAs: "steer" }, ack);

        expect(mockEmitToRelaySessionInputAck).toHaveBeenCalledTimes(1);
        expect(mockEmitToRelaySessionInputAck).toHaveBeenCalledWith("child-live", "input", expect.any(Object));
        expect(ack).toHaveBeenCalledWith({ ok: true, delivered: ["child-live"], errors: [] });
    });

    test("reports child disconnecting during attempted broadcast delivery", async () => {
        const socket = createMockSocket("parent-1");
        const ack = mock((_result: any) => {});
        mockGetChildSessions.mockResolvedValue(["child-1"]);
        mockGetSharedSession.mockImplementation(async (id: string) => {
            if (id === "parent-1") return { userId: "u1", parentSessionId: null, linkedParentId: null } as any;
            if (id === "child-1") return { userId: "u1", parentSessionId: "parent-1", linkedParentId: "parent-1" } as any;
            return null;
        });
        mockHasRelaySessionListener.mockResolvedValue(true);
        mockEmitToRelaySessionInputAck.mockResolvedValue({ hadListeners: true, delivered: false });
        registerMessagingHandlers(socket as any);

        await socket.fireEvent("session_message", { token: "relay-token", target: "children", message: "go", deliverAs: "steer" }, ack);

        expect(ack).toHaveBeenCalledWith({ ok: false, delivered: [], errors: [{ targetSessionId: "child-1", error: "Target session did not acknowledge delivery" }] });
    });

    test("denies cross-user unrelated self and pending-delink traffic", async () => {
        const cases = [
            { name: "cross-user", target: "other", other: { userId: "u2", parentSessionId: "parent-1", linkedParentId: "parent-1" }, pending: false, linked: true, error: "Target session belongs to a different user" },
            { name: "unrelated", target: "other", other: { userId: "u1", parentSessionId: null, linkedParentId: null }, pending: false, linked: true, error: "Target is not a linked parent or direct child of the sender" },
            { name: "self", target: "parent-1", other: { userId: "u1", parentSessionId: null, linkedParentId: null }, pending: false, linked: true, error: "Target is not a linked parent or direct child of the sender" },
            { name: "pending parent-to-child", target: "child-1", other: { userId: "u1", parentSessionId: "parent-1", linkedParentId: "parent-1" }, pending: true, linked: true, error: "Target session is not a child of the sender" },
            { name: "pending child-to-parent", sender: "child-1", target: "parent-1", senderData: { userId: "u1", parentSessionId: "parent-1", linkedParentId: "parent-1" }, other: { userId: "u1", parentSessionId: null, linkedParentId: null }, pending: true, linked: true, error: "Sender is no longer a child" },
        ];
        for (const c of cases) {
            const socket = createMockSocket(c.sender ?? "parent-1");
            const ack = mock((_result: any) => {});
            mockGetSharedSession.mockImplementation(async (id: string) => {
                if (id === (c.sender ?? "parent-1")) return (c.senderData ?? { userId: "u1", parentSessionId: null, linkedParentId: null }) as any;
                if (id === c.target) return c.other as any;
                return null;
            });
            mockIsPendingParentDelinkChild.mockResolvedValue(c.pending);
            mockIsChildOfParent.mockResolvedValue(c.linked);
            registerMessagingHandlers(socket as any);
            await socket.fireEvent("session_message", { token: "relay-token", targetSessionId: c.target, message: c.name, deliverAs: "steer" }, ack);
            expect(ack.mock.calls.at(-1)?.[0].ok).toBe(false);
            expect(JSON.stringify(ack.mock.calls.at(-1)?.[0])).toContain(c.error);
        }
    });

    test("rejects malformed empty targets and negative input ack", async () => {
        const socket = createMockSocket("parent-1");
        const ack = mock((_result: any) => {});
        mockGetSharedSession.mockImplementation(async (id: string) => {
            if (id === "parent-1") return { userId: "u1", parentSessionId: null, linkedParentId: null } as any;
            if (id === "child-1") return { userId: "u1", parentSessionId: "parent-1", linkedParentId: "parent-1" } as any;
            return null;
        });
        registerMessagingHandlers(socket as any);

        await socket.fireEvent("session_message", null, ack);
        await socket.fireEvent("session_message", { token: "relay-token", targetSessionId: "child-1", target: "children", message: "bad" }, ack);
        mockEmitToRelaySessionInputAck.mockResolvedValue({ hadListeners: true, delivered: false });
        await socket.fireEvent("session_message", { token: "relay-token", targetSessionId: "child-1", message: "no ack", deliverAs: "steer" }, ack);

        expect(ack.mock.calls[0][0]).toMatchObject({ ok: false, error: "Invalid token" });
        expect(ack.mock.calls[1][0]).toMatchObject({ ok: false, error: expect.stringContaining("exactly one target") });
        expect(ack.mock.calls[2][0]).toMatchObject({ ok: false, errors: [{ targetSessionId: "child-1", error: "Target session did not acknowledge delivery" }] });
    });
});
