import { describe, expect, test } from "bun:test";
import type { McpServerInitResult, McpRegistrationResult } from "./mcp.js";
import { MCP_PROTOCOL_VERSION, MCP_SUPPORTED_VERSIONS, MCP_CLIENT_INFO } from "./mcp.js";

/**
 * Unit tests for MCP client initialization, timeout, and parallel init behavior.
 */

describe("MCP protocol constants", () => {
    test("MCP_PROTOCOL_VERSION is a valid spec version", () => {
        expect(MCP_PROTOCOL_VERSION).toBe("2025-03-26");
        expect(MCP_SUPPORTED_VERSIONS.has(MCP_PROTOCOL_VERSION)).toBe(true);
    });

    test("MCP_SUPPORTED_VERSIONS includes all known spec versions", () => {
        // These are the versions defined in the MCP SDK's SUPPORTED_PROTOCOL_VERSIONS
        expect(MCP_SUPPORTED_VERSIONS.has("2025-11-25")).toBe(true);
        expect(MCP_SUPPORTED_VERSIONS.has("2025-06-18")).toBe(true);
        expect(MCP_SUPPORTED_VERSIONS.has("2025-03-26")).toBe(true);
        expect(MCP_SUPPORTED_VERSIONS.has("2024-11-05")).toBe(true);
        expect(MCP_SUPPORTED_VERSIONS.has("2024-10-07")).toBe(true);
        expect(MCP_SUPPORTED_VERSIONS.size).toBe(5);
    });

    test("MCP_SUPPORTED_VERSIONS rejects unknown versions", () => {
        expect(MCP_SUPPORTED_VERSIONS.has("2020-01-01")).toBe(false);
        expect(MCP_SUPPORTED_VERSIONS.has("invalid")).toBe(false);
    });

    test("MCP_CLIENT_INFO has required fields", () => {
        expect(MCP_CLIENT_INFO.name).toBe("pizzapi");
        expect(typeof MCP_CLIENT_INFO.version).toBe("string");
        expect(MCP_CLIENT_INFO.version.length).toBeGreaterThan(0);
    });
});

describe("MCP types", () => {
    test("McpServerInitResult captures timing data", () => {
        const result: McpServerInitResult = {
            name: "test-server",
            tools: [],
            durationMs: 1500,
            timedOut: false,
        };
        expect(result.name).toBe("test-server");
        expect(result.durationMs).toBe(1500);
        expect(result.timedOut).toBe(false);
        expect(result.error).toBeUndefined();
    });

    test("McpServerInitResult captures timeout errors", () => {
        const result: McpServerInitResult = {
            name: "slow-server",
            tools: [],
            error: "Timed out after 30s waiting for tools/list",
            durationMs: 30000,
            timedOut: true,
        };
        expect(result.timedOut).toBe(true);
        expect(result.error).toContain("Timed out");
    });

    test("McpRegistrationResult includes overall timing", () => {
        const result: McpRegistrationResult = {
            clients: [],
            toolCount: 5,
            toolNames: ["tool1", "tool2", "tool3", "tool4", "tool5"],
            errors: [],
            serverTools: { server1: ["tool1", "tool2"], server2: ["tool3", "tool4", "tool5"] },
            serverTimings: [
                { name: "server1", tools: [], durationMs: 200, timedOut: false },
                { name: "server2", tools: [], durationMs: 500, timedOut: false },
            ],
            totalDurationMs: 500, // parallel — wall clock is max, not sum
        };
        expect(result.totalDurationMs).toBe(500);
        expect(result.serverTimings).toHaveLength(2);
    });
});

