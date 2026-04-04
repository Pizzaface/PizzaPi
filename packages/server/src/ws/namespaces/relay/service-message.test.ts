import { afterAll, describe, test, expect, mock, beforeEach } from "bun:test";

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockGetSharedSession = mock(async (_id: string) => null as any);
const mockEmitToRunner = mock((..._args: any[]) => {});

mock.module("../../sio-registry/sessions.js", () => ({
    getSharedSession: mockGetSharedSession,
}));

mock.module("../../sio-registry/context.js", () => ({
    emitToRunner: mockEmitToRunner,
}));

mock.module("@pizzapi/tools", () => ({
    createLogger: () => ({
        info: () => {},
        warn: () => {},
        error: () => {},
        debug: () => {},
    }),
}));

import { registerServiceMessageHandler } from "./service-message.js";

// Restore module mocks after this file so they don't bleed into other
// test files sharing the same Bun worker process.
afterAll(() => mock.restore());

// ── Helpers ───────────────────────────────────────────────────────────────────

function createMockSocket(sessionId?: string) {
    const handlers = new Map<string, Function>();
    return {
        data: {
            sessionId: sessionId ?? null,
            token: "test-token",
        },
        on: (event: string, handler: Function) => {
            handlers.set(event, handler);
        },
        _handlers: handlers,
        fireEvent(event: string, data: unknown) {
            handlers.get(event)?.(data);
        },
    };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("registerServiceMessageHandler", () => {
    beforeEach(() => {
        mockGetSharedSession.mockReset();
        mockEmitToRunner.mockReset();
    });

    test("registers a service_message handler on the socket", () => {
        const socket = createMockSocket("sess-1");
        registerServiceMessageHandler(socket as any);
        expect(socket._handlers.has("service_message")).toBe(true);
    });

    test("does nothing when sessionId is not set", async () => {
        const socket = createMockSocket(undefined);
        (socket.data as any).sessionId = undefined;
        registerServiceMessageHandler(socket as any);

        socket.fireEvent("service_message", {
            serviceId: "tunnel",
            type: "tunnel_list",
            payload: {},
        });

        // Give async handlers time to settle
        await new Promise((r) => setTimeout(r, 50));
        expect(mockEmitToRunner).not.toHaveBeenCalled();
    });

    test("does nothing when session has no collabMode", async () => {
        const socket = createMockSocket("sess-1");
        mockGetSharedSession.mockResolvedValue({ collabMode: false, runnerId: "runner-1" });
        registerServiceMessageHandler(socket as any);

        socket.fireEvent("service_message", {
            serviceId: "tunnel",
            type: "tunnel_list",
            payload: {},
        });

        await new Promise((r) => setTimeout(r, 50));
        expect(mockEmitToRunner).not.toHaveBeenCalled();
    });

    test("does nothing when session has no runnerId", async () => {
        const socket = createMockSocket("sess-1");
        mockGetSharedSession.mockResolvedValue({ collabMode: true, runnerId: null });
        registerServiceMessageHandler(socket as any);

        socket.fireEvent("service_message", {
            serviceId: "tunnel",
            type: "tunnel_list",
            payload: {},
        });

        await new Promise((r) => setTimeout(r, 50));
        expect(mockEmitToRunner).not.toHaveBeenCalled();
    });

    test("forwards service_message to runner with sessionId attached", async () => {
        const socket = createMockSocket("sess-1");
        mockGetSharedSession.mockResolvedValue({ collabMode: true, runnerId: "runner-1" });
        registerServiceMessageHandler(socket as any);

        const envelope = {
            serviceId: "tunnel",
            type: "tunnel_expose",
            requestId: "req-123",
            payload: { port: 3000, name: "dev" },
        };

        socket.fireEvent("service_message", envelope);

        await new Promise((r) => setTimeout(r, 50));
        expect(mockEmitToRunner).toHaveBeenCalledTimes(1);
        expect(mockEmitToRunner).toHaveBeenCalledWith("runner-1", "service_message", {
            ...envelope,
            sessionId: "sess-1",
        });
    });

    test("does not forward when session is null", async () => {
        const socket = createMockSocket("sess-1");
        mockGetSharedSession.mockResolvedValue(null);
        registerServiceMessageHandler(socket as any);

        socket.fireEvent("service_message", {
            serviceId: "tunnel",
            type: "tunnel_list",
            payload: {},
        });

        await new Promise((r) => setTimeout(r, 50));
        expect(mockEmitToRunner).not.toHaveBeenCalled();
    });
});
