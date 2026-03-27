import { describe, test, expect, mock, beforeEach } from "bun:test";

// Mock the remote module exports before importing tunnel-tools
const mockGetRelaySocket = mock(() => null as any);
const mockGetRelaySessionId = mock(() => null as string | null);

mock.module("./remote.js", () => ({
    getRelaySocket: mockGetRelaySocket,
    getRelaySessionId: mockGetRelaySessionId,
    remoteExtension: () => {},
}));

mock.module("../config.js", () => ({
    loadConfig: () => ({ relayUrl: "ws://localhost:7492" }),
    expandHome: (p: string) => p,
    defaultAgentDir: () => "/tmp/test-agent",
    BUILTIN_SYSTEM_PROMPT: "",
}));

// Import after mocks are set up
import { tunnelToolsExtension } from "./tunnel-tools.js";

// ── Test helpers ──────────────────────────────────────────────────────────────

interface RegisteredTool {
    name: string;
    execute: (...args: any[]) => Promise<any>;
}

function createMockPi() {
    const tools = new Map<string, RegisteredTool>();
    return {
        tools,
        registerTool(tool: any) {
            tools.set(tool.name, tool);
        },
        on: () => {},
        registerCommand: () => {},
    };
}

function mockSocket() {
    const listeners = new Map<string, Set<Function>>();
    return {
        on: (event: string, handler: Function) => {
            if (!listeners.has(event)) listeners.set(event, new Set());
            listeners.get(event)!.add(handler);
        },
        off: (event: string, handler: Function) => {
            listeners.get(event)?.delete(handler);
        },
        emit: (_event: string, _data: unknown) => {},
        connected: true,
        _listeners: listeners,
        // Simulate receiving a message from the relay
        simulateMessage(envelope: any) {
            for (const handler of listeners.get("service_message") ?? []) {
                handler(envelope);
            }
        },
    };
}

