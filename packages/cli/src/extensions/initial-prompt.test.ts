import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import * as actualRemote from "./remote.js";
import {
    _resetWorkerStartupGateForTesting,
    armWorkerStartupGate,
    markWorkerStartupComplete,
} from "./worker-startup-gate.js";
import { setRemoteSessionHost } from "./remote/session-host-ref.js";

function sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("initialPromptExtension", () => {
    const envKeys = [
        "PIZZAPI_WORKER_INITIAL_PROMPT",
        "PIZZAPI_WORKER_INITIAL_IMAGE_URLS",
        "PIZZAPI_WORKER_INITIAL_MODEL_PROVIDER",
        "PIZZAPI_WORKER_INITIAL_MODEL_ID",
        "PIZZAPI_WORKER_INITIAL_EFFORT",
        "PIZZAPI_WORKER_AGENT_NAME",
        "PIZZAPI_WORKER_AGENT_TOOLS",
        "PIZZAPI_WORKER_AGENT_DISALLOWED_TOOLS",
        "PIZZAPI_WORKER_RESUME_PATH",
        "PIZZAPI_WAKE_RESUME",
    ] as const;

    beforeEach(() => {
        _resetWorkerStartupGateForTesting();
    });

    afterEach(() => {
        for (const key of envKeys) delete process.env[key];
        _resetWorkerStartupGateForTesting();
        // Real module (not mock.module'd — that leaks across test files in
        // the same bun test process, see session-host-wiring.test.ts), so it
        // must be reset by hand between tests.
        setRemoteSessionHost(null);
        mock.restore();
    });

    test("registers and applies the initial model and effort even when no prompt or agent is set", async () => {
        mock.module("./remote.js", () => ({
            ...actualRemote,
            waitForRelayRegistration: mock(async (_timeoutMs?: number) => {}),
        }));

        const { initialPromptExtension } = await import("./initial-prompt.js");

        process.env.PIZZAPI_WORKER_INITIAL_MODEL_PROVIDER = "anthropic";
        process.env.PIZZAPI_WORKER_INITIAL_MODEL_ID = "claude-sonnet-4-20250514";
        process.env.PIZZAPI_WORKER_INITIAL_EFFORT = "high";

        let sessionStartHandler:
            | ((event: unknown, ctx: { modelRegistry: { find: (provider: string, id: string) => unknown } }) => Promise<void>)
            | undefined;

        const setModel = mock(async (_model: unknown) => true);
        const setThinkingLevel = mock((_level: string) => {});
        const pi = {
            on: mock((event: string, handler: typeof sessionStartHandler) => {
                if (event === "session_start") sessionStartHandler = handler;
            }),
            setModel,
            setThinkingLevel,
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
        expect(setThinkingLevel).toHaveBeenCalledWith("high");
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

    // PR #994 P1 (live-test finding): a suspend-wake respawn's boot-time
    // resume must tag its switchSession call with reason "wake" so the remote
    // extension's session_switch handler skips delink_own_parent/
    // delink_children — the SAME conversation is continuing, not a new
    // generation. Only PIZZAPI_WAKE_RESUME=1 (set by the daemon only for a
    // wake respawn, see runner/session-spawner.ts) triggers this; a normal
    // boot-time resume (e.g. a UI-initiated resume into a fresh worker) must
    // keep calling switchSession with no reason override, which defaults to
    // "resume" and runs transition cleanup normally.
    describe("wake-resume boot tagging (PR #994 P1)", () => {
        test("PIZZAPI_WAKE_RESUME=1 calls switchSession with reason: wake, and clears the env var", async () => {
            mock.module("./remote.js", () => ({
                ...actualRemote,
                waitForRelayRegistration: mock(async (_timeoutMs?: number) => {}),
            }));
            const switchSession = mock(async (_path: string, _options?: { reason?: string }) => ({ cancelled: false }));
            // Real session-host-ref module, real getRemoteSessionHost() — only
            // the SessionHost instance it returns is a stub.
            setRemoteSessionHost({ switchSession } as any);

            const { initialPromptExtension } = await import("./initial-prompt.js");

            process.env.PIZZAPI_WORKER_RESUME_PATH = "/tmp/sessions/child-e26a.jsonl";
            process.env.PIZZAPI_WAKE_RESUME = "1";

            let sessionStartHandler: ((event: unknown, ctx: unknown) => Promise<void>) | undefined;
            const pi = {
                on: mock((event: string, handler: typeof sessionStartHandler) => {
                    if (event === "session_start") sessionStartHandler = handler;
                }),
                setSessionName: mock((_name: string) => {}),
            };

            initialPromptExtension(pi as any);
            // Cleared synchronously at registration time, like the other
            // one-shot worker env vars, so a restart-in-place respawn (a brand
            // new child process anyway) can never re-trigger it.
            expect(process.env.PIZZAPI_WAKE_RESUME).toBeUndefined();
            expect(process.env.PIZZAPI_WORKER_RESUME_PATH).toBeUndefined();

            await sessionStartHandler!(undefined, {});

            expect(switchSession).toHaveBeenCalledWith("/tmp/sessions/child-e26a.jsonl", { reason: "wake" });
        });

        test("a normal resume boot (no PIZZAPI_WAKE_RESUME) calls switchSession with no reason override", async () => {
            mock.module("./remote.js", () => ({
                ...actualRemote,
                waitForRelayRegistration: mock(async (_timeoutMs?: number) => {}),
            }));
            const switchSession = mock(async (_path: string, _options?: { reason?: string }) => ({ cancelled: false }));
            setRemoteSessionHost({ switchSession } as any);

            const { initialPromptExtension } = await import("./initial-prompt.js");

            process.env.PIZZAPI_WORKER_RESUME_PATH = "/tmp/sessions/some-session.jsonl";
            // PIZZAPI_WAKE_RESUME intentionally left unset.

            let sessionStartHandler: ((event: unknown, ctx: unknown) => Promise<void>) | undefined;
            const pi = {
                on: mock((event: string, handler: typeof sessionStartHandler) => {
                    if (event === "session_start") sessionStartHandler = handler;
                }),
                setSessionName: mock((_name: string) => {}),
            };

            initialPromptExtension(pi as any);
            await sessionStartHandler!(undefined, {});

            expect(switchSession).toHaveBeenCalledWith("/tmp/sessions/some-session.jsonl", undefined);
        });
    });
});
