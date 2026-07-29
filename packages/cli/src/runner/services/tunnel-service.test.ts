import { describe, test, expect, mock } from "bun:test";
import { TunnelService } from "./tunnel-service.js";

function createMockSocket() {
    const emitted: Array<[string, ...unknown[]]> = [];
    const listeners = new Map<string, Function[]>();

    return {
        emitted,
        listeners,
        emit: mock((...args: unknown[]) => {
            emitted.push(args as [string, ...unknown[]]);
        }),
        on: mock((event: string, handler: Function) => {
            listeners.set(event, [...(listeners.get(event) ?? []), handler]);
        }),
        off: mock((event: string, handler: Function) => {
            listeners.set(event, (listeners.get(event) ?? []).filter((fn) => fn !== handler));
        }),
    };
}

function createMockTunnelClient() {
    return {
        exposePort: mock((_port: number) => {}),
        unexposePort: mock((_port: number) => {}),
    };
}

function getServiceMessageHandler(socket: ReturnType<typeof createMockSocket>): Function {
    const handlers = socket.listeners.get("service_message") ?? [];
    expect(handlers).toHaveLength(1);
    return handlers[0]!;
}

function exposeViaMessage(socket: ReturnType<typeof createMockSocket>, sessionId: string, port: number, name?: string) {
    getServiceMessageHandler(socket)({
        serviceId: "tunnel",
        type: "tunnel_expose",
        sessionId,
        requestId: `req-expose-${sessionId}-${port}`,
        payload: { port, name },
    });
}

function unexposeViaMessage(socket: ReturnType<typeof createMockSocket>, sessionId: string, port: number) {
    getServiceMessageHandler(socket)({
        serviceId: "tunnel",
        type: "tunnel_unexpose",
        sessionId,
        requestId: `req-unexpose-${sessionId}-${port}`,
        payload: { port },
    });
}

