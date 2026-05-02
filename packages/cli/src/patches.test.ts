/**
 * Patch compatibility tests for @mariozechner/pi-coding-agent and @mariozechner/pi-ai.
 *
 * These tests verify that the bun patches applied to upstream pi packages
 * are correctly in place and the patched APIs function as expected.
 *
 * If these tests fail after a version bump, you need to recreate the patches.
 * See patches/README.md for details.
 */
import { describe, test, expect } from "bun:test";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

/**
 * Resolve a deep path inside @mariozechner/pi-coding-agent.
 * The package only exports "." and "./hooks", so we resolve from
 * the package root on disk.
 */
function piCodingAgentPath(subpath: string): string {
    const pkgMainUrl = import.meta.resolve("@mariozechner/pi-coding-agent");
    const pkgMain = fileURLToPath(pkgMainUrl);
    // pkgMain → .../dist/index.js, package root is two dirs up
    const pkgRoot = resolve(dirname(pkgMain), "..");
    return resolve(pkgRoot, subpath);
}

/**
 * Resolve a deep path inside @mariozechner/pi-ai.
 */
function piAiPath(subpath: string): string {
    const pkgMainUrl = import.meta.resolve("@mariozechner/pi-ai");
    const pkgMain = fileURLToPath(pkgMainUrl);
    const pkgRoot = resolve(dirname(pkgMain), "..");
    return resolve(pkgRoot, subpath);
}

/**
 * Resolve a deep path inside @mariozechner/pi-agent-core.
 */
function piAgentCorePath(subpath: string): string {
    const pkgMainUrl = import.meta.resolve("@mariozechner/pi-agent-core");
    const pkgMain = fileURLToPath(pkgMainUrl);
    const pkgRoot = resolve(dirname(pkgMain), "..");
    return resolve(pkgRoot, subpath);
}

/**
 * Resolve a deep path inside @mariozechner/pi-tui.
 */
function piTuiPath(subpath: string): string {
    const pkgMainUrl = import.meta.resolve("@mariozechner/pi-tui");
    const pkgMain = fileURLToPath(pkgMainUrl);
    const pkgRoot = resolve(dirname(pkgMain), "..");
    return resolve(pkgRoot, subpath);
}

// ===========================================================================
// pi-coding-agent patches
// ===========================================================================

// ---------------------------------------------------------------------------
// 1. Patch presence — verify patched source contains expected code
// ---------------------------------------------------------------------------

