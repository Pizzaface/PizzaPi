import { describe, expect, test } from "bun:test";
import type { McpServerInitResult, McpRegistrationResult } from "./mcp.js";
import { MCP_PROTOCOL_VERSION, MCP_SUPPORTED_VERSIONS, MCP_CLIENT_INFO, isGitHubHost, createMcpClientsFromConfig, registerMcpTools } from "./mcp.js";

// ── Pure unit tests ───────────────────────────────────────────────────────────

describe("MCP protocol constants", () => {
    test("MCP_PROTOCOL_VERSION is a valid spec version", () => {
        expect(MCP_PROTOCOL_VERSION).toBe("2025-03-26");
        expect(MCP_SUPPORTED_VERSIONS.has(MCP_PROTOCOL_VERSION)).toBe(true);
    });

    test("MCP_SUPPORTED_VERSIONS includes all known spec versions", () => {
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
            totalDurationMs: 500,
        };
        expect(result.totalDurationMs).toBe(500);
        expect(result.serverTimings).toHaveLength(2);
    });
});

describe("isGitHubHost", () => {
    test("accepts known GitHub hosts", () => {
        expect(isGitHubHost("https://github.com/owner/repo")).toBe(true);
        expect(isGitHubHost("https://api.github.com/repos")).toBe(true);
        expect(isGitHubHost("https://api.githubcopilot.com/mcp")).toBe(true);
    });

    test("accepts subdomains of github.com", () => {
        expect(isGitHubHost("https://models.github.com/mcp")).toBe(true);
        expect(isGitHubHost("https://copilot.github.com/v1")).toBe(true);
    });

    test("rejects attacker-controlled URLs containing 'github'", () => {
        expect(isGitHubHost("https://github.evil.com/mcp")).toBe(false);
        expect(isGitHubHost("https://notgithub.com/mcp")).toBe(false);
        expect(isGitHubHost("https://evil.com/github")).toBe(false);
        expect(isGitHubHost("https://github.attacker.example/mcp")).toBe(false);
    });

    test("rejects non-GitHub URLs", () => {
        expect(isGitHubHost("https://example.com/mcp")).toBe(false);
        expect(isGitHubHost("https://gitlab.com/mcp")).toBe(false);
    });

    test("handles invalid URLs gracefully", () => {
        expect(isGitHubHost("not-a-url")).toBe(false);
        expect(isGitHubHost("")).toBe(false);
    });

    test("is case-insensitive", () => {
        expect(isGitHubHost("https://GitHub.COM/owner/repo")).toBe(true);
        expect(isGitHubHost("https://API.GITHUB.COM/repos")).toBe(true);
    });
});

// ── HTTP smoke tests (integration) ────────────────────────────────────────────

describe("MCP HTTP smoke test", () => {
    test("HTTP client sends initialize handshake before tools/list", async () => {
        const receivedRequests: Array<{ method: string; params?: any }> = [];

        const server = Bun.serve({
            port: 0,
            async fetch(req) {
                const body = await req.json() as any;
                if (!("id" in body)) {
                    receivedRequests.push({ method: body.method });
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
                        result: { tools: [{ name: "test_tool", description: "A test tool" }] },
                    });
                }
                return Response.json({ jsonrpc: "2.0", id: body.id, result: {} });
            },
        });

        try {
            const clients = await createMcpClientsFromConfig({
                mcpServers: { "test-http": { url: `http://localhost:${server.port}` } },
            } as any);

            expect(clients).toHaveLength(1);
            const tools = await clients[0].listTools();

            // Verify handshake order: initialize → notifications/initialized → tools/list
            expect(receivedRequests.length).toBeGreaterThanOrEqual(3);
            expect(receivedRequests[0].method).toBe("initialize");
            expect(receivedRequests[0].params.protocolVersion).toBe(MCP_PROTOCOL_VERSION);
            expect(receivedRequests[0].params.clientInfo.name).toBe("pizzapi");
            expect(receivedRequests[1].method).toBe("notifications/initialized");
            expect(receivedRequests[2].method).toBe("tools/list");
            expect(tools).toHaveLength(1);
            expect(tools[0].name).toBe("test_tool");

            clients[0].close();
        } finally {
            server.stop(true);
        }
    });

    test("registerMcpTools reports timeout for hung server", async () => {
        const server = Bun.serve({
            port: 0,
            async fetch(req) {
                const body = await req.json() as any;
                if (!("id" in body)) return new Response(null, { status: 202 });
                if (body.method === "initialize") {
                    await new Promise((resolve) => {
                        req.signal.addEventListener("abort", () => resolve(undefined));
                        setTimeout(resolve, 30_000);
                    });
                    return Response.json({
                        jsonrpc: "2.0",
                        id: body.id,
                        result: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, serverInfo: { name: "hung", version: "1.0" } },
                    });
                }
                return Response.json({ jsonrpc: "2.0", id: body.id, result: {} });
            },
        });

        try {
            const mockPi = {
                registeredTools: [] as any[],
                registerTool(t: any) { this.registeredTools.push(t); },
                on() {},
            };

            const result = await registerMcpTools(mockPi, {
                mcpServers: { "hung-server": { url: `http://localhost:${server.port}` } },
                mcpInitTimeout: 200,
            } as any);

            expect(result.errors).toHaveLength(1);
            expect(result.errors[0].server).toBe("hung-server");
            expect(result.errors[0].error).toContain("Timed out");
            expect(result.clients).toHaveLength(0);
            expect(result.toolCount).toBe(0);
        } finally {
            server.stop(true);
        }
    });
});