describe("TunnelService", () => {
    test("setTunnelClient re-exposes already known ports", () => {
        const service = new TunnelService();
        const socket = createMockSocket();
        const tunnelClient = createMockTunnelClient();

        service.init(socket as any, { isShuttingDown: () => false });
        service.registerPort(3000, "Panel");
        exposeViaMessage(socket, "sess-a", 5173, "Vite");
        service.setTunnelClient(tunnelClient as any);

        expect(tunnelClient.exposePort).toHaveBeenCalledTimes(2);
        expect(tunnelClient.exposePort).toHaveBeenCalledWith(3000);
        expect(tunnelClient.exposePort).toHaveBeenCalledWith(5173);
    });

    test("registerPort emits tunnel_registered and exposes the port", () => {
        const service = new TunnelService();
        const socket = createMockSocket();
        const tunnelClient = createMockTunnelClient();

        service.setTunnelClient(tunnelClient as any);
        service.init(socket as any, { isShuttingDown: () => false });
        service.registerPort(3000, "Panel");

        expect(tunnelClient.exposePort).toHaveBeenCalledWith(3000);
        expect(socket.emitted).toEqual([
            [
                "service_message",
                {
                    serviceId: "tunnel",
                    type: "tunnel_registered",
                    payload: {
                        port: 3000,
                        name: "Panel",
                        url: "/tunnel/3000",
                        pinned: true,
                    },
                },
            ],
        ]);
    });

    test("service_message tunnel_expose and tunnel_unexpose sync the tunnel client", () => {
        const service = new TunnelService();
        const socket = createMockSocket();
        const tunnelClient = createMockTunnelClient();

        service.setTunnelClient(tunnelClient as any);
        service.init(socket as any, { isShuttingDown: () => false });

        exposeViaMessage(socket, "sess-1", 8080, "App");
        unexposeViaMessage(socket, "sess-1", 8080);

        expect(tunnelClient.exposePort).toHaveBeenCalledWith(8080);
        expect(tunnelClient.unexposePort).toHaveBeenCalledWith(8080);
        expect(socket.emitted).toEqual([
            [
                "service_message",
                {
                    serviceId: "tunnel",
                    type: "tunnel_registered",
                    sessionId: "sess-1",
                    requestId: "req-expose-sess-1-8080",
                    payload: {
                        port: 8080,
                        name: "App",
                        url: "/tunnel/8080",
                    },
                },
            ],
            [
                "service_message",
                {
                    serviceId: "tunnel",
                    type: "tunnel_removed",
                    payload: { port: 8080 },
                },
            ],
        ]);
    });

    test("init re-announces known tunnels after reconnect", () => {
        const service = new TunnelService();
        const firstSocket = createMockSocket();
        const secondSocket = createMockSocket();

        service.init(firstSocket as any, { isShuttingDown: () => false });
        service.registerPort(3000, "Panel");
        exposeViaMessage(firstSocket, "sess-a", 4000);

        service.dispose();
        service.init(secondSocket as any, { isShuttingDown: () => false });

        expect(firstSocket.emitted).toEqual([
            [
                "service_message",
                {
                    serviceId: "tunnel",
                    type: "tunnel_registered",
                    payload: {
                        port: 3000,
                        name: "Panel",
                        url: "/tunnel/3000",
                        pinned: true,
                    },
                },
            ],
            [
                "service_message",
                {
                    serviceId: "tunnel",
                    type: "tunnel_registered",
                    sessionId: "sess-a",
                    requestId: "req-expose-sess-a-4000",
                    payload: {
                        port: 4000,
                        url: "/tunnel/4000",
                    },
                },
            ],
        ]);
        expect(secondSocket.emitted).toEqual([
            [
                "service_message",
                {
                    serviceId: "tunnel",
                    type: "tunnel_registered",
                    payload: {
                        port: 3000,
                        name: "Panel",
                        url: "/tunnel/3000",
                        pinned: true,
                    },
                },
            ],
            [
                "service_message",
                {
                    serviceId: "tunnel",
                    type: "tunnel_registered",
                    sessionId: "sess-a",
                    payload: {
                        port: 4000,
                        url: "/tunnel/4000",
                    },
                },
            ],
        ]);
    });

    test("invalid ports return tunnel_error without exposing", () => {
        const service = new TunnelService();
        const socket = createMockSocket();
        const tunnelClient = createMockTunnelClient();

        service.setTunnelClient(tunnelClient as any);
        service.init(socket as any, { isShuttingDown: () => false });

        const onServiceMessage = getServiceMessageHandler(socket);
        onServiceMessage({
            serviceId: "tunnel",
            type: "tunnel_expose",
            sessionId: "sess-1",
            requestId: "req-bad",
            payload: { port: 0 },
        });

        expect(tunnelClient.exposePort).not.toHaveBeenCalled();
        expect(socket.emitted).toEqual([
            [
                "service_message",
                {
                    serviceId: "tunnel",
                    type: "tunnel_error",
                    sessionId: "sess-1",
                    requestId: "req-bad",
                    payload: { error: "Invalid port: 0" },
                },
            ],
        ]);
    });

    test("tunnel_expose without sessionId returns error", () => {
        const service = new TunnelService();
        const socket = createMockSocket();
        const tunnelClient = createMockTunnelClient();

        service.setTunnelClient(tunnelClient as any);
        service.init(socket as any, { isShuttingDown: () => false });

        const onServiceMessage = getServiceMessageHandler(socket);
        onServiceMessage({
            serviceId: "tunnel",
            type: "tunnel_expose",
            requestId: "req-nosess",
            payload: { port: 8080 },
        });

        expect(tunnelClient.exposePort).not.toHaveBeenCalled();
        expect(socket.emitted).toEqual([
            [
                "service_message",
                {
                    serviceId: "tunnel",
                    type: "tunnel_error",
                    requestId: "req-nosess",
                    payload: { error: "Missing sessionId: tunnel_expose must be session-scoped" },
                },
            ],
        ]);
    });

    test("tunnel_list only returns pinned and requesting session's tunnels", () => {
        const service = new TunnelService();
        const socket = createMockSocket();

        service.init(socket as any, { isShuttingDown: () => false });
        service.registerPort(3000, "Panel");
        exposeViaMessage(socket, "sess-a", 8080, "A");
        exposeViaMessage(socket, "sess-b", 9090, "B");

        socket.emitted.length = 0;
        getServiceMessageHandler(socket)({
            serviceId: "tunnel",
            type: "tunnel_list",
            sessionId: "sess-a",
            requestId: "req-list",
            payload: {},
        });

        expect(socket.emitted).toEqual([
            [
                "service_message",
                {
                    serviceId: "tunnel",
                    type: "tunnel_list_result",
                    sessionId: "sess-a",
                    requestId: "req-list",
                    payload: {
                        tunnels: [
                            { port: 3000, name: "Panel", url: "/tunnel/3000", pinned: true },
                            { port: 8080, name: "A", url: "/tunnel/8080" },
                        ],
                    },
                },
            ],
        ]);
    });

    test("one session cannot close another session's tunnel", () => {
        const service = new TunnelService();
        const socket = createMockSocket();
        const tunnelClient = createMockTunnelClient();

        service.setTunnelClient(tunnelClient as any);
        service.init(socket as any, { isShuttingDown: () => false });
        exposeViaMessage(socket, "sess-a", 8080);

        expect(tunnelClient.exposePort).toHaveBeenCalledTimes(1);
        socket.emitted.length = 0;

        unexposeViaMessage(socket, "sess-b", 8080);

        expect(tunnelClient.unexposePort).not.toHaveBeenCalled();
        expect(socket.emitted).toEqual([
            [
                "service_message",
                {
                    serviceId: "tunnel",
                    type: "tunnel_error",
                    sessionId: "sess-b",
                    requestId: "req-unexpose-sess-b-8080",
                    payload: { error: "Port 8080 is not exposed by this session" },
                },
            ],
        ]);
    });

    test("same port exposed by two sessions is refcounted", () => {
        const service = new TunnelService();
        const socket = createMockSocket();
        const tunnelClient = createMockTunnelClient();

        service.setTunnelClient(tunnelClient as any);
        service.init(socket as any, { isShuttingDown: () => false });

        exposeViaMessage(socket, "sess-a", 8080);
        exposeViaMessage(socket, "sess-b", 8080);

        expect(tunnelClient.exposePort).toHaveBeenCalledTimes(2);
        expect(tunnelClient.unexposePort).not.toHaveBeenCalled();

        socket.emitted.length = 0;
        unexposeViaMessage(socket, "sess-a", 8080);

        expect(tunnelClient.unexposePort).not.toHaveBeenCalled();
        // sess-a got a session-scoped tunnel_removed response.
        expect(socket.emitted.some(([event, envelope]: any) =>
            event === "service_message" &&
            envelope.type === "tunnel_removed" &&
            envelope.sessionId === "sess-a" &&
            envelope.payload.port === 8080,
        )).toBe(true);

        socket.emitted.length = 0;
        unexposeViaMessage(socket, "sess-b", 8080);

        expect(tunnelClient.unexposePort).toHaveBeenCalledTimes(1);
        expect(tunnelClient.unexposePort).toHaveBeenCalledWith(8080);
    });

    test("handleSessionEnded cleans up only that session's tunnels", () => {
        const service = new TunnelService();
        const socket = createMockSocket();
        const tunnelClient = createMockTunnelClient();

        service.setTunnelClient(tunnelClient as any);
        service.init(socket as any, { isShuttingDown: () => false });

        exposeViaMessage(socket, "sess-a", 8080);
        exposeViaMessage(socket, "sess-b", 9090);

        service.handleSessionEnded("sess-a");

        expect(tunnelClient.unexposePort).toHaveBeenCalledWith(8080);
        expect(tunnelClient.unexposePort).not.toHaveBeenCalledWith(9090);

        // sess-b's tunnel is still listable by sess-b.
        socket.emitted.length = 0;
        getServiceMessageHandler(socket)({
            serviceId: "tunnel",
            type: "tunnel_list",
            sessionId: "sess-b",
            requestId: "req-list",
            payload: {},
        });
        const listEnvelope = (socket.emitted[0] as any[])[1] as any;
        expect(listEnvelope.payload.tunnels.map((t: any) => t.port)).toEqual([9090]);
    });
});
