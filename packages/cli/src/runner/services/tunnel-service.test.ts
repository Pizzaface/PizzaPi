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

describe("TunnelService", () => {
    test("setTunnelClient re-exposes already known ports", () => {
        const service = new TunnelService();
        const tunnelClient = createMockTunnelClient();

        service.registerPort(3000, "Panel");
        service.registerPort(5173, "Vite");
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

        const onServiceMessage = getServiceMessageHandler(socket);
        onServiceMessage({
            serviceId: "tunnel",
            type: "tunnel_expose",
            requestId: "req-1",
            payload: { port: 8080, name: "App" },
        });
        onServiceMessage({
            serviceId: "tunnel",
            type: "tunnel_unexpose",
            payload: { port: 8080 },
        });

        expect(tunnelClient.exposePort).toHaveBeenCalledWith(8080);
        expect(tunnelClient.unexposePort).toHaveBeenCalledWith(8080);
        expect(socket.emitted).toEqual([
            [
                "service_message",
                {
                    serviceId: "tunnel",
                    type: "tunnel_registered",
                    requestId: "req-1",
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

        service.registerPort(3000, "Panel");

        service.init(firstSocket as any, { isShuttingDown: () => false });
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
        ]);
        expect(secondSocket.emitted).toEqual(firstSocket.emitted);
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
                    requestId: "req-bad",
                    payload: { error: "Invalid port: 0" },
                },
            ],
        ]);
    });
});