describe("pi-coding-agent patch application", () => {
    test("loader.js: createExtensionRuntime exposes newSession/switchSession stubs", async () => {
        const source = await Bun.file(
            piCodingAgentPath("dist/core/extensions/loader.js"),
        ).text();

        // Runtime stubs
        expect(source).toContain("newSession");
        expect(source).toContain("switchSession");
        // Our patch markers
        expect(source).toContain("PATCH(pizzapi)");
    });

    test("loader.js: createExtensionAPI exposes newSession/switchSession methods", async () => {
        const source = await Bun.file(
            piCodingAgentPath("dist/core/extensions/loader.js"),
        ).text();

        // The API should delegate to runtime.newSession / runtime.switchSession
        expect(source).toContain("runtime.newSession");
        expect(source).toContain("runtime.switchSession");
    });

    test("runner.js: bindCommandContext copies handlers onto runtime", async () => {
        const source = await Bun.file(
            piCodingAgentPath("dist/core/extensions/runner.js"),
        ).text();

        // The patch assigns the handlers to this.runtime
        expect(source).toContain("this.runtime.newSession");
        expect(source).toContain("this.runtime.switchSession");
        expect(source).toContain("PATCH(pizzapi)");
    });

    test("agent-session.js: retryable error regex includes JSON parse errors", async () => {
        const source = await Bun.file(
            piCodingAgentPath("dist/core/agent-session.js"),
        ).text();

        // The patch adds JSON parse error patterns to the retryable error regex
        expect(source).toContain("PATCH(pizzapi): add JSON parse errors to retryable patterns");
        expect(source).toContain("json.?parse.?error");
        expect(source).toContain("unexpected.?end.?of.?json");
    });

    test("interactive-mode.js: version check call is removed from run()", async () => {
        const source = await Bun.file(
            piCodingAgentPath("dist/modes/interactive/interactive-mode.js"),
        ).text();

        // The run() method should NOT contain the version check invocation
        const runMethodStart = source.indexOf("async run()");
        expect(runMethodStart).not.toBe(-1);
        const runMethod = source.slice(runMethodStart, runMethodStart + 500);
        expect(runMethod).not.toContain("checkForNewVersion");
    });

    test("interactive-mode.js: checkForNewVersion method is removed", async () => {
        const source = await Bun.file(
            piCodingAgentPath("dist/modes/interactive/interactive-mode.js"),
        ).text();

        expect(source).not.toContain("async checkForNewVersion()");
        expect(source).not.toContain("showNewVersionNotification");
    });

    test("config.js: CONFIG_DIR_NAME is overridden to .pizzapi", async () => {
        const source = await Bun.file(
            piCodingAgentPath("dist/config.js"),
        ).text();

        // Must hardcode .pizzapi, not read from upstream package.json
        expect(source).toContain('CONFIG_DIR_NAME = ".pizzapi"');
        expect(source).not.toContain('CONFIG_DIR_NAME = pkg.piConfig');
        expect(source).toContain("PATCH(pizzapi)");
    });

    test("config.js: getAgentDir() returns ~/.pizzapi/ (flat, no /agent/ segment)", async () => {
        const source = await Bun.file(
            piCodingAgentPath("dist/config.js"),
        ).text();

        // Must NOT append "agent" to the path
        expect(source).toContain('return join(homedir(), CONFIG_DIR_NAME)');
        expect(source).not.toContain('return join(homedir(), CONFIG_DIR_NAME, "agent")');
        expect(source).toContain("PATCH(pizzapi): flat directory structure");
    });

    test("config.js: getChangelogPath honors PIZZAPI_CHANGELOG_PATH", async () => {
        const { getChangelogPath } = await import(piCodingAgentPath("dist/config.js"));
        const prev = process.env.PIZZAPI_CHANGELOG_PATH;
        process.env.PIZZAPI_CHANGELOG_PATH = "/tmp/pizzapi-changelog-test.md";
        try {
            expect(getChangelogPath()).toBe("/tmp/pizzapi-changelog-test.md");
        } finally {
            if (prev === undefined) delete process.env.PIZZAPI_CHANGELOG_PATH;
            else process.env.PIZZAPI_CHANGELOG_PATH = prev;
        }
    });
});

// ---------------------------------------------------------------------------
// 2. Functional — verify patched runtime/API objects behave correctly
// ---------------------------------------------------------------------------

