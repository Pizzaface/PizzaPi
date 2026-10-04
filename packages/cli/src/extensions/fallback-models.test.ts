import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { Agent } from "@earendil-works/pi-agent-core";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as realOs from "node:os";

mock.module("node:os", () => ({
    ...realOs,
    homedir: () => process.env.HOME ?? realOs.homedir(),
}));

let providerUsage: Record<string, any> = {};
function stampProviderUsage(): void {
    const now = Date.now();
    for (const data of Object.values(providerUsage)) {
        if (data && typeof data === "object") {
            data.fetchedAt = now;
            data.checkedAt = now;
            data.expiresAt = now + 5 * 60 * 1000;
        }
    }
}

const defaultRefreshUsage = async () => { stampProviderUsage(); };
const refreshAllUsageMock = mock(defaultRefreshUsage);

mock.module("./remote-provider-usage.js", () => ({
    refreshAllUsage: refreshAllUsageMock,
    buildProviderUsage: () => providerUsage,
}));

const { fallbackModelsExtension } = await import("./fallback-models.js");
const { AgentSession } = await import("@earendil-works/pi-coding-agent");

function makeFakePi() {
    const handlers: Record<string, Function> = {};
    const commands = new Map<string, any>();
    const sentMessages: any[] = [];
    const sentUserMessages: any[] = [];
    const setModelCalls: any[] = [];

    const pi: any = {
        on: mock((event: string, handler: Function) => {
            handlers[event] = handler;
        }),
        registerCommand: mock((name: string, opts: any) => commands.set(name, opts)),
        sendMessage: mock((msg: any, opts?: any) => sentMessages.push({ ...msg, _opts: opts })),
        sendUserMessage: mock((...args: any[]) => sentUserMessages.push(args)),
        setModel: mock(async (model: any) => {
            setModelCalls.push(model);
            return true;
        }),
        _handlers: handlers,
        _commands: commands,
        _sent: sentMessages,
        _userMessages: sentUserMessages,
        _setModelCalls: setModelCalls,
    };
    return pi;
}

function makeFakeContext(model?: { provider: string; id: string }) {
    const registryModels = new Map<
        string,
        { provider: string; id: string; hasAuth: boolean }
    >();

    const ctx: any = {
        sessionManager: { getSessionId: () => "test-session" },
        modelRegistry: {
            find: mock((provider: string, id: string) => {
                const key = `${provider}:${id}`;
                return registryModels.get(key) ?? undefined;
            }),
            hasConfiguredAuth: mock((m: any) => {
                const key = `${m.provider}:${m.id}`;
                return registryModels.get(key)?.hasAuth ?? false;
            }),
            getAll: mock(() => Array.from(registryModels.values())),
            _register: (provider: string, id: string, hasAuth = true) => {
                registryModels.set(`${provider}:${id}`, { provider, id, hasAuth });
            },
        },
        model: model ?? { provider: "anthropic", id: "claude-sonnet-4-5" },
        cwd: "/tmp",
        signal: new AbortController().signal,
    };
    return ctx;
}