function extractText(result: any): string {
    return result?.content?.[0]?.text ?? "";
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("tunnelToolsExtension", () => {
    let pi: ReturnType<typeof createMockPi>;
    let tools: Map<string, RegisteredTool>;

    beforeEach(() => {
        pi = createMockPi();
        tunnelToolsExtension(pi as any);
        tools = pi.tools;
        mockGetRelaySocket.mockReset();
        mockGetRelaySessionId.mockReset();
    });

    test("registers create_tunnel, list_tunnels, and close_tunnel tools", () => {
        expect(tools.has("create_tunnel")).toBe(true);
        expect(tools.has("list_tunnels")).toBe(true);
        expect(tools.has("close_tunnel")).toBe(true);
    });

    describe("create_tunnel", () => {
        test("returns error when not connected to relay", async () => {
            mockGetRelaySocket.mockReturnValue(null);
            const tool = tools.get("create_tunnel")!;
            const result = await tool.execute("call-1", { port: 3000 });
            expect(extractText(result)).toContain("Not connected to relay");
        });

        test("returns error for invalid port", async () => {
            mockGetRelaySocket.mockReturnValue({ socket: mockSocket(), token: "t" });
            const tool = tools.get("create_tunnel")!;

            const r1 = await tool.execute("call-1", { port: 0 });
            expect(extractText(r1)).toContain("port must be a number");

            const r2 = await tool.execute("call-2", { port: 70000 });
            expect(extractText(r2)).toContain("port must be a number");

            const r3 = await tool.execute("call-3", { port: -1 });
            expect(extractText(r3)).toContain("port must be a number");
        });

        test("sends tunnel_expose and returns tunnel info on success", async () => {
            const sock = mockSocket();
            let emittedEnvelope: any = null;

            sock.emit = (_event: string, data: unknown) => {
                emittedEnvelope = data;
                // Simulate the daemon responding
                setTimeout(() => {
                    sock.simulateMessage({
                        serviceId: "tunnel",
                        type: "tunnel_registered",
                        requestId: (data as any).requestId,
                        payload: { port: 3000, name: "dev", url: "/tunnel/3000" },
                    });
                }, 10);
            };

            mockGetRelaySocket.mockReturnValue({ socket: sock, token: "t" });
            mockGetRelaySessionId.mockReturnValue("sess-123");

            const tool = tools.get("create_tunnel")!;
            const result = await tool.execute("call-1", { port: 3000, name: "dev" });

            expect(emittedEnvelope).toBeTruthy();
            expect(emittedEnvelope.serviceId).toBe("tunnel");
            expect(emittedEnvelope.type).toBe("tunnel_expose");
            expect(emittedEnvelope.payload).toEqual({ port: 3000, name: "dev" });

            const text = extractText(result);
            expect(text).toContain("Tunnel created successfully");
            expect(text).toContain("3000");
            expect(result.details.port).toBe(3000);
            expect(result.details.name).toBe("dev");
            expect(result.details.publicUrl).toContain("/api/tunnel/sess-123/3000/");
        });

        test("returns error on tunnel_error response", async () => {
            const sock = mockSocket();
            sock.emit = (_event: string, data: unknown) => {
                setTimeout(() => {
                    sock.simulateMessage({
                        serviceId: "tunnel",
                        type: "tunnel_error",
                        requestId: (data as any).requestId,
                        payload: { error: "Invalid port: 0" },
                    });
                }, 10);
            };

            mockGetRelaySocket.mockReturnValue({ socket: sock, token: "t" });
            const tool = tools.get("create_tunnel")!;
            const result = await tool.execute("call-1", { port: 3000 });
            expect(extractText(result)).toContain("Invalid port: 0");
        });
    });

    describe("list_tunnels", () => {
        test("returns error when not connected to relay", async () => {
            mockGetRelaySocket.mockReturnValue(null);
            const tool = tools.get("list_tunnels")!;
            const result = await tool.execute("call-1", {});
            expect(extractText(result)).toContain("Not connected to relay");
        });

        test("returns tunnel list", async () => {
            const sock = mockSocket();
            sock.emit = (_event: string, data: unknown) => {
                setTimeout(() => {
                    sock.simulateMessage({
                        serviceId: "tunnel",
                        type: "tunnel_list_result",
                        requestId: (data as any).requestId,
                        payload: {
                            tunnels: [
                                { port: 3000, name: "dev", url: "/tunnel/3000" },
                                { port: 8080, url: "/tunnel/8080" },
                            ],
                        },
                    });
                }, 10);
            };

            mockGetRelaySocket.mockReturnValue({ socket: sock, token: "t" });
            mockGetRelaySessionId.mockReturnValue("sess-123");

            const tool = tools.get("list_tunnels")!;
            const result = await tool.execute("call-1", {});

            expect(extractText(result)).toContain("2 active tunnel(s)");
            expect(result.details.tunnels).toHaveLength(2);
            expect(result.details.tunnels[0].port).toBe(3000);
            expect(result.details.tunnels[1].port).toBe(8080);
        });

        test("returns empty list message", async () => {
            const sock = mockSocket();
            sock.emit = (_event: string, data: unknown) => {
                setTimeout(() => {
                    sock.simulateMessage({
                        serviceId: "tunnel",
                        type: "tunnel_list_result",
                        requestId: (data as any).requestId,
                        payload: { tunnels: [] },
                    });
                }, 10);
            };

            mockGetRelaySocket.mockReturnValue({ socket: sock, token: "t" });
            const tool = tools.get("list_tunnels")!;
            const result = await tool.execute("call-1", {});
            expect(extractText(result)).toContain("No active tunnels");
        });
    });

    describe("close_tunnel", () => {
        test("returns error when not connected to relay", async () => {
            mockGetRelaySocket.mockReturnValue(null);
            const tool = tools.get("close_tunnel")!;
            const result = await tool.execute("call-1", { port: 3000 });
            expect(extractText(result)).toContain("Not connected to relay");
        });

        test("returns error for invalid port", async () => {
            mockGetRelaySocket.mockReturnValue({ socket: mockSocket(), token: "t" });
            const tool = tools.get("close_tunnel")!;
            const result = await tool.execute("call-1", { port: 0 });
            expect(extractText(result)).toContain("port must be a number");
        });

        test("closes tunnel on tunnel_removed response", async () => {
            const sock = mockSocket();
            sock.emit = (_event: string, data: unknown) => {
                setTimeout(() => {
                    sock.simulateMessage({
                        serviceId: "tunnel",
                        type: "tunnel_removed",
                        payload: { port: 3000 },
                    });
                }, 10);
            };

            mockGetRelaySocket.mockReturnValue({ socket: sock, token: "t" });

            const tool = tools.get("close_tunnel")!;
            const result = await tool.execute("call-1", { port: 3000 });

            expect(extractText(result)).toContain("closed");
            expect(result.details.closed).toBe(true);
            expect(result.details.port).toBe(3000);
        });
    });
});

describe("buildPublicTunnelUrl", () => {
    const savedRelayUrl = process.env.PIZZAPI_RELAY_URL;

    beforeEach(() => {
        process.env.PIZZAPI_RELAY_URL = "ws://localhost:7492";
    });

    // Restore env after the suite
    test("generates correct URL with session ID and port", async () => {
        const sock = mockSocket();
        sock.emit = (_event: string, data: unknown) => {
            setTimeout(() => {
                sock.simulateMessage({
                    serviceId: "tunnel",
                    type: "tunnel_registered",
                    requestId: (data as any).requestId,
                    payload: { port: 8080, url: "/tunnel/8080" },
                });
            }, 10);
        };

        mockGetRelaySocket.mockReturnValue({ socket: sock, token: "t" });
        mockGetRelaySessionId.mockReturnValue("abc-def-123");

        const pi = createMockPi();
        tunnelToolsExtension(pi as any);

        const tool = pi.tools.get("create_tunnel")!;
        const result = await tool.execute("call-1", { port: 8080 });

        expect(result.details.publicUrl).toBe("http://localhost:7492/api/tunnel/abc-def-123/8080/");

        // Restore
        if (savedRelayUrl !== undefined) process.env.PIZZAPI_RELAY_URL = savedRelayUrl;
        else delete process.env.PIZZAPI_RELAY_URL;
    });

    test("returns null publicUrl when session ID is missing", async () => {
        const sock = mockSocket();
        sock.emit = (_event: string, data: unknown) => {
            setTimeout(() => {
                sock.simulateMessage({
                    serviceId: "tunnel",
                    type: "tunnel_registered",
                    requestId: (data as any).requestId,
                    payload: { port: 8080, url: "/tunnel/8080" },
                });
            }, 10);
        };

        mockGetRelaySocket.mockReturnValue({ socket: sock, token: "t" });
        mockGetRelaySessionId.mockReturnValue(null);

        const pi = createMockPi();
        tunnelToolsExtension(pi as any);

        const tool = pi.tools.get("create_tunnel")!;
        const result = await tool.execute("call-1", { port: 8080 });

        expect(result.details.publicUrl).toBeNull();

        // Restore
        if (savedRelayUrl !== undefined) process.env.PIZZAPI_RELAY_URL = savedRelayUrl;
        else delete process.env.PIZZAPI_RELAY_URL;
    });
});
