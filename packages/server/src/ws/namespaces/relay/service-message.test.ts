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

import { registerServiceMessageHandler, checkServiceMessageSize, checkServiceMessageRateLimit } from "./service-message.js";
import type { ServiceEnvelope } from "@pizzapi/protocol";

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
        id: `mock-${sessionId ?? "none"}`,
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

    test("does not forward payloads that exceed the size cap", async () => {
        const socket = createMockSocket("sess-1");
        mockGetSharedSession.mockResolvedValue({ collabMode: true, runnerId: "runner-1" });
        registerServiceMessageHandler(socket as any);

        socket.fireEvent("service_message", {
            serviceId: "tunnel",
            type: "big",
            payload: "x".repeat(300 * 1024),
        });

        await new Promise((r) => setTimeout(r, 50));
        expect(mockEmitToRunner).not.toHaveBeenCalled();
    });

    test("drops messages once the per-socket rate limit is exceeded", async () => {
        const socket = createMockSocket("sess-1");
        mockGetSharedSession.mockResolvedValue({ collabMode: true, runnerId: "runner-1" });
        registerServiceMessageHandler(socket as any);

        const envelope = { serviceId: "tunnel", type: "ping", payload: {} };
        for (let i = 0; i < 55; i++) {
            socket.fireEvent("service_message", envelope);
        }

        await new Promise((r) => setTimeout(r, 50));
        expect(mockEmitToRunner).toHaveBeenCalledTimes(50);
    });
});

describe("checkServiceMessageSize", () => {
    test("allows small serializable envelopes", () => {
        const envelope: ServiceEnvelope = { serviceId: "svc", type: "ping", payload: { x: 1 } };
        const result = checkServiceMessageSize(envelope);
        expect(result.ok).toBe(true);
        expect(result.bytes).toBeGreaterThan(0);
    });

    test("rejects oversized payloads", () => {
        const envelope: ServiceEnvelope = { serviceId: "svc", type: "big", payload: "x".repeat(300 * 1024) };
        const result = checkServiceMessageSize(envelope);
        expect(result.ok).toBe(false);
        expect(result.bytes).toBeGreaterThan(256 * 1024);
    });

    test("rejects non-serializable payloads", () => {
        const payload: any = {};
        payload.self = payload;
        const envelope: ServiceEnvelope = { serviceId: "svc", type: "cyclic", payload };
        const result = checkServiceMessageSize(envelope);
        expect(result.ok).toBe(false);
    });
});

describe("checkServiceMessageRateLimit", () => {
    test("allows messages up to the per-window limit", () => {
        const state = { count: 0, resetAt: 0 };
        for (let i = 0; i < 50; i++) {
            expect(checkServiceMessageRateLimit(1000, state).allowed).toBe(true);
        }
        expect(checkServiceMessageRateLimit(1000, state).allowed).toBe(false);
    });

    test("resets the counter after the window expires", () => {
        const state = { count: 50, resetAt: 2000 };
        const result = checkServiceMessageRateLimit(2000, state);
        expect(result.allowed).toBe(true);
        expect(state.count).toBe(1);
    });
});