describe("fallbackModelsExtension", () => {
    let tmpHome: string;
    let originalHome: string | undefined;

    beforeEach(() => {
        tmpHome = mkdtempSync(join(tmpdir(), "fallback-test-"));
        originalHome = process.env.HOME;
        process.env.HOME = tmpHome;
        mkdirSync(join(tmpHome, ".pizzapi"), { recursive: true });
    });

    afterEach(() => {
        process.env.HOME = originalHome;
        rmSync(tmpHome, { recursive: true, force: true });
    });

    function writeSettings(fallbackModels: unknown, waitForRateLimits = false) {
        writeFileSync(
            join(tmpHome, ".pizzapi", "settings.json"),
            JSON.stringify({ fallbackModels, waitForRateLimits }),
        );
        providerUsage = {};
        refreshAllUsageMock.mockImplementation(defaultRefreshUsage);
        refreshAllUsageMock.mockClear();
    }

    test("ignores non-rate-limit errors when fallback models are configured", async () => {
        writeSettings(["openai-codex:gpt-5.5"]);
        const pi = makeFakePi();
        const ctx = makeFakeContext();
        ctx.modelRegistry._register("openai-codex", "gpt-5.5");

        fallbackModelsExtension(pi);
        pi._handlers.session_start({}, ctx);
        pi._handlers.input({ text: "hello" }, ctx);

        await pi._handlers.turn_end(
            { message: { role: "assistant", stopReason: "error", errorMessage: "Something broke" } },
            ctx,
        );

        expect(pi.setModel).not.toHaveBeenCalled();
        expect(pi.sendUserMessage).not.toHaveBeenCalled();
    });

    test("switches to first fallback and retries the last prompt on provider-overload error", async () => {
        writeSettings(["openai-codex:gpt-5.5"]);
        const pi = makeFakePi();
        const ctx = makeFakeContext();
        ctx.modelRegistry._register("openai-codex", "gpt-5.5");

        fallbackModelsExtension(pi);
        pi._handlers.session_start({}, ctx);
        pi._handlers.input({ text: "say hi" }, ctx);

        await pi._handlers.turn_end(
            {
                message: {
                    role: "assistant",
                    stopReason: "error",
                    errorMessage:
                        "overloaded_error: Overloaded [status=200; request_id=req_011CeAZaCn185y5ESxRDYZMu; saw_message_stop=false; saw_tool_block=false]",
                },
            },
            ctx,
        );

        expect(pi.setModel).toHaveBeenCalledWith({ provider: "openai-codex", id: "gpt-5.5", hasAuth: true });
        expect(pi._userMessages).toHaveLength(1);
        expect(pi._userMessages[0]).toEqual(["say hi", { deliverAs: "steer" }]);
        expect(pi._sent[0]?.customType).toBe("fallback_status");
    });

    test("switches to first fallback and retries the last prompt on rate-limit error", async () => {
        writeSettings(["openai-codex:gpt-5.5"]);
        const pi = makeFakePi();
        const ctx = makeFakeContext();
        ctx.modelRegistry._register("openai-codex", "gpt-5.5");

        fallbackModelsExtension(pi);
        pi._handlers.session_start({}, ctx);
        pi._handlers.input({ text: "say hi" }, ctx);

        await pi._handlers.turn_end(
            {
                message: {
                    role: "assistant",
                    stopReason: "error",
                    errorMessage: "Rate limit reached",
                },
            },
            ctx,
        );

        expect(pi.setModel).toHaveBeenCalledWith({ provider: "openai-codex", id: "gpt-5.5", hasAuth: true });
        expect(pi._userMessages).toHaveLength(1);
        expect(pi._userMessages[0]).toEqual(["say hi", { deliverAs: "steer" }]);
        expect(pi._sent[0]?.customType).toBe("fallback_status");
    });

    test("cascades to the next fallback when the first fallback also rate-limits", async () => {
        writeSettings(["openai-codex:gpt-5.5", "ollama-cloud:glm-5.2"]);
        const pi = makeFakePi();
        const ctx = makeFakeContext();
        ctx.modelRegistry._register("openai-codex", "gpt-5.5");
        ctx.modelRegistry._register("ollama-cloud", "glm-5.2");

        fallbackModelsExtension(pi);
        pi._handlers.session_start({}, ctx);
        pi._handlers.input({ text: "hello" }, ctx);

        // First turn: primary (anthropic) rate-limits → switch to openai-codex.
        await pi._handlers.turn_end(
            {
                message: {
                    role: "assistant",
                    stopReason: "error",
                    errorMessage: "Rate limit reached",
                },
            },
            ctx,
        );

        expect(pi._setModelCalls).toHaveLength(1);
        expect(pi._setModelCalls[0]).toEqual({ provider: "openai-codex", id: "gpt-5.5", hasAuth: true });

        // Simulate that the model was switched and the steer retry is now running on openai-codex.
        ctx.model = { provider: "openai-codex", id: "gpt-5.5" };
        // The steer retry does not fire a new input event, so lastInput is still "hello".

        await pi._handlers.turn_end(
            {
                message: {
                    role: "assistant",
                    stopReason: "error",
                    errorMessage: "Rate limit reached",
                },
            },
            ctx,
        );

        expect(pi._setModelCalls).toHaveLength(2);
        expect(pi._setModelCalls[1]).toEqual({ provider: "ollama-cloud", id: "glm-5.2", hasAuth: true });
    });

    test("skips unavailable fallbacks and tries the next one", async () => {
        writeSettings(["openai-codex:gpt-5.5", "ollama-cloud:glm-5.2"]);
        const pi = makeFakePi();
        const ctx = makeFakeContext();
        // gpt-5.5 is registered but lacks auth; glm-5.2 is available.
        ctx.modelRegistry._register("openai-codex", "gpt-5.5", false);
        ctx.modelRegistry._register("ollama-cloud", "glm-5.2", true);

        fallbackModelsExtension(pi);
        pi._handlers.session_start({}, ctx);
        pi._handlers.input({ text: "hello" }, ctx);

        await pi._handlers.turn_end(
            {
                message: {
                    role: "assistant",
                    stopReason: "error",
                    errorMessage: "Rate limit reached",
                },
            },
            ctx,
        );

        expect(pi._setModelCalls).toHaveLength(1);
        expect(pi._setModelCalls[0]).toEqual({ provider: "ollama-cloud", id: "glm-5.2", hasAuth: true });
    });

    test("gives up after all fallbacks are exhausted", async () => {
        writeSettings(["openai-codex:gpt-5.5"]);
        const pi = makeFakePi();
        const ctx = makeFakeContext();
        ctx.modelRegistry._register("openai-codex", "gpt-5.5");

        fallbackModelsExtension(pi);
        pi._handlers.session_start({}, ctx);
        pi._handlers.input({ text: "hello" }, ctx);

        // Primary (anthropic) rate-limits; switch to openai-codex.
        await pi._handlers.turn_end(
            {
                message: {
                    role: "assistant",
                    stopReason: "error",
                    errorMessage: "Rate limit reached",
                },
            },
            ctx,
        );
        expect(pi._setModelCalls).toHaveLength(1);

        // Now the active model is the fallback. It rate-limits too; no more fallbacks.
        ctx.model = { provider: "openai-codex", id: "gpt-5.5" };
        await pi._handlers.turn_end(
            {
                message: {
                    role: "assistant",
                    stopReason: "error",
                    errorMessage: "Rate limit reached",
                },
            },
            ctx,
        );

        expect(pi._setModelCalls).toHaveLength(1);
        const statusMessages = pi._sent.filter((m: any) => m.customType === "fallback_status");
        expect(statusMessages.at(-1)?.content).toContain("All configured fallback models");
    });

    test("status notices never trigger a turn (would otherwise loop on a rate-limited session)", async () => {
        writeSettings(["openai-codex:gpt-5.5"]);
        const pi = makeFakePi();
        const ctx = makeFakeContext();
        ctx.modelRegistry._register("openai-codex", "gpt-5.5");

        fallbackModelsExtension(pi);
        pi._handlers.session_start({}, ctx);
        pi._handlers.input({ text: "hello" }, ctx);

        const err = { message: { role: "assistant", stopReason: "error", errorMessage: "Rate limit reached" } };
        await pi._handlers.turn_end(err, ctx);
        ctx.model = { provider: "openai-codex", id: "gpt-5.5" };
        await pi._handlers.turn_end(err, ctx);
        await pi._handlers.turn_end(err, ctx);

        // turn_end fires mid-stream; pi steers any sendMessage lacking triggerTurn:false into the agent.
        expect(pi._sent.length).toBeGreaterThan(0);
        for (const m of pi._sent) expect(m._opts).toEqual({ triggerTurn: false });
        // Only the one real fallback retry is ever issued.
        expect(pi._userMessages).toHaveLength(1);
    });

    test("waits for current model quota in turn_end and continues once without replaying input", async () => {
        const resetAt = Date.now() + 10;
        writeSettings([], true);
        providerUsage = {
            anthropic: { status: "ok", windows: [{ label: "5-hour", utilization: 100, resets_at: new Date(resetAt).toISOString() }] },
        };
        let refreshes = 0;
        refreshAllUsageMock.mockImplementation(async () => {
            refreshes++;
            if (refreshes > 1) {
                providerUsage = {
                    anthropic: { status: "ok", windows: [{ label: "5-hour", utilization: 50, resets_at: new Date(Date.now() + 1000).toISOString() }] },
                };
            }
            stampProviderUsage();
        });
        const pi = makeFakePi();
        const ctx = makeFakeContext();

        fallbackModelsExtension(pi);
        pi._handlers.session_start({}, ctx);
        pi._handlers.input({ text: "do work" }, ctx);

        const result = await pi._handlers.turn_end(
            { message: { role: "assistant", stopReason: "error", errorMessage: "Rate limit reached" } },
            ctx,
        );

        expect(result?.continue).toBe(true);
        expect(result?.entries?.[0]).toMatchObject({ type: "custom_message", customType: "fallback_status" });
        expect(pi._userMessages).toHaveLength(0);
        expect(pi._handlers.agent_before_settle).toBeUndefined();
    });

    test("AgentSession turn_end boundary itself stays pending while extension waits", async () => {
        let release!: () => void;
        const fakeSession = Object.assign(Object.create((AgentSession as any).prototype), {
            _lastActivityOutcome: "completed",
            _turnIndex: 1,
            _extensionRunner: {
                hasHandlers: () => true,
                emitError: () => {},
                emitBoundary: async (_event: any) => {
                    await new Promise<void>((resolve) => { release = resolve; });
                    return { entries: [], continue: true };
                },
            },
            _findPersistedMessageEntryId: () => "entry-1",
            _buildBoundaryContext: () => ({ canContinue: true }),
            _commitBoundaryDrafts: () => {},
            _reportInvalidBoundaryContinuation: () => {},
        });

        let settled = false;
        const wait = (fakeSession as any)._dispatchTurnEndBoundary({ role: "assistant", stopReason: "error" }, [])
            .then((value: boolean) => { settled = true; return value; });
        await Promise.resolve();
        expect(settled).toBe(false);
        release();
        expect(await wait).toBe(true);
    });

    test("turn_end remains pending while quota wait is active", async () => {
        writeSettings([], true);
        let resolveRefresh: (() => void) | undefined;
        refreshAllUsageMock.mockImplementationOnce(async () => {
            await new Promise<void>((resolve) => { resolveRefresh = resolve; });
            stampProviderUsage();
        });
        providerUsage = {
            anthropic: { status: "ok", windows: [{ label: "5-hour", utilization: 100, resets_at: new Date(Date.now() + 1000).toISOString() }] },
        };
        const pi = makeFakePi();
        const ctx = makeFakeContext();

        fallbackModelsExtension(pi);
        pi._handlers.session_start({}, ctx);
        pi._handlers.input({ text: "do work" }, ctx);

        let settled = false;
        const wait = pi._handlers.turn_end(
            { message: { role: "assistant", stopReason: "error", errorMessage: "Rate limit reached" } },
            ctx,
        ).then(() => { settled = true; });
        await Promise.resolve();
        expect(settled).toBe(false);

        providerUsage = {
            anthropic: { status: "ok", windows: [{ label: "5-hour", utilization: 50, resets_at: new Date(Date.now() + 1000).toISOString() }] },
        };
        stampProviderUsage();
        resolveRefresh?.();
        await wait;
        expect(settled).toBe(true);
    });

    test("real Agent turn_end wait is cancelled by Agent.abort", async () => {
        writeSettings([], true);
        let resolveRefresh: (() => void) | undefined;
        let refreshStarted!: () => void;
        const refreshStartedPromise = new Promise<void>((resolve) => { refreshStarted = resolve; });
        refreshAllUsageMock.mockImplementationOnce(async () => {
            refreshStarted();
            await new Promise<void>((resolve) => { resolveRefresh = resolve; });
            stampProviderUsage();
        });
        providerUsage = {
            anthropic: { status: "ok", windows: [{ label: "5-hour", utilization: 100, resets_at: new Date(Date.now() + 1000).toISOString() }] },
        };
        const pi = makeFakePi();
        const ctx = makeFakeContext();
        fallbackModelsExtension(pi);
        pi._handlers.session_start({}, ctx);
        pi._handlers.input({ text: "do work" }, ctx);

        const model = { provider: "anthropic", id: "claude-sonnet-4-5", api: "test", name: "Test", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000, maxTokens: 100 };
        const agent = new Agent({
            initialState: { model: model as any, systemPrompt: "test", tools: [] },
            streamFn: (async () => ({
                async *[Symbol.asyncIterator]() { yield { type: "done" } as const; },
                async result() {
                    return { role: "assistant", content: [], api: "test", provider: "anthropic", model: "claude-sonnet-4-5", stopReason: "error", errorMessage: "Rate limit reached", timestamp: Date.now() } as any;
                },
            }) as any) as any,
        });
        agent.subscribe(async (event, signal) => {
            if (event.type !== "turn_end") return;
            ctx.signal = signal;
            await pi._handlers.turn_end({ message: event.message, toolResults: event.toolResults }, ctx);
        });

        const prompt = agent.prompt("go");
        await refreshStartedPromise;
        agent.abort();
        try {
            await expect(Promise.race([
                prompt.then(() => "settled"),
                new Promise((resolve) => setTimeout(() => resolve("timeout"), 1000)),
            ])).resolves.toBe("settled");
        } finally {
            resolveRefresh?.();
        }
        expect(pi._sent.at(-1)?.content).toContain("cancelled");
        expect(pi._userMessages).toHaveLength(0);
    });

    test("remote stop abort signal cancels an active quota wait", async () => {
        writeSettings([], true);
        let resolveRefresh: (() => void) | undefined;
        refreshAllUsageMock.mockImplementationOnce(async () => {
            await new Promise<void>((resolve) => { resolveRefresh = resolve; });
            stampProviderUsage();
        });
        providerUsage = {
            anthropic: { status: "ok", windows: [{ label: "5-hour", utilization: 100, resets_at: new Date(Date.now() + 1000).toISOString() }] },
        };
        const pi = makeFakePi();
        const controller = new AbortController();
        const ctx = makeFakeContext();
        ctx.signal = controller.signal;

        fallbackModelsExtension(pi);
        pi._handlers.session_start({}, ctx);
        pi._handlers.input({ text: "do work" }, ctx);

        const wait = pi._handlers.turn_end(
            { message: { role: "assistant", stopReason: "error", errorMessage: "Rate limit reached" } },
            ctx,
        );
        await Promise.resolve();
        controller.abort("remote stop");
        resolveRefresh?.();
        await expect(wait).resolves.toBeUndefined();
        expect(pi._sent.at(-1)?.content).toContain("cancelled");
    });

    test("does not wait when confirmed quota is unknown", async () => {
        writeSettings([], true);
        providerUsage = { anthropic: { status: "unknown", windows: [] } };
        const pi = makeFakePi();
        const ctx = makeFakeContext();

        fallbackModelsExtension(pi);
        pi._handlers.session_start({}, ctx);
        pi._handlers.input({ text: "do work" }, ctx);
        const result = await pi._handlers.turn_end(
            { message: { role: "assistant", stopReason: "error", errorMessage: "Rate limit reached" } },
            ctx,
        );

        expect(result).toBeUndefined();
        expect(pi._userMessages).toHaveLength(0);
        expect(pi._sent.at(-1)?.content).toContain("provider_status");
    });

    test("cancels pending wait on new input before continuation", async () => {
        writeSettings([], true);
        let resolveRefresh: (() => void) | undefined;
        refreshAllUsageMock.mockImplementationOnce(async () => {
            await new Promise<void>((resolve) => { resolveRefresh = resolve; });
            stampProviderUsage();
        });
        providerUsage = {
            anthropic: { status: "ok", windows: [{ label: "5-hour", utilization: 100, resets_at: new Date(Date.now() + 1000).toISOString() }] },
        };
        const pi = makeFakePi();
        const ctx = makeFakeContext();

        fallbackModelsExtension(pi);
        pi._handlers.session_start({}, ctx);
        pi._handlers.input({ text: "do work" }, ctx);
        const wait = pi._handlers.turn_end(
            { message: { role: "assistant", stopReason: "error", errorMessage: "Rate limit reached" } },
            ctx,
        );
        await Promise.resolve();
        pi._handlers.input({ text: "new work" }, ctx);
        resolveRefresh?.();

        expect(await wait).toBeUndefined();
        expect(pi._userMessages).toHaveLength(0);
    });

    test("stops after 3 automatic recovery attempts for one input", async () => {
        writeSettings([], true);
        const pi = makeFakePi();
        const ctx = makeFakeContext();

        fallbackModelsExtension(pi);
        pi._handlers.session_start({}, ctx);
        pi._handlers.input({ text: "do work" }, ctx);

        for (let i = 0; i < 3; i++) {
            providerUsage = {
                anthropic: { status: "ok", windows: [{ label: "5-hour", utilization: 100, resets_at: new Date(Date.now() + 1).toISOString() }] },
            };
            const wait = pi._handlers.turn_end(
                { message: { role: "assistant", stopReason: "error", errorMessage: "Rate limit reached" } },
                ctx,
            );
            await new Promise((resolve) => setTimeout(resolve, 2));
            providerUsage = {
                anthropic: { status: "ok", windows: [{ label: "5-hour", utilization: 50, resets_at: new Date(Date.now() + 1000).toISOString() }] },
            };
            await wait;
        }

        await pi._handlers.turn_end(
            { message: { role: "assistant", stopReason: "error", errorMessage: "Rate limit reached" } },
            ctx,
        );

        expect(pi._sent.at(-1)?.content).toContain("stopped after 3 recovery attempts");
    });

    test("/rate-limit-wait on only arms an existing failed task", async () => {
        writeSettings([], false);
        providerUsage = {
            anthropic: { status: "ok", windows: [{ label: "5-hour", utilization: 100, resets_at: new Date(Date.now() + 1000).toISOString() }] },
        };
        const pi = makeFakePi();
        const ctx = makeFakeContext();

        fallbackModelsExtension(pi);
        pi._handlers.session_start({}, ctx);
        await pi._commands.get("rate-limit-wait").handler("on", ctx);

        expect(refreshAllUsageMock).not.toHaveBeenCalled();
        expect(pi._userMessages).toHaveLength(0);
    });

    test("/rate-limit-wait cancel aborts a pending wait", async () => {
        writeSettings([], true);
        let resolveRefresh: (() => void) | undefined;
        refreshAllUsageMock.mockImplementationOnce(async () => {
            await new Promise<void>((resolve) => { resolveRefresh = resolve; });
            stampProviderUsage();
        });
        providerUsage = {
            anthropic: { status: "ok", windows: [{ label: "5-hour", utilization: 100, resets_at: new Date(Date.now() + 1000).toISOString() }] },
        };
        const pi = makeFakePi();
        const ctx = makeFakeContext();

        fallbackModelsExtension(pi);
        pi._handlers.session_start({}, ctx);
        const wait = pi._handlers.turn_end(
            { message: { role: "assistant", stopReason: "error", errorMessage: "Rate limit reached" } },
            ctx,
        );
        await Promise.resolve();
        await pi._commands.get("rate-limit-wait").handler("cancel", ctx);
        resolveRefresh?.();
        await expect(wait).resolves.toBeUndefined();
        expect(pi._sent.at(-1)?.content).toContain("cancelled");
    });

    test("resets the tried set after a successful turn so the chain can continue", async () => {
        writeSettings(["openai-codex:gpt-5.5", "ollama-cloud:glm-5.2"]);
        const pi = makeFakePi();
        const ctx = makeFakeContext();
        ctx.modelRegistry._register("openai-codex", "gpt-5.5");
        ctx.modelRegistry._register("ollama-cloud", "glm-5.2");

        fallbackModelsExtension(pi);
        pi._handlers.session_start({}, ctx);
        pi._handlers.input({ text: "hello" }, ctx);

        await pi._handlers.turn_end(
            {
                message: {
                    role: "assistant",
                    stopReason: "error",
                    errorMessage: "Rate limit reached",
                },
            },
            ctx,
        );

        // Primary rate-limits → switch to openai-codex.
        ctx.model = { provider: "openai-codex", id: "gpt-5.5" };
        await pi._handlers.turn_end(
            { message: { role: "assistant", stopReason: "stop" } },
            ctx,
        );

        // New user prompt, then the active fallback rate-limits again. Because
        // the tried set was reset, the extension can still advance to the next
        // fallback in the chain.
        pi._handlers.input({ text: "again" }, ctx);
        await pi._handlers.turn_end(
            {
                message: {
                    role: "assistant",
                    stopReason: "error",
                    errorMessage: "Rate limit reached",
                },
            },
            ctx,
        );

        expect(pi._setModelCalls).toHaveLength(2);
        expect(pi._setModelCalls[1]).toEqual({ provider: "ollama-cloud", id: "glm-5.2", hasAuth: true });
    });
});
