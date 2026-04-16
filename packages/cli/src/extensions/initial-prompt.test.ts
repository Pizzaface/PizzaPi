import { afterEach, describe, expect, mock, test } from "bun:test";
import * as actualRemote from "./remote.js";

describe("initialPromptExtension", () => {
    const envKeys = [
        "PIZZAPI_WORKER_INITIAL_PROMPT",
        "PIZZAPI_WORKER_INITIAL_MODEL_PROVIDER",
        "PIZZAPI_WORKER_INITIAL_MODEL_ID",
        "PIZZAPI_WORKER_AGENT_NAME",
        "PIZZAPI_WORKER_AGENT_TOOLS",
        "PIZZAPI_WORKER_AGENT_DISALLOWED_TOOLS",
    ] as const;

    afterEach(() => {
        for (const key of envKeys) delete process.env[key];
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
});
