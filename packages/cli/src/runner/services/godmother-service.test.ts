import { describe, test, expect, mock } from "bun:test";
import { GodmotherService, parseGodmotherToolResult, resolveGodmotherMcpConfig } from "./godmother-service.js";

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

function getServiceMessageHandler(socket: ReturnType<typeof createMockSocket>): Function {
    const handlers = socket.listeners.get("service_message") ?? [];
    expect(handlers).toHaveLength(1);
    return handlers[0]!;
}

async function flushAsyncWork(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("resolveGodmotherMcpConfig", () => {
    test("prefers mcp.servers stdio config", () => {
        const cfg = resolveGodmotherMcpConfig({
            mcp: {
                servers: [
                    { name: "other", transport: "stdio", command: "other" },
                    {
                        name: "godmother",
                        transport: "stdio",
                        command: "/usr/local/bin/gm",
                        args: ["serve"],
                        cwd: "/tmp/gm",
                    },
                ],
            },
            mcpServers: {
                godmother: { command: "ignored" },
            },
        });

        expect(cfg).toEqual({
            command: "/usr/local/bin/gm",
            args: ["serve"],
            cwd: "/tmp/gm",
        });
    });

    test("falls back to mcpServers compatibility format", () => {
        const cfg = resolveGodmotherMcpConfig({
            mcpServers: {
                godmother: {
                    command: "gm",
                    args: ["serve"],
                    env: { FOO: "bar", BAD: 123 },
                },
            },
        });

        expect(cfg).toEqual({
            command: "gm",
            args: ["serve"],
            env: { FOO: "bar" },
        });
    });

    test("returns null when godmother is not configured", () => {
        const cfg = resolveGodmotherMcpConfig({
            mcpServers: {
                another: { command: "x" },
            },
        });

        expect(cfg).toBeNull();
    });
});

describe("parseGodmotherToolResult", () => {
    test("parses JSON text content", () => {
        const parsed = parseGodmotherToolResult({
            content: [{ type: "text", text: '{"ok":true,"items":[1,2]}' }],
        });

        expect(parsed).toEqual({ ok: true, items: [1, 2] });
    });

    test("returns raw text when content is not JSON", () => {
        const parsed = parseGodmotherToolResult({
            content: [{ type: "text", text: "plain output" }],
        });

        expect(parsed).toBe("plain output");
    });
});

describe("GodmotherService", () => {
    test("ideas_query returns normalized idea list scoped to session", async () => {
        const socket = createMockSocket();
        const callTool = mock(async (toolName: string) => {
            if (toolName !== "search_ideas") throw new Error(`Unexpected tool: ${toolName}`);
            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify([
                            {
                                id: "abc123",
                                project: "PizzaPi",
                                status: "execute",
                                topics: ["ui", "runner"],
                                snippet: "Improve panel UX",
                                updated: "2026-03-27T01:02:03Z",
                            },
                        ]),
                    },
                ],
            };
        });

        const client = {
            initialize: mock(async () => {}),
            callTool,
            close: mock(() => {}),
        };

        const service = new GodmotherService({
            resolveConfig: () => ({ command: "gm", args: ["serve"] }),
            createClient: async () => client as any,
        });

        service.init(socket as any, { isShuttingDown: () => false });

        const onServiceMessage = getServiceMessageHandler(socket);
        onServiceMessage({
            serviceId: "godmother",
            type: "ideas_query",
            requestId: "req-1",
            sessionId: "sess-1",
            payload: { query: "panel", status: "execute" },
        });

        await flushAsyncWork();
        await flushAsyncWork();

        expect(callTool).toHaveBeenCalledWith("search_ideas", {
            query: "panel",
            project: "PizzaPi",
            status: "execute",
            limit: 60,
        });

        expect(socket.emitted).toEqual([
            [
                "service_message",
                {
                    serviceId: "godmother",
                    type: "godmother_query_result",
                    requestId: "req-1",
                    sessionId: "sess-1",
                    payload: {
                        ideas: [
                            {
                                id: "abc123",
                                project: "PizzaPi",
                                status: "execute",
                                topics: ["ui", "runner"],
                                snippet: "Improve panel UX",
                                updated: "2026-03-27T01:02:03Z",
                            },
                        ],
                        query: "panel",
                        status: "execute",
                        topic: "",
                        project: "PizzaPi",
                    },
                },
            ],
        ]);
    });

    test("idea_add_topics merges + deduplicates topics", async () => {
        const socket = createMockSocket();

        let getIdeaCalls = 0;
        const callTool = mock(async (toolName: string, args: Record<string, unknown>) => {
            if (toolName === "get_idea") {
                getIdeaCalls += 1;
                const topics = getIdeaCalls === 1
                    ? ["runner", "ui"]
                    : ["ops", "runner", "ui"];
                return {
                    content: [
                        {
                            type: "text",
                            text: JSON.stringify({
                                id: "idea-1",
                                project: "PizzaPi",
                                status: "execute",
                                topics,
                                content: "Original",
                            }),
                        },
                    ],
                };
            }
            if (toolName === "update_idea") {
                expect(args).toEqual({
                    id: "idea-1",
                    topics: ["ops", "runner", "ui"],
                });
                return { content: [{ type: "text", text: "{\"ok\":true}" }] };
            }
            throw new Error(`Unexpected tool: ${toolName}`);
        });

        const client = {
            initialize: mock(async () => {}),
            callTool,
            close: mock(() => {}),
        };

        const service = new GodmotherService({
            resolveConfig: () => ({ command: "gm", args: ["serve"] }),
            createClient: async () => client as any,
        });

        service.init(socket as any, { isShuttingDown: () => false });
        const onServiceMessage = getServiceMessageHandler(socket);

        onServiceMessage({
            serviceId: "godmother",
            type: "idea_add_topics",
            requestId: "req-topics",
            payload: {
                id: "idea-1",
                topics: ["ops", "runner"],
            },
        });

        await flushAsyncWork();
        await flushAsyncWork();
        await flushAsyncWork();

        expect(callTool).toHaveBeenCalledTimes(3);
        expect(socket.emitted[0]?.[0]).toBe("service_message");
        const envelope = socket.emitted[0]?.[1] as Record<string, unknown>;
        expect(envelope.type).toBe("godmother_idea_updated");
        expect((envelope.payload as any).idea.topics).toEqual(["ops", "runner", "ui"]);
    });
});
