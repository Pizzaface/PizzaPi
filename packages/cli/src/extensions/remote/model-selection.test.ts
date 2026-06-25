import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setModelFromWeb } from "./model-selection.js";

async function withTempHome(fn: () => Promise<void> | void) {
    const previousHome = process.env.HOME;
    const tempHome = mkdtempSync(join(tmpdir(), "model-selection-test-"));
    process.env.HOME = tempHome;
    try {
        await fn();
    } finally {
        rmSync(tempHome, { recursive: true, force: true });
        if (previousHome === undefined) delete process.env.HOME;
        else process.env.HOME = previousHome;
    }
}

function ollamaCloudModel(modelId: string) {
    return {
        id: modelId,
        name: modelId,
        provider: "ollama-cloud",
        api: "openai-completions",
        baseUrl: "https://ollama.com/v1",
        reasoning: true,
        input: ["text"],
        contextWindow: 128000,
        maxTokens: 32768,
    };
}

function writeOllamaCloudCache(modelId: string, fetchedAt = Date.now()) {
    const dir = join(process.env.HOME!, ".pizzapi");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
        join(dir, "ollama-cloud-models-cache.json"),
        JSON.stringify({ fetchedAt, models: [ollamaCloudModel(modelId)] }),
    );
}

function createRctx(modelFromRegistry?: any) {
    const events: any[] = [];
    const rctx: any = {
        relaySessionId: "session-1",
        goalState: null,
        latestCtx: {
            cwd: process.cwd(),
            model: null,
            modelRegistry: {
                find: () => modelFromRegistry,
                authStorage: { get: () => ({ type: "api_key" }) },
            },
            sessionManager: {
                getEntries: () => [],
                getLeafId: () => null,
                getSessionName: () => null,
                getSessionFile: () => undefined,
            },
        },
        forwardEvent: (event: any) => events.push(event),
        getCurrentThinkingLevel: () => null,
        getCurrentSessionName: () => null,
        getConfiguredModels: () => [],
        getAvailableCommands: () => [],
    };
    return { rctx, events };
}

describe("setModelFromWeb", () => {
    test("returns without side effects when there is no session context", async () => {
        const events: any[] = [];
        const pi = { setModel: async () => true };

        await setModelFromWeb({ latestCtx: null, forwardEvent: (event: any) => events.push(event) } as any, pi, "x", "y");

        expect(events).toEqual([]);
    });

    test("uses the static registry model when present", async () => {
        const registryModel = ollamaCloudModel("glm-5.1");
        const { rctx, events } = createRctx(registryModel);
        let selected: any;
        const pi = {
            setModel: async (model: any) => {
                selected = model;
                return false;
            },
        };

        await setModelFromWeb(rctx, pi, "ollama-cloud", "glm-5.1");

        expect(selected).toBe(registryModel);
        expect(events).toContainEqual({
            type: "model_set_result",
            ok: false,
            provider: "ollama-cloud",
            modelId: "glm-5.1",
            message: "Model selected, but no valid credentials were found.",
        });
    });

    test("forwards registry lookup errors", async () => {
        const { rctx, events } = createRctx();
        rctx.latestCtx.modelRegistry.find = () => {
            throw new Error("registry broke");
        };
        const pi = { setModel: async () => true };

        await setModelFromWeb(rctx, pi, "ollama-cloud", "glm-5.2");

        expect(events).toContainEqual({
            type: "model_set_result",
            ok: false,
            provider: "ollama-cloud",
            modelId: "glm-5.2",
            message: "registry broke",
        });
    });

    test("can select cached Ollama Cloud models missing from the static registry", async () => {
        await withTempHome(async () => {
            writeOllamaCloudCache("glm-5.2");
            const { rctx, events } = createRctx();
            let selected: any;
            const pi = {
                setModel: async (model: any) => {
                    selected = model;
                    return false;
                },
            };

            await setModelFromWeb(rctx, pi, "ollama-cloud", "glm-5.2");

            expect(selected).toMatchObject({
                provider: "ollama-cloud",
                id: "glm-5.2",
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                compat: { supportsUsageInStreaming: true, maxTokensField: "max_tokens" },
            });
            expect(events).toContainEqual({
                type: "model_set_result",
                ok: false,
                provider: "ollama-cloud",
                modelId: "glm-5.2",
                message: "Model selected, but no valid credentials were found.",
            });
        });
    });

    test("ignores stale cached Ollama Cloud models", async () => {
        await withTempHome(async () => {
            writeOllamaCloudCache("glm-5.2", Date.now() - 25 * 60 * 60 * 1000);
            const { rctx, events } = createRctx();
            const pi = { setModel: async () => true };

            await setModelFromWeb(rctx, pi, "ollama-cloud", "glm-5.2");

            expect(events).toContainEqual({
                type: "model_set_result",
                ok: false,
                provider: "ollama-cloud",
                modelId: "glm-5.2",
                message: "Model is not configured for this session.",
            });
        });
    });

    test("emits model metadata after successful cached Ollama Cloud selection", async () => {
        await withTempHome(async () => {
            writeOllamaCloudCache("glm-5.2");
            const { rctx, events } = createRctx();
            const pi = {
                setModel: async (model: any) => {
                    rctx.latestCtx.model = model;
                    return true;
                },
            };

            await setModelFromWeb(rctx, pi, "ollama-cloud", "glm-5.2");

            expect(events).toContainEqual({ type: "model_set_result", ok: true, provider: "ollama-cloud", modelId: "glm-5.2" });
            expect(events).toContainEqual({
                type: "model_changed",
                model: { provider: "ollama-cloud", id: "glm-5.2", name: "glm-5.2", reasoning: true, contextWindow: 128000 },
            });
            expect(events.some((event) => event.type === "session_active")).toBe(true);
        });
    });

    test("forwards cached model setModel errors", async () => {
        await withTempHome(async () => {
            writeOllamaCloudCache("glm-5.2");
            const { rctx, events } = createRctx();
            const pi = {
                setModel: async () => {
                    throw "bare string error";
                },
            };

            await setModelFromWeb(rctx, pi, "ollama-cloud", "glm-5.2");

            expect(events).toContainEqual({
                type: "model_set_result",
                ok: false,
                provider: "ollama-cloud",
                modelId: "glm-5.2",
                message: "bare string error",
            });
        });
    });

    test("forwards setModel errors", async () => {
        const { rctx, events } = createRctx(ollamaCloudModel("glm-5.1"));
        const pi = {
            setModel: async () => {
                throw new Error("boom");
            },
        };

        await setModelFromWeb(rctx, pi, "ollama-cloud", "glm-5.1");

        expect(events).toContainEqual({
            type: "model_set_result",
            ok: false,
            provider: "ollama-cloud",
            modelId: "glm-5.1",
            message: "boom",
        });
    });
});
