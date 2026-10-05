/**
 * Lifecycle tests for the plan-mode extension: tool_call enforcement across
 * session start / resume / switch / new-session boundaries (F21) and the
 * default-deny tool policy for MCP and unknown tools (F20).
 *
 * Drives the real extension factory with a minimal pi stub and, for MCP, the
 * real MCP registry against a local HTTP MCP server, so the classification
 * recorded at registration time is what the plan-mode hook sees.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { planModeToggleExtension, isPlanModeEnabled, setPlanModeFromRemote } from "./extension.js";
import { getPlanModeToolBlockReason } from "./tool-policy.js";
import { registerMcpTools } from "../mcp/registry.js";
import type { McpClient } from "../mcp/types.js";

type Handler = (event: any, ctx?: any) => unknown;

function createHarness() {
    const handlers = new Map<string, Handler[]>();
    const tools = new Map<string, any>();
    const appended: any[] = [];
    const pi = {
        on(event: string, handler: Handler) {
            const list = handlers.get(event) ?? [];
            list.push(handler);
            handlers.set(event, list);
        },
        registerCommand() {},
        registerTool(def: any) { tools.set(def.name, def); },
        appendEntry(customType: string, data: unknown) { appended.push({ type: "custom", customType, data }); },
        sendMessage() {},
        sendUserMessage() {},
    };
    planModeToggleExtension(pi as any);

    /** Dispatch like pi's runner: every handler, in registration order. */
    async function emit(event: string, payload: any, ctx?: any) {
        let result: unknown;
        for (const h of handlers.get(event) ?? []) {
            const r = await h(payload, ctx);
            if (r !== undefined) result = r;
        }
        return result as { block?: boolean; reason?: string } | undefined;
    }

    const sessionCtx = (entries: unknown[]) => ({ sessionManager: { getEntries: () => entries } });
    const toolCall = (toolName: string, input: Record<string, unknown> = {}) =>
        emit("tool_call", { type: "tool_call", toolName, toolCallId: "t1", input });

    return { emit, tools, appended, sessionCtx, toolCall };
}

const planEntry = (enabled: boolean) => ({ type: "custom", customType: "plan-mode-toggle", data: { enabled, todos: [], executing: false } });

afterEach(() => {
    // Leave module-level state clean for other suites.
    setPlanModeFromRemote(false);
    delete process.env.PIZZAPI_PLAN_MODE_ALLOWED_TOOLS;
});

describe("F21 — persisted plan mode survives session start / resume", () => {
    for (const reason of ["startup", "resume", "reload", "fork"]) {
        test(`session_start(${reason}) with an enabled transcript keeps plan mode ON and blocks the first mutating call`, async () => {
            const h = createHarness();
            await h.emit("session_start", { type: "session_start", reason }, h.sessionCtx([planEntry(true)]));

            expect(isPlanModeEnabled()).toBe(true);
            expect((await h.toolCall("edit", { path: "a", edits: [] }))?.block).toBe(true);
            expect((await h.toolCall("write", { path: "a", content: "" }))?.block).toBe(true);
            expect((await h.toolCall("bash", { command: "rm -rf src" }))?.block).toBe(true);
            expect((await h.toolCall("mcp__srv__delete_everything", {}))?.block).toBe(true);
            // Read-only tools still work.
            expect(await h.toolCall("read", { path: "a" })).toBeUndefined();
            expect(await h.toolCall("bash", { command: "git status" })).toBeUndefined();
        });
    }

    test("session_start does not persist a spurious 'disabled' entry over the restored state", async () => {
        const h = createHarness();
        await h.emit("session_start", { type: "session_start", reason: "startup" }, h.sessionCtx([planEntry(true)]));
        expect(h.appended.some((e) => e.data?.enabled === false)).toBe(false);
    });

    test("the latest persisted entry wins (enabled → disabled)", async () => {
        const h = createHarness();
        await h.emit("session_start", { type: "session_start", reason: "resume" }, h.sessionCtx([planEntry(true), planEntry(false)]));
        expect(isPlanModeEnabled()).toBe(false);
        expect(await h.toolCall("edit", { path: "a" })).toBeUndefined();
    });

    test("a genuinely new session starts with plan mode OFF even if the previous one had it ON", async () => {
        const h = createHarness();
        await h.emit("session_start", { type: "session_start", reason: "startup" }, h.sessionCtx([planEntry(true)]));
        expect(isPlanModeEnabled()).toBe(true);

        await h.emit("session_start", { type: "session_start", reason: "new" }, h.sessionCtx([]));
        expect(isPlanModeEnabled()).toBe(false);
        expect(await h.toolCall("edit", { path: "a" })).toBeUndefined();
    });

    test("worker session_switch(resume) into a plan-mode transcript re-enables enforcement before the next call", async () => {
        const h = createHarness();
        await h.emit("session_start", { type: "session_start", reason: "startup" }, h.sessionCtx([]));
        expect(isPlanModeEnabled()).toBe(false);

        await h.emit("session_switch", { type: "session_switch", reason: "resume" }, h.sessionCtx([planEntry(true)]));
        expect(isPlanModeEnabled()).toBe(true);
        expect((await h.toolCall("edit", { path: "a" }))?.block).toBe(true);

        // …and switching to a new, empty session clears it again.
        await h.emit("session_switch", { type: "session_switch", reason: "new" }, h.sessionCtx([]));
        expect(isPlanModeEnabled()).toBe(false);
        expect(await h.toolCall("edit", { path: "a" })).toBeUndefined();
    });
});

