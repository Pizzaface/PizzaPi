import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as realOs from "node:os";

mock.module("node:os", () => ({
    ...realOs,
    homedir: () => process.env.HOME ?? realOs.homedir(),
}));

const { fallbackModelsExtension } = await import("./fallback-models.js");

function makeFakePi() {
    const handlers: Record<string, Function> = {};
    const sentMessages: any[] = [];
    const sentUserMessages: any[] = [];
    const setModelCalls: any[] = [];

    const pi: any = {
        on: mock((event: string, handler: Function) => {
            handlers[event] = handler;
        }),
        sendMessage: mock((msg: any) => sentMessages.push(msg)),
        sendUserMessage: mock((...args: any[]) => sentUserMessages.push(args)),
        setModel: mock(async (model: any) => {
            setModelCalls.push(model);
            return true;
        }),
        _handlers: handlers,
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

    function writeSettings(fallbackModels: unknown) {
        writeFileSync(
            join(tmpHome, ".pizzapi", "settings.json"),
            JSON.stringify({ fallbackModels }),
        );
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