describe("MCP initialize handshake (HTTP)", () => {
    test("HTTP client sends initialize before tools/list", async () => {
        const receivedRequests: Array<{ method: string; params?: any }> = [];

        // Spin up a minimal JSON-RPC server to capture requests
        const server = Bun.serve({
            port: 0,
            async fetch(req) {
                const body = await req.json() as any;

                // Notifications have no id
                if (!("id" in body)) {
                    receivedRequests.push({ method: body.method, params: body.params });
                    return new Response(null, { status: 202 });
                }

                receivedRequests.push({ method: body.method, params: body.params });

                if (body.method === "initialize") {
                    return Response.json({
                        jsonrpc: "2.0",
                        id: body.id,
                        result: {
                            protocolVersion: MCP_PROTOCOL_VERSION,
                            capabilities: { tools: {} },
                            serverInfo: { name: "test", version: "1.0" },
                        },
                    });
                }

                if (body.method === "tools/list") {
                    return Response.json({
                        jsonrpc: "2.0",
                        id: body.id,
                        result: {
                            tools: [{ name: "test_tool", description: "A test tool" }],
                        },
                    });
                }

                return Response.json({
                    jsonrpc: "2.0",
                    id: body.id,
                    result: {},
                });
            },
        });

        try {
            // Use createMcpClientsFromConfig to create an HTTP client
            const { createMcpClientsFromConfig } = await import("./mcp.js");
            const clients = await createMcpClientsFromConfig({
                mcpServers: {
                    "test-http": {
                        url: `http://localhost:${server.port}`,
                    },
                },
            } as any);

            expect(clients).toHaveLength(1);

            const tools = await clients[0].listTools();

            // Verify the handshake happened in order:
            // 1. initialize
            // 2. notifications/initialized
            // 3. tools/list
            expect(receivedRequests.length).toBeGreaterThanOrEqual(3);
            expect(receivedRequests[0].method).toBe("initialize");
            expect(receivedRequests[0].params.protocolVersion).toBe(MCP_PROTOCOL_VERSION);
            expect(receivedRequests[0].params.clientInfo.name).toBe("pizzapi");
            expect(receivedRequests[1].method).toBe("notifications/initialized");
            expect(receivedRequests[2].method).toBe("tools/list");

            // Verify tools were returned
            expect(tools).toHaveLength(1);
            expect(tools[0].name).toBe("test_tool");

            clients[0].close();
        } finally {
            server.stop(true);
        }
    });

    test("HTTP client only initializes once across multiple calls", async () => {
        let initializeCount = 0;

        const server = Bun.serve({
            port: 0,
            async fetch(req) {
                const body = await req.json() as any;

                if (!("id" in body)) {
                    return new Response(null, { status: 202 });
                }

                if (body.method === "initialize") {
                    initializeCount++;
                    return Response.json({
                        jsonrpc: "2.0",
                        id: body.id,
                        result: {
                            protocolVersion: MCP_PROTOCOL_VERSION,
                            capabilities: {},
                            serverInfo: { name: "test", version: "1.0" },
                        },
                    });
                }

                if (body.method === "tools/list") {
                    return Response.json({
                        jsonrpc: "2.0",
                        id: body.id,
                        result: { tools: [] },
                    });
                }

                if (body.method === "tools/call") {
                    return Response.json({
                        jsonrpc: "2.0",
                        id: body.id,
                        result: { content: [{ type: "text", text: "ok" }] },
                    });
                }

                return Response.json({ jsonrpc: "2.0", id: body.id, result: {} });
            },
        });

        try {
            const { createMcpClientsFromConfig } = await import("./mcp.js");
            const clients = await createMcpClientsFromConfig({
                mcpServers: {
                    "test-http": { url: `http://localhost:${server.port}` },
                },
            } as any);

            // Call listTools twice and callTool once
            await clients[0].listTools();
            await clients[0].listTools();
            await clients[0].callTool("test_tool", {});

            // Initialize should have been called exactly once
            expect(initializeCount).toBe(1);

            clients[0].close();
        } finally {
            server.stop(true);
        }
    });

    test("HTTP client rejects unsupported protocol versions", async () => {
        const server = Bun.serve({
            port: 0,
            async fetch(req) {
                const body = await req.json() as any;
                if (!("id" in body)) return new Response(null, { status: 202 });

                if (body.method === "initialize") {
                    return Response.json({
                        jsonrpc: "2.0",
                        id: body.id,
                        result: {
                            protocolVersion: "1999-01-01", // unsupported
                            capabilities: {},
                            serverInfo: { name: "old", version: "0.1" },
                        },
                    });
                }

                return Response.json({ jsonrpc: "2.0", id: body.id, result: {} });
            },
        });

        try {
            const { createMcpClientsFromConfig } = await import("./mcp.js");
            const clients = await createMcpClientsFromConfig({
                mcpServers: {
                    "old-server": { url: `http://localhost:${server.port}` },
                },
            } as any);

            await expect(clients[0].listTools()).rejects.toThrow("unsupported protocol version");

            clients[0].close();
        } finally {
            server.stop(true);
        }
    });
});

