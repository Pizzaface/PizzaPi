import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import * as actualRemote from "./remote.js";
import {
    _resetWorkerStartupGateForTesting,
    armWorkerStartupGate,
    markWorkerStartupComplete,
} from "./worker-startup-gate.js";

function sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("initialPromptExtension", () => {
    const envKeys = [
        "PIZZAPI_WORKER_INITIAL_PROMPT",
        "PIZZAPI_WORKER_INITIAL_IMAGE_URLS",
        "PIZZAPI_WORKER_INITIAL_MODEL_PROVIDER",
        "PIZZAPI_WORKER_INITIAL_MODEL_ID",
        "PIZZAPI_WORKER_AGENT_NAME",
        "PIZZAPI_WORKER_AGENT_TOOLS",
        "PIZZAPI_WORKER_AGENT_HAS_TOOL_ALLOWLIST",
        "PIZZAPI_WORKER_AGENT_DISALLOWED_TOOLS",
        "PIZZAPI_WORKER_AGENT_MAX_TURNS",
    ] as const;

    beforeEach(() => {
        _resetWorkerStartupGateForTesting();
    });

    afterEach(() => {
        for (const key of envKeys) delete process.env[key];
        _resetWorkerStartupGateForTesting();
        mock.restore();
    });

    test("registers and applies the initial model even when no prompt or agent is set", async () => {
        mock.module("./remote.js", () => ({
            ...actualRemote,
            waitForRelayRegistration: mock(async (_timeoutMs?: number) => {}),
        }));

        const { initialPromptExtension } = await import("./initial-prompt.js");

        process.env.PIZZAPI_WORKER_INITIAL_MODEL_PROVIDER = "anthropic";
        process.env.PIZZAPI_WORKER_INITIAL_MODEL_ID = "claude-sonnet-4-20250514";

        let sessionStartHandler:
            | ((event: unknown, ctx: { modelRegistry: { find: (provider: string, id: string) => unknown } }) => Promise<void>)
            | undefined;

        const setModel = mock(async (_model: unknown) => true);
        const pi = {
            on: mock((event: string, handler: typeof sessionStartHandler) => {
                if (event === "session_start") sessionStartHandler = handler;
            }),
            setModel,
            setSessionName: mock((_name: string) => {}),
        };

        initialPromptExtension(pi as any);

        expect(pi.on).toHaveBeenCalledTimes(1);
        expect(sessionStartHandler).toBeDefined();
        expect(process.env.PIZZAPI_WORKER_INITIAL_MODEL_PROVIDER).toBeUndefined();
        expect(process.env.PIZZAPI_WORKER_INITIAL_MODEL_ID).toBeUndefined();

        const model = { provider: "anthropic", id: "claude-sonnet-4-20250514" };
        const find = mock((_provider: string, _id: string) => model);

        await sessionStartHandler!(undefined, {
            modelRegistry: { find },
        });

        expect(find).toHaveBeenCalledWith("anthropic", "claude-sonnet-4-20250514");
        expect(setModel).toHaveBeenCalledWith(model);
    });

    test("aborts the spawned agent after its configured maximum turns", async () => {
        const { initialPromptExtension } = await import("./initial-prompt.js");
        process.env.PIZZAPI_WORKER_AGENT_NAME = "limited";
        process.env.PIZZAPI_WORKER_AGENT_MAX_TURNS = "2";

        let messageEndHandler: ((event: unknown, ctx: { abort: () => void }) => void) | undefined;
        const pi = {
            on: mock((event: string, handler: typeof messageEndHandler) => {
                if (event === "message_end") messageEndHandler = handler;
            }),
        };
        initialPromptExtension(pi as any);
        const abort = mock(() => {});
        messageEndHandler!({ message: { role: "assistant" } }, { abort });
        expect(abort).not.toHaveBeenCalled();
        messageEndHandler!({ message: { role: "assistant" } }, { abort });
        expect(abort).toHaveBeenCalledTimes(1);
    });

    test("honors an empty tool allowlist instead of retaining active tools", async () => {
        const { initialPromptExtension } = await import("./initial-prompt.js");
        process.env.PIZZAPI_WORKER_AGENT_NAME = "restricted";
        process.env.PIZZAPI_WORKER_AGENT_HAS_TOOL_ALLOWLIST = "true";

        let sessionStartHandler: ((event: unknown, ctx: unknown) => Promise<void>) | undefined;
        const setActiveTools = mock(() => {});
        const pi = {
            on: mock((event: string, handler: typeof sessionStartHandler) => {
                if (event === "session_start") sessionStartHandler = handler;
            }),
            setSessionName: mock(() => {}),
            getAllTools: () => [{ name: "bash" }],
            setActiveTools,
        };
        initialPromptExtension(pi as any);
        await sessionStartHandler!(undefined, {});
        expect(setActiveTools).toHaveBeenCalledWith([]);
    });

    test("delays sendUserMessage until worker startup gate releases", async () => {
        // Regression for fix/mcp-startup-session-limbo: the initial prompt
        // must not race ahead of MCP startup, otherwise the first turn begins
        // streaming without MCP tools and buffered user input hits a streaming
        // agent with no deliverAs and is dropped silently.
        mock.module("./remote.js", () => ({
            ...actualRemote,
            waitForRelayRegistration: mock(async (_timeoutMs?: number) => {}),
        }));

        const { initialPromptExtension } = await import("./initial-prompt.js");

        process.env.PIZZAPI_WORKER_INITIAL_PROMPT = "do the thing";

        let sessionStartHandler:
            | ((event: unknown, ctx: unknown) => Promise<void>)
            | undefined;
        const sendUserMessage = mock((_text: string) => {});
        const pi = {
            on: mock((event: string, handler: typeof sessionStartHandler) => {
                if (event === "session_start") sessionStartHandler = handler;
            }),
            sendUserMessage,
            setSessionName: mock((_name: string) => {}),
        };

        armWorkerStartupGate();

        initialPromptExtension(pi as any);
        expect(sessionStartHandler).toBeDefined();

        // Fire session_start. The relay promise resolves immediately (mocked),
        // but the worker gate is still armed — sendUserMessage must not fire.
        await sessionStartHandler!(undefined, {});

        await sleep(30);
        expect(sendUserMessage).not.toHaveBeenCalled();

        // Release the gate — now the prompt should be dispatched.
        markWorkerStartupComplete();
        await sleep(30);

        expect(sendUserMessage).toHaveBeenCalledTimes(1);
        expect(sendUserMessage.mock.calls[0]![0]).toBe("do the thing");
    });

    test("attaches initial image URLs as content parts alongside the prompt", async () => {
        mock.module("./remote.js", () => ({
            ...actualRemote,
            waitForRelayRegistration: mock(async (_timeoutMs?: number) => {}),
        }));
        mock.module("./remote/connection.js", () => ({
            fetchImagePart: mock(async (url: string) => ({ type: "image", mimeType: "image/png", data: `b64:${url}` })),
        }));

        const { initialPromptExtension } = await import("./initial-prompt.js");

        process.env.PIZZAPI_WORKER_INITIAL_PROMPT = "look at this";
        process.env.PIZZAPI_WORKER_INITIAL_IMAGE_URLS = JSON.stringify(["https://cdn.discordapp.com/a.png"]);

        let sessionStartHandler: ((event: unknown, ctx: unknown) => Promise<void>) | undefined;
        const sendUserMessage = mock((_content: unknown) => {});
        const pi = {
            on: mock((event: string, handler: typeof sessionStartHandler) => {
                if (event === "session_start") sessionStartHandler = handler;
            }),
            sendUserMessage,
            setSessionName: mock((_name: string) => {}),
        };

        initialPromptExtension(pi as any);
        await sessionStartHandler!(undefined, {});
        await sleep(30);

        expect(sendUserMessage).toHaveBeenCalledTimes(1);
        expect(sendUserMessage.mock.calls[0]![0]).toEqual([
            { type: "text", text: "look at this" },
            { type: "image", mimeType: "image/png", data: "b64:https://cdn.discordapp.com/a.png" },
        ]);
    });
});