describe("F20 — plan mode is default-deny for tools", () => {
    test("toggle_plan_mode takes effect for the very next tool call in the same response", async () => {
        const h = createHarness();
        await h.emit("session_start", { type: "session_start", reason: "startup" }, h.sessionCtx([]));
        expect(await h.toolCall("edit", { path: "a" })).toBeUndefined();

        await h.tools.get("toggle_plan_mode").execute("t0", { enabled: true });
        expect((await h.toolCall("edit", { path: "a" }))?.block).toBe(true);
        // The agent can always exit.
        expect(await h.toolCall("toggle_plan_mode", { enabled: false })).toBeUndefined();
    });

    test("unknown extension tools are blocked; PIZZAPI_PLAN_MODE_ALLOWED_TOOLS opts specific ones back in", async () => {
        const h = createHarness();
        await h.emit("session_start", { type: "session_start", reason: "startup" }, h.sessionCtx([planEntry(true)]));

        for (const name of ["create_tunnel", "kill_shell", "memory_save", "run_workflow", "send_message", "powershell", "some_overlay_tool"]) {
            expect((await h.toolCall(name, {}))?.block).toBe(true);
        }
        for (const name of ["read", "grep", "find", "ls", "plan_mode", "AskUserQuestion", "memory_read", "list_tunnels"]) {
            expect(await h.toolCall(name, {})).toBeUndefined();
        }

        process.env.PIZZAPI_PLAN_MODE_ALLOWED_TOOLS = "some_overlay_tool, edit";
        expect(await h.toolCall("some_overlay_tool", {})).toBeUndefined();
        // Hard-blocked write tools cannot be re-enabled.
        expect((await h.toolCall("edit", { path: "a" }))?.block).toBe(true);
    });

    test("bash with a non-string command is blocked", async () => {
        const h = createHarness();
        await h.emit("session_start", { type: "session_start", reason: "startup" }, h.sessionCtx([planEntry(true)]));
        expect((await h.toolCall("bash", { command: ["rm", "-rf", "/"] }))?.block).toBe(true);
    });
});

describe("F20 — MCP tools registered through the registry", () => {
    let server: ReturnType<typeof Bun.serve>;
    let clients: McpClient[] = [];
    let toolNames: string[] = [];

    beforeAll(async () => {
        server = Bun.serve({
            port: 0,
            async fetch(req) {
                const body = await req.json() as any;
                const reply = (result: unknown) => Response.json({ jsonrpc: "2.0", id: body.id, result });
                if (body.method === "server/discover") {
                    return reply({ supportedVersions: ["2026-07-28"], capabilities: { tools: {} }, serverInfo: { name: "store", version: "1" } });
                }
                if (body.method === "tools/list") {
                    return reply({ tools: [
                        { name: "delete_record", inputSchema: { type: "object" } },
                        { name: "update_record", inputSchema: { type: "object" }, annotations: { readOnlyHint: false, destructiveHint: false } },
                        { name: "get_record", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
                    ] });
                }
                return new Response(null, { status: 202 });
            },
        });
        const registration = await registerMcpTools({ registerTool() {} }, {
            mcpServers: { store: { url: `http://127.0.0.1:${server.port}` } },
        } as any);
        clients = registration.clients;
        toolNames = registration.toolNames;
        expect(registration.errors).toEqual([]);
    });

    afterAll(() => {
        for (const c of clients) c.close();
        server?.stop(true);
    });

    const nameFor = (suffix: string) => {
        const name = toolNames.find((n) => n.endsWith(suffix));
        if (!name) throw new Error(`tool ${suffix} not registered: ${toolNames.join(", ")}`);
        return name;
    };

    test("un-annotated and readOnlyHint:false MCP tools are blocked in plan mode; readOnlyHint:true is allowed", async () => {
        const h = createHarness();
        await h.emit("session_start", { type: "session_start", reason: "resume" }, h.sessionCtx([planEntry(true)]));

        expect((await h.toolCall(nameFor("delete_record")))?.block).toBe(true);
        expect((await h.toolCall(nameFor("update_record")))?.block).toBe(true);
        expect(await h.toolCall(nameFor("get_record"))).toBeUndefined();
        expect(getPlanModeToolBlockReason(nameFor("delete_record"))).toContain("readOnlyHint");
    });

    test("MCP tools are unrestricted once plan mode is off", async () => {
        const h = createHarness();
        await h.emit("session_start", { type: "session_start", reason: "startup" }, h.sessionCtx([]));
        expect(await h.toolCall(nameFor("delete_record"))).toBeUndefined();
    });

    test("a trusted MCP tool can be allowed explicitly", async () => {
        const h = createHarness();
        await h.emit("session_start", { type: "session_start", reason: "resume" }, h.sessionCtx([planEntry(true)]));
        process.env.PIZZAPI_PLAN_MODE_ALLOWED_TOOLS = nameFor("update_record");
        expect(await h.toolCall(nameFor("update_record"))).toBeUndefined();
        expect((await h.toolCall(nameFor("delete_record")))?.block).toBe(true);
    });
});