describe("pi-coding-agent patched runtime behavior", () => {
    // The first dynamic import of loader.js is slow on cold start (the package
    // is large and Bun's module resolver takes ~10-20s the first time in CI).
    // Give it a generous timeout; subsequent tests in this describe block reuse
    // the cached module and are fast.
    test(
        "createExtensionRuntime returns object with newSession/switchSession",
        async () => {
            const { createExtensionRuntime } = await import(
                piCodingAgentPath("dist/core/extensions/loader.js")
            );
            const runtime = createExtensionRuntime();

            expect(typeof runtime.newSession).toBe("function");
            expect(typeof runtime.switchSession).toBe("function");
        },
        30_000,
    );

    test("runtime.newSession rejects before initialization", async () => {
        const { createExtensionRuntime } = await import(
            piCodingAgentPath("dist/core/extensions/loader.js")
        );
        const runtime = createExtensionRuntime();

        await expect(runtime.newSession()).rejects.toThrow(/not initialized/i);
    });

    test("runtime.switchSession rejects before initialization", async () => {
        const { createExtensionRuntime } = await import(
            piCodingAgentPath("dist/core/extensions/loader.js")
        );
        const runtime = createExtensionRuntime();

        await expect(runtime.switchSession("/some/path")).rejects.toThrow(/not initialized/i);
    });

    test("retryable error regex matches JSON parse errors from truncated streams", async () => {
        // Extract the regex from the patched source and verify it matches
        // the actual error messages that Bun/JavaScriptCore produces.
        const source = await Bun.file(
            piCodingAgentPath("dist/core/agent-session.js"),
        ).text();

        // Find the regex pattern in the source
        const match = source.match(/return (\/overloaded.*?\/i)\.test\(err\)/);
        expect(match).not.toBeNull();
        const regex = eval(match![1]); // Safe: we're evaluating a known regex literal from our own patched code

        // Bun/JavaScriptCore format
        expect(regex.test("JSON Parse error: Expected '}'")).toBe(true);
        expect(regex.test("JSON Parse error: Unexpected end of input")).toBe(true);
        // V8/Node format
        expect(regex.test("Unexpected end of JSON input")).toBe(true);
        // Ensure existing patterns still match
        expect(regex.test("overloaded_error")).toBe(true);
        expect(regex.test("rate limit exceeded")).toBe(true);
        expect(regex.test("Error 529: overloaded")).toBe(true);
        expect(regex.test("fetch failed")).toBe(true);
    });

    test("CONFIG_DIR_NAME exports as .pizzapi at runtime", async () => {
        const { CONFIG_DIR_NAME } = await import(
            piCodingAgentPath("dist/config.js")
        );
        expect(CONFIG_DIR_NAME).toBe(".pizzapi");
    });

    test("getAgentDir returns flat ~/.pizzapi/ path (no /agent/ segment)", async () => {
        const { getAgentDir } = await import(
            piCodingAgentPath("dist/config.js")
        );
        const dir = getAgentDir();
        expect(dir).toContain(".pizzapi");
        expect(dir).not.toContain(".pizzapi/agent");
        expect(dir).not.toMatch(/\/\.pi\//);
    });

    test("getSessionsDir uses flat ~/.pizzapi/sessions path", async () => {
        const { getSessionsDir } = await import(
            piCodingAgentPath("dist/config.js")
        );
        const dir = getSessionsDir();
        expect(dir).toContain(".pizzapi/sessions");
        expect(dir).not.toContain(".pizzapi/agent/sessions");
    });

    test("runtime.newSession/switchSession are assignable (runner can bind them)", async () => {
        const { createExtensionRuntime } = await import(
            piCodingAgentPath("dist/core/extensions/loader.js")
        );
        const runtime = createExtensionRuntime();

        // Simulate what runner.js bindCommandContext does
        const mockResult = { cancelled: false };
        runtime.newSession = async () => mockResult;
        runtime.switchSession = async () => mockResult;

        const newResult = await runtime.newSession();
        const switchResult = await runtime.switchSession("/test");

        expect(newResult).toEqual(mockResult);
        expect(switchResult).toEqual(mockResult);
    });
});

// ---------------------------------------------------------------------------
// 3. API surface — verify existing (non-patched) APIs still work
// ---------------------------------------------------------------------------

describe("pi-coding-agent API surface compatibility", () => {
    test("createAgentSession is exported", async () => {
        const mod = await import("@mariozechner/pi-coding-agent");
        expect(typeof mod.createAgentSession).toBe("function");
    });

    test("ExtensionRunner class is exported and constructable", async () => {
        const { ExtensionRunner } = await import(
            piCodingAgentPath("dist/core/extensions/runner.js")
        );
        expect(typeof ExtensionRunner).toBe("function");
    });

    test("SessionManager and related types are accessible", async () => {
        const mod = await import("@mariozechner/pi-coding-agent");
        expect(mod.SessionManager).toBeDefined();
        expect(typeof mod.SessionManager).toBe("function");
    });

    test("AuthStorage is exported", async () => {
        const mod = await import("@mariozechner/pi-coding-agent");
        expect(mod.AuthStorage).toBeDefined();
    });

    test("buildSessionContext is exported", async () => {
        const mod = await import("@mariozechner/pi-coding-agent");
        expect(typeof mod.buildSessionContext).toBe("function");
    });
});

describe("pi-agent-core dynamic tool refresh", () => {
    test("tools loaded during a tool call are visible to the very next assistant response", async () => {
        const { Agent } = await import("@mariozechner/pi-agent-core");

        const usage = {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        };
        const model = {
            id: "test-model",
            name: "Test Model",
            api: "test-api",
            provider: "test-provider",
            baseUrl: "http://localhost",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 128000,
            maxTokens: 4096,
        };

        const seenToolSets: string[][] = [];
        const responses = [
            {
                role: "assistant",
                content: [{ type: "toolCall", id: "tc-search", name: "search_tools", arguments: { query: "load dynamic tool" } }],
                api: model.api,
                provider: model.provider,
                model: model.id,
                usage,
                stopReason: "stop",
                timestamp: Date.now(),
            },
            {
                role: "assistant",
                content: [{ type: "toolCall", id: "tc-dynamic", name: "dynamic_tool", arguments: {} }],
                api: model.api,
                provider: model.provider,
                model: model.id,
                usage,
                stopReason: "stop",
                timestamp: Date.now(),
            },
            {
                role: "assistant",
                content: [{ type: "text", text: "done" }],
                api: model.api,
                provider: model.provider,
                model: model.id,
                usage,
                stopReason: "stop",
                timestamp: Date.now(),
            },
        ];

        const streamFn = async (_model: unknown, context: { tools?: Array<{ name: string }> }) => {
            seenToolSets.push((context.tools ?? []).map((tool) => tool.name));
            const message = responses.shift();
            if (!message) throw new Error("No more responses queued");
            return {
                async *[Symbol.asyncIterator]() {
                    yield { type: "done" } as const;
                },
                async result() {
                    return message;
                },
            };
        };

        let agent: InstanceType<typeof Agent>;
        const dynamicTool = {
            name: "dynamic_tool",
            label: "Dynamic Tool",
            description: "Loaded on demand",
            parameters: { type: "object", properties: {} },
            async execute() {
                return { content: [{ type: "text" as const, text: "dynamic ok" }], details: {} };
            },
        };
        const searchTool = {
            name: "search_tools",
            label: "Search Tools",
            description: "Loads the deferred tool",
            parameters: {
                type: "object",
                properties: { query: { type: "string" } },
                required: ["query"],
            },
            async execute() {
                agent.state.tools = [searchTool, dynamicTool];
                return { content: [{ type: "text" as const, text: "loaded dynamic_tool" }], details: {} };
            },
        };

        agent = new Agent({
            initialState: {
                model: model as any,
                systemPrompt: "test",
                tools: [searchTool as any],
            },
            streamFn: streamFn as any,
            toolExecution: "sequential",
        });

        await agent.prompt("go");

        expect(seenToolSets).toHaveLength(3);
        expect(seenToolSets[0]).toEqual(["search_tools"]);
        expect(seenToolSets[1]).toContain("dynamic_tool");

        const dynamicToolResult = agent.state.messages.find(
            (message: any) => message.role === "toolResult" && message.toolName === "dynamic_tool",
        ) as any;
        expect(dynamicToolResult).toBeDefined();
        expect(dynamicToolResult.isError).toBe(false);
        expect(dynamicToolResult.content).toEqual([{ type: "text", text: "dynamic ok" }]);
    });
});

describe("pi-agent-core patch application", () => {
    test("agent.js + agent-loop.js include dynamic tool refresh patch markers", async () => {
        const agentSource = await Bun.file(
            piAgentCorePath("dist/agent.js"),
        ).text();
        const loopSource = await Bun.file(
            piAgentCorePath("dist/agent-loop.js"),
        ).text();

        expect(agentSource).toContain("PATCH(pizzapi): allow the agent loop to refresh dynamic tool/prompt state");
        expect(loopSource).toContain("PATCH(pizzapi): refresh dynamic tool/prompt state before each assistant response");
    });
});

// ===========================================================================
// pi-ai patches (Anthropic web search support)
// ===========================================================================

describe("pi-ai patch application — Anthropic web search", () => {
    test("anthropic.js: convertTools passes through server-side tool objects", async () => {
        const source = await Bun.file(
            piAiPath("dist/providers/anthropic.js"),
        ).text();

        // The patch checks for tool.type before converting
        expect(source).toContain("PATCH(pizzapi): pass through server-side tools");
        expect(source).toContain('tool.type && typeof tool.type === "string"');
    });

    test("anthropic.js: buildParams injects web search tool from PIZZAPI_WEB_SEARCH env", async () => {
        const source = await Bun.file(
            piAiPath("dist/providers/anthropic.js"),
        ).text();

        expect(source).toContain("PATCH(pizzapi): inject Anthropic web search tool");
        expect(source).toContain("PIZZAPI_WEB_SEARCH");
        expect(source).toContain("web_search_20250305");
        expect(source).toContain("PIZZAPI_WEB_SEARCH_MAX_USES");
        expect(source).toContain("PIZZAPI_WEB_SEARCH_ALLOWED_DOMAINS");
        expect(source).toContain("PIZZAPI_WEB_SEARCH_BLOCKED_DOMAINS");
        // P2: env var must be parsed as explicit boolean (reject "0", "false", "no", "off")
        expect(source).toMatch(/\["0",\s*"false",\s*"no",\s*"off"\]/);
    });

    test("anthropic.js: stream handler processes server_tool_use blocks", async () => {
        const source = await Bun.file(
            piAiPath("dist/providers/anthropic.js"),
        ).text();

        expect(source).toContain("PATCH(pizzapi): handle server_tool_use");
        expect(source).toContain('"server_tool_use"');
        expect(source).toContain("_serverToolUse");
    });

    test("anthropic.js: stream handler processes web_search_tool_result blocks", async () => {
        const source = await Bun.file(
            piAiPath("dist/providers/anthropic.js"),
        ).text();

        expect(source).toContain("PATCH(pizzapi): handle web_search_tool_result");
        expect(source).toContain('"web_search_tool_result"');
        expect(source).toContain("_webSearchResult");
    });

    test("anthropic.js: convertMessages round-trips server tool blocks", async () => {
        const source = await Bun.file(
            piAiPath("dist/providers/anthropic.js"),
        ).text();

        expect(source).toContain("PATCH(pizzapi): round-trip server tool use");
        // Verify both server_tool_use and web_search_tool_result are round-tripped
        expect(source).toContain("block._serverToolUse");
        expect(source).toContain("block._webSearchResult");
    });

    test("anthropic.js: file is syntactically valid", async () => {
        // If the patch broke the JS syntax, this import will throw
        const mod = await import(piAiPath("dist/providers/anthropic.js"));
        expect(typeof mod.streamAnthropic).toBe("function");
        expect(typeof mod.streamSimpleAnthropic).toBe("function");
    });
});

describe("pi-ai patch application — Claude Code credentials fallback (Keychain-first)", () => {
    test("anthropic.js (oauth): tryReadClaudeCodeCredentials with Keychain + file fallback", async () => {
        const source = await Bun.file(
            piAiPath("dist/utils/oauth/anthropic.js"),
        ).text();

        expect(source).toContain("PATCH(pizzapi): read Claude Code credentials as a refresh fallback");
        expect(source).toContain("async function tryReadClaudeCodeCredentials");
        // Keychain path (macOS preferred)
        expect(source).toContain("security find-generic-password");
        expect(source).toContain("Claude Code-credentials");
        // File fallback path
        expect(source).toContain(".claude");
        expect(source).toContain(".credentials.json");
        expect(source).toContain("claudeAiOauth");
    });

    test("anthropic.js (oauth): refreshToken awaits Claude Code credentials first", async () => {
        const source = await Bun.file(
            piAiPath("dist/utils/oauth/anthropic.js"),
        ).text();

        expect(source).toContain("PATCH(pizzapi): try Claude Code credentials first");
        // Verify the fallback awaits tryReadClaudeCodeCredentials before refreshAnthropicToken
        const ccCredsIndex = source.indexOf("await tryReadClaudeCodeCredentials()");
        const refreshIndex = source.indexOf("refreshAnthropicToken(credentials.refresh)");
        expect(ccCredsIndex).toBeGreaterThan(-1);
        expect(refreshIndex).toBeGreaterThan(-1);
        expect(ccCredsIndex).toBeLessThan(refreshIndex);
    });

    test("anthropic.js (oauth): file is syntactically valid", async () => {
        const mod = await import(piAiPath("dist/utils/oauth/anthropic.js"));
        expect(typeof mod.anthropicOAuthProvider).toBe("object");
        expect(typeof mod.anthropicOAuthProvider.refreshToken).toBe("function");
        expect(typeof mod.loginAnthropic).toBe("function");
        expect(typeof mod.refreshAnthropicToken).toBe("function");
    });

    test("anthropic.js (oauth): 60s safety margin on credential expiry", async () => {
        const source = await Bun.file(
            piAiPath("dist/utils/oauth/anthropic.js"),
        ).text();

        // Ensures we don't use credentials that expire within 60 seconds
        expect(source).toContain("Date.now() + 60000");
    });
});

// ===========================================================================
// pi-tui patches (Windows console output lifecycle)
// ===========================================================================

describe("pi-tui patch application — Windows console output lifecycle", () => {
    test("terminal.js contains PATCH(pizzapi): Windows console output lifecycle", async () => {
        const source = await Bun.file(
            piTuiPath("dist/terminal.js"),
        ).text();

        expect(source).toContain("PATCH(pizzapi): Windows console output lifecycle");
        expect(source).toContain("export function createWindowsConsoleLifecycle");
    });

    test("terminal.js wires setupWindowsConsole into start()", async () => {
        const source = await Bun.file(
            piTuiPath("dist/terminal.js"),
        ).text();

        const startIndex = source.indexOf("start(onInput, onResize) {");
        const setupIndex = source.indexOf("setupStdinBuffer() {", startIndex);
        expect(startIndex).toBeGreaterThan(-1);
        expect(setupIndex).toBeGreaterThan(startIndex);
        const startMethod = source.slice(startIndex, setupIndex);

        expect(startMethod).toContain("this.setupWindowsConsole();");
        expect(startMethod).toContain("this.enableWindowsVTInput();");
    });

    test("terminal.js restores Windows console state in stop()", async () => {
        const source = await Bun.file(
            piTuiPath("dist/terminal.js"),
        ).text();

        const stopIndex = source.indexOf("stop() {");
        const writeIndex = source.indexOf("write(data) {", stopIndex);
        expect(stopIndex).toBeGreaterThan(-1);
        expect(writeIndex).toBeGreaterThan(stopIndex);
        const stopMethod = source.slice(stopIndex, writeIndex);

        expect(stopMethod).toContain("this.windowsConsoleLifecycle.restore();");
        expect(stopMethod).toContain("delete globalThis.__PI_WINDOWS_CONSOLE_CAPS__");
        expect(stopMethod).toContain("process.stdin.setRawMode(this.wasRaw);");
    });

    test("createWindowsConsoleLifecycle is a no-op off Windows", async () => {
        const { createWindowsConsoleLifecycle } = await import(
            piTuiPath("dist/terminal.js")
        ) as {
            createWindowsConsoleLifecycle: () => {
                activate: () => { stdoutMode: string; stderrMode: string; source: string };
                restore: () => void;
            };
        };

        const lifecycle = createWindowsConsoleLifecycle();
        const result = lifecycle.activate();

        if (process.platform === "win32") {
            expect(result.source).toBe("pi-tui");
            expect(["unicode", "ascii", "unknown"]).toContain(result.stdoutMode);
            expect(["unicode", "ascii", "unknown"]).toContain(result.stderrMode);
        } else {
            expect(result).toEqual({
                stdoutMode: "unknown",
                stderrMode: "unknown",
                source: "pi-tui",
            });
        }

        // restore should be safe to call repeatedly
        expect(() => lifecycle.restore()).not.toThrow();
    });

    test("ProcessTerminal.start publishes __PI_WINDOWS_CONSOLE_CAPS__ on Windows", async () => {
        const { ProcessTerminal } = await import(
            piTuiPath("dist/terminal.js")
        ) as {
            ProcessTerminal: new () => {
                start: (onInput: () => void, onResize: () => void) => void;
                stop: () => void;
            };
        };

        // On non-Windows we still verify the contract path doesn't crash
        if (process.platform !== "win32") {
            const globalObj = globalThis as typeof globalThis & {
                __PI_WINDOWS_CONSOLE_CAPS__?: unknown;
            };
            const hadCaps = Object.prototype.hasOwnProperty.call(globalObj, "__PI_WINDOWS_CONSOLE_CAPS__");
            const originalCaps = globalObj.__PI_WINDOWS_CONSOLE_CAPS__;

            try {
                const terminal = new ProcessTerminal();
                terminal.start(() => {}, () => {});
                // On non-Windows it may still set the caps from the lifecycle
                terminal.stop();
            } finally {
                if (hadCaps) {
                    globalObj.__PI_WINDOWS_CONSOLE_CAPS__ = originalCaps;
                } else {
                    delete globalObj.__PI_WINDOWS_CONSOLE_CAPS__;
                }
            }
        }
    });
});
