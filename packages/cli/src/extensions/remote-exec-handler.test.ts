import { afterEach, describe, expect, mock, test } from "bun:test";

const toggleCalls: Array<{ name: string; disabled: boolean; cwd: string }> = [];
const loadConfigCalls: string[] = [];
const resolveSandboxCalls: Array<{ cwd: string; config: unknown }> = [];
const saveGlobalCalls: unknown[] = [];

const getMcpBridgeMock = mock(() => ({
    status: () => ({ ok: true }),
    reload: async () => ({ toolCount: 0, serverCount: 0, totalDurationMs: 0, slow: false, showSlowWarning: false, errors: [], serverTimings: [], ts: Date.now() }),
}));

mock.module("./mcp-bridge.js", () => ({
    getMcpBridge: getMcpBridgeMock,
}));

mock.module("../config.js", () => ({
    toggleMcpServer: (name: string, disabled: boolean, cwd: string) => {
        toggleCalls.push({ name, disabled, cwd });
        return { changed: true, globallyDisabled: false };
    },
    saveGlobalConfig: (fields: unknown) => {
        saveGlobalCalls.push(fields);
    },
    loadConfig: (cwd: string) => {
        loadConfigCalls.push(cwd);
        return { sandbox: { mode: "basic" } };
    },
    loadGlobalConfig: () => ({ sandbox: { mode: "basic" } }),
    resolveSandboxConfig: (cwd: string, config: unknown) => {
        resolveSandboxCalls.push({ cwd, config });
        return { mode: "basic", cwd, config };
    },
}));

mock.module("./plan-mode/index.js", () => ({
    isPlanModeEnabled: () => false,
    togglePlanModeFromRemote: () => false,
    setPlanModeFromRemote: () => false,
}));

mock.module("./remote-provider-usage.js", () => ({
    refreshAllUsage: async () => undefined,
    buildProviderUsage: () => ({}),
}));

mock.module("./remote-meta-events.js", () => ({
    emitThinkingLevelChanged: () => undefined,
    emitCompactStarted: () => undefined,
    emitCompactEnded: () => undefined,
    emitRetryStateChanged: () => undefined,
    emitPluginTrustResolved: () => undefined,
}));

const { handleExecFromWeb } = await import("./remote-exec-handler.js");

afterEach(() => {
    toggleCalls.length = 0;
    loadConfigCalls.length = 0;
    resolveSandboxCalls.length = 0;
    saveGlobalCalls.length = 0;
    mock.restore();
});

describe("handleExecFromWeb", () => {
    test("uses the active session cwd for MCP config toggles", async () => {
        const replies: unknown[] = [];
        const rctx = {
            latestCtx: { cwd: "/workspace/project-a" },
            sendToWeb: (payload: unknown) => replies.push(payload),
        } as any;

        await handleExecFromWeb(
            { type: "exec", id: "1", command: "mcp_toggle_server", serverName: "playwright", disabled: true },
            rctx,
            {} as any,
        );

        expect(toggleCalls).toEqual([
            { name: "playwright", disabled: true, cwd: "/workspace/project-a" },
        ]);
        expect(replies).toEqual([
            {
                type: "exec_result",
                id: "1",
                ok: true,
                command: "mcp_toggle_server",
                result: expect.objectContaining({ action: "reload", toggledServer: "playwright", disabled: true }),
            },
        ]);
    });

    test("uses the active session cwd when resolving sandbox updates", async () => {
        const replies: unknown[] = [];
        const rctx = {
            latestCtx: { cwd: "/workspace/project-b" },
            sendToWeb: (payload: unknown) => replies.push(payload),
        } as any;

        await handleExecFromWeb(
            { type: "exec", id: "2", command: "sandbox_update_config", config: { mode: "basic", network: { allowedDomains: ["example.com"] } } },
            rctx,
            {} as any,
        );

        expect(loadConfigCalls).toEqual(["/workspace/project-b"]);
        expect(resolveSandboxCalls).toEqual([
            { cwd: "/workspace/project-b", config: { sandbox: { mode: "basic" } } },
        ]);
        expect(saveGlobalCalls).toEqual([
            { sandbox: { mode: "basic", network: { allowedDomains: ["example.com"] } } },
        ]);
        expect(replies.at(-1)).toEqual(
            expect.objectContaining({
                type: "exec_result",
                id: "2",
                ok: true,
                command: "sandbox_update_config",
            }),
        );
    });
});