describe("MCP config compatibility", () => {
    test("type: 'http' in mcpServers uses streamable transport", async () => {
        // When type: "http" is used (Claude Code / VS Code format), it should
        // create a streamable client, not a plain HTTP client. We verify this by
        // checking that it sends the Accept header that includes text/event-stream.
        let receivedAcceptHeader = "";

        const server = Bun.serve({
            port: 0,
            async fetch(req) {
                receivedAcceptHeader = req.headers.get("accept") ?? "";

                const body = await req.json() as any;
                if (!("id" in body)) return new Response(null, { status: 202 });

                if (body.method === "initialize") {
                    return Response.json({
                        jsonrpc: "2.0",
                        id: body.id,
                        result: {
                            protocolVersion: MCP_PROTOCOL_VERSION,
                            capabilities: {},
                            serverInfo: { name: "test", version: "1.0" },
                        },
                    });
                }

                if (body.method === "tools/list") {
                    return Response.json({
                        jsonrpc: "2.0",
                        id: body.id,
                        result: { tools: [] },
                    });
                }

                return Response.json({ jsonrpc: "2.0", id: body.id, result: {} });
            },
        });

        try {
            const { createMcpClientsFromConfig } = await import("./mcp.js");
            const clients = await createMcpClientsFromConfig({
                mcpServers: {
                    "github-style": {
                        type: "http",
                        url: `http://localhost:${server.port}`,
                    },
                },
            } as any);

            expect(clients).toHaveLength(1);
            await clients[0].listTools();

            // Streamable client sends Accept: application/json, text/event-stream
            // Plain HTTP client only sends Content-Type: application/json
            expect(receivedAcceptHeader).toContain("text/event-stream");

            clients[0].close();
        } finally {
            server.stop(true);
        }
    });
});

describe("MCP initialize handshake (Streamable HTTP)", () => {
    test("Streamable client sends initialize and captures session ID", async () => {
        const receivedRequests: Array<{ method: string; hasId: boolean }> = [];
        const SESSION_ID = "test-session-abc123";

        const server = Bun.serve({
            port: 0,
            async fetch(req) {
                const body = await req.json() as any;
                const hasId = "id" in body;
                receivedRequests.push({ method: body.method, hasId });

                if (!hasId) {
                    return new Response(null, { status: 202 });
                }

                if (body.method === "initialize") {
                    return Response.json(
                        {
                            jsonrpc: "2.0",
                            id: body.id,
                            result: {
                                protocolVersion: MCP_PROTOCOL_VERSION,
                                capabilities: { tools: {} },
                                serverInfo: { name: "streamable-test", version: "1.0" },
                            },
                        },
                        {
                            headers: {
                                "Content-Type": "application/json",
                                "mcp-session-id": SESSION_ID,
                            },
                        },
                    );
                }

                if (body.method === "tools/list") {
                    // Verify session ID is sent back
                    const sentSessionId = req.headers.get("mcp-session-id");
                    if (sentSessionId !== SESSION_ID) {
                        return Response.json(
                            { jsonrpc: "2.0", id: body.id, error: { code: -32600, message: "Missing session ID" } },
                            { status: 400 },
                        );
                    }

                    return Response.json({
                        jsonrpc: "2.0",
                        id: body.id,
                        result: {
                            tools: [{ name: "stream_tool", description: "Streams data" }],
                        },
                    });
                }

                return Response.json({ jsonrpc: "2.0", id: body.id, result: {} });
            },
        });

        try {
            const { createMcpClientsFromConfig } = await import("./mcp.js");
            const clients = await createMcpClientsFromConfig({
                mcp: {
                    servers: [
                        {
                            name: "stream-test",
                            transport: "streamable" as const,
                            url: `http://localhost:${server.port}`,
                        },
                    ],
                },
            } as any);

            expect(clients).toHaveLength(1);

            const tools = await clients[0].listTools();

            // Verify handshake order
            expect(receivedRequests[0].method).toBe("initialize");
            expect(receivedRequests[0].hasId).toBe(true);
            expect(receivedRequests[1].method).toBe("notifications/initialized");
            expect(receivedRequests[1].hasId).toBe(false);
            expect(receivedRequests[2].method).toBe("tools/list");

            // Verify tools came back (which also proves session ID was forwarded)
            expect(tools).toHaveLength(1);
            expect(tools[0].name).toBe("stream_tool");

            clients[0].close();
        } finally {
            server.stop(true);
        }
    });
});
