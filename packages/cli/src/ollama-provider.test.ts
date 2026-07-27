import { describe, test, expect } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OLLAMA_CLOUD_FALLBACK_MODELS } from "./ollama-cloud-fallback-models.js";
import { toOllamaCloudRuntimeModel } from "./ollama-cloud-models.js";
import { ollamaCloudProviderExtension } from "./extensions/ollama-cloud-provider.js";

/**
 * Ollama Cloud used to be a built-in pi-ai provider via a patch hunk
 * (ollamaCloudProvider() in providers/all.js, an inlined OLLAMA_CLOUD_MODELS
 * catalog in models.generated.js, and an env-api-keys.js OLLAMA_API_KEY
 * mapping). All of that now lives in ollamaCloudProviderExtension, which
 * calls pi.registerProvider("ollama-cloud", { ... }) with the same static
 * fallback catalog. See patches/README.md and patches.test.ts for the
 * negative assertions proving the pi-ai patch no longer carries this.
 */

function makeMockPi() {
    const registered: Array<{ name: string; config: any }> = [];
    const pi = {
        registerProvider(name: string, config: any) {
            registered.push({ name, config });
        },
    } as unknown as ExtensionAPI;
    return { pi, registered };
}

describe("ollamaCloudProviderExtension", () => {
    test("registers the ollama-cloud provider with $OLLAMA_API_KEY auth and the openai-completions API", async () => {
        const { pi, registered } = makeMockPi();
        await ollamaCloudProviderExtension(pi);

        expect(registered).toHaveLength(1);
        const { name, config } = registered[0];
        expect(name).toBe("ollama-cloud");
        expect(config.name).toBe("Ollama Cloud");
        expect(config.baseUrl).toBe("https://ollama.com/v1");
        expect(config.apiKey).toBe("$OLLAMA_API_KEY");
        expect(config.api).toBe("openai-completions");
    });

    test("registers a non-empty fallback model catalog with expected models", async () => {
        const { pi, registered } = makeMockPi();
        await ollamaCloudProviderExtension(pi);
        const models = registered[0].config.models as Array<any>;

        expect(models.length).toBeGreaterThan(0);
        for (const id of ["glm-5.1", "gpt-oss:20b", "kimi-k2.6", "kimi-k2.7-code", "minimax-m3", "nemotron-3-ultra", "deepseek-v4-pro"]) {
            expect(models.some((m) => m.id === id)).toBe(true);
        }
    });

    test("fallback models carry the openai-completions compat flags and cloud base URL", async () => {
        const { pi, registered } = makeMockPi();
        await ollamaCloudProviderExtension(pi);
        const models = registered[0].config.models as Array<any>;

        const glm = models.find((m) => m.id === "glm-5.1");
        expect(glm).toBeDefined();
        expect(glm?.provider).toBe("ollama-cloud");
        expect(glm?.baseUrl).toBe("https://ollama.com/v1");
        expect(glm?.api).toBe("openai-completions");
        expect(glm?.compat).toMatchObject({
            supportsStore: false,
            supportsDeveloperRole: false,
            supportsReasoningEffort: false,
            supportsUsageInStreaming: true,
            supportsLongCacheRetention: false,
            supportsStrictMode: false,
            maxTokensField: "max_tokens",
        });
    });

    test("fallback models carry the scraped context windows", async () => {
        const { pi, registered } = makeMockPi();
        await ollamaCloudProviderExtension(pi);
        const contextById = new Map((registered[0].config.models as Array<any>).map((m) => [m.id, m.contextWindow]));

        expect(contextById.get("deepseek-v4-pro")).toBe(524288);
        expect(contextById.get("deepseek-v4-flash")).toBe(1048576);
        expect(contextById.get("nemotron-3-nano:30b")).toBe(262144);
        expect(contextById.get("nemotron-3-ultra")).toBe(262144);
        expect(contextById.get("rnj-1:8b")).toBe(32768);
        expect(contextById.get("ministral-3:8b")).toBe(262144);
        expect(contextById.get("minimax-m2.7")).toBe(196608);
        expect(contextById.get("minimax-m3")).toBe(524288);
        expect(contextById.get("gemma3:12b")).toBe(131072);
        expect(contextById.get("mistral-large-3:675b")).toBe(262144);
        expect(contextById.get("devstral-small-2:24b")).toBe(262144);
    });

    test("vision-capable models advertise image input, others don't", async () => {
        const { pi, registered } = makeMockPi();
        await ollamaCloudProviderExtension(pi);
        const models = registered[0].config.models as Array<any>;

        expect(models.find((m) => m.id === "gemma3:12b")?.input).toContain("image");
        expect(models.find((m) => m.id === "glm-5.1")?.input).not.toContain("image");
    });
});

describe("ollama-cloud provider registration end-to-end (ModelRuntime)", () => {
    test("registering via ModelRuntime.registerProvider makes fallback models available and resolves OLLAMA_API_KEY, while a custom local ollama provider stays separate", async () => {
        const { ModelRegistry, ModelRuntime } = await import("@earendil-works/pi-coding-agent");

        const dir = mkdtempSync(join(tmpdir(), "ollama-cloud-registry-"));
        const modelsPath = join(dir, "models.json");
        writeFileSync(
            modelsPath,
            JSON.stringify({
                providers: {
                    ollama: {
                        baseUrl: "http://localhost:11434/v1",
                        api: "openai-completions",
                        apiKey: "ollama",
                        models: [{ id: "llama3.1:8b" }],
                    },
                },
            }),
        );
        const authPath = join(dir, "auth.json");
        writeFileSync(authPath, "{}");

        const prev = process.env.OLLAMA_API_KEY;
        process.env.OLLAMA_API_KEY = "test-ollama-key";
        try {
            const runtime = await ModelRuntime.create({ authPath, modelsPath });
            const pi = {
                registerProvider: (name: string, config: any) => runtime.registerProvider(name, config),
            } as unknown as ExtensionAPI;
            await ollamaCloudProviderExtension(pi);

            const registry = new ModelRegistry(runtime);
            const available = registry.getAvailable();

            expect(available.some((m: any) => m.provider === "ollama-cloud" && m.id === "glm-5.1")).toBe(true);
            expect(available.some((m: any) => m.provider === "ollama" && m.id === "llama3.1:8b")).toBe(true);
            expect(registry.find("ollama", "llama3.1:8b")?.baseUrl).toBe("http://localhost:11434/v1");
            expect(runtime.hasConfiguredAuth("ollama-cloud")).toBe(true);
        } finally {
            if (prev === undefined) delete process.env.OLLAMA_API_KEY;
            else process.env.OLLAMA_API_KEY = prev;
        }
    });
});

describe("Ollama Cloud streaming (via pi-ai openai-completions API directly)", () => {
    function fallbackModel(id: string) {
        const model = OLLAMA_CLOUD_FALLBACK_MODELS.find((m) => m.id === id);
        if (!model) throw new Error(`no fallback model ${id}`);
        return toOllamaCloudRuntimeModel(model);
    }

    test("requests streaming usage for Ollama Cloud so tokens are counted", async () => {
        const { complete } = await import("@earendil-works/pi-ai/compat");
        const model = fallbackModel("glm-5.1");

        const prevFetch = globalThis.fetch;
        const prevKey = process.env.OLLAMA_API_KEY;
        process.env.OLLAMA_API_KEY = "test-ollama-key";
        let requestPayload: any;

        globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
            requestPayload = JSON.parse(String(init?.body));
            const body = [
                `data: ${JSON.stringify({
                    id: "chatcmpl-test",
                    object: "chat.completion.chunk",
                    choices: [{ index: 0, delta: { content: "hi" }, finish_reason: null }],
                })}`,
                `data: ${JSON.stringify({
                    id: "chatcmpl-test",
                    object: "chat.completion.chunk",
                    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
                    usage: { prompt_tokens: 123, completion_tokens: 45, total_tokens: 168 },
                })}`,
                "data: [DONE]",
                "",
            ].join("\n\n");
            return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
        }) as unknown as typeof fetch;

        try {
            const response = await complete(
                model,
                { messages: [{ role: "user", content: "hello", timestamp: Date.now() }] },
                { maxRetries: 0, apiKey: "test-ollama-key" },
            );

            expect(requestPayload.stream_options).toEqual({ include_usage: true });
            expect(response.usage.input).toBe(123);
            expect(response.usage.output).toBe(45);
            expect(response.usage.totalTokens).toBe(168);
        } finally {
            globalThis.fetch = prevFetch;
            if (prevKey === undefined) delete process.env.OLLAMA_API_KEY;
            else process.env.OLLAMA_API_KEY = prevKey;
        }
    });

    test("vision ollama-cloud models send image content as image_url", async () => {
        const { complete } = await import("@earendil-works/pi-ai/compat");
        const model = fallbackModel("gemma3:12b");
        expect(model.input).toContain("image");

        const prevFetch = globalThis.fetch;
        const prevKey = process.env.OLLAMA_API_KEY;
        process.env.OLLAMA_API_KEY = "test-ollama-key";
        let requestPayload: any;

        globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
            requestPayload = JSON.parse(String(init?.body));
            const body = [
                `data: ${JSON.stringify({
                    id: "chatcmpl-test",
                    object: "chat.completion.chunk",
                    choices: [{ index: 0, delta: { content: "hi" }, finish_reason: null }],
                })}`,
                `data: ${JSON.stringify({
                    id: "chatcmpl-test",
                    object: "chat.completion.chunk",
                    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
                    usage: { prompt_tokens: 123, completion_tokens: 45, total_tokens: 168 },
                })}`,
                "data: [DONE]",
                "",
            ].join("\n\n");
            return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
        }) as unknown as typeof fetch;

        try {
            await complete(
                model,
                {
                    messages: [
                        {
                            role: "user",
                            content: [
                                { type: "text", text: "describe this" },
                                { type: "image", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", mimeType: "image/png" },
                            ],
                            timestamp: Date.now(),
                        },
                    ],
                },
                { maxRetries: 0, apiKey: "test-ollama-key" },
            );

            expect(requestPayload.messages).toHaveLength(1);
            const content = requestPayload.messages[0].content;
            expect(content).toHaveLength(2);
            expect(content[0]).toEqual({ type: "text", text: "describe this" });
            expect(content[1].type).toBe("image_url");
            expect(content[1].image_url.url).toMatch(/^data:image\/png;base64,/);
        } finally {
            globalThis.fetch = prevFetch;
            if (prevKey === undefined) delete process.env.OLLAMA_API_KEY;
            else process.env.OLLAMA_API_KEY = prevKey;
        }
    });

    test("non-vision ollama-cloud models downgrade images to placeholder text", async () => {
        const { complete } = await import("@earendil-works/pi-ai/compat");
        const model = fallbackModel("glm-5.1");
        expect(model.input).not.toContain("image");

        const prevFetch = globalThis.fetch;
        const prevKey = process.env.OLLAMA_API_KEY;
        process.env.OLLAMA_API_KEY = "test-ollama-key";
        let requestPayload: any;

        globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
            requestPayload = JSON.parse(String(init?.body));
            const body = [
                `data: ${JSON.stringify({
                    id: "chatcmpl-test",
                    object: "chat.completion.chunk",
                    choices: [{ index: 0, delta: { content: "hi" }, finish_reason: null }],
                })}`,
                `data: ${JSON.stringify({
                    id: "chatcmpl-test",
                    object: "chat.completion.chunk",
                    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
                    usage: { prompt_tokens: 123, completion_tokens: 45, total_tokens: 168 },
                })}`,
                "data: [DONE]",
                "",
            ].join("\n\n");
            return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
        }) as unknown as typeof fetch;

        try {
            await complete(
                model,
                {
                    messages: [
                        {
                            role: "user",
                            content: [
                                { type: "text", text: "describe this" },
                                { type: "image", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", mimeType: "image/png" },
                            ],
                            timestamp: Date.now(),
                        },
                    ],
                },
                { maxRetries: 0, apiKey: "test-ollama-key" },
            );

            expect(requestPayload.messages).toHaveLength(1);
            const content = requestPayload.messages[0].content;
            expect(content).toHaveLength(2);
            expect(content[0]).toEqual({ type: "text", text: "describe this" });
            expect(content[1]).toEqual({ type: "text", text: "(image omitted: model does not support images)" });
        } finally {
            globalThis.fetch = prevFetch;
            if (prevKey === undefined) delete process.env.OLLAMA_API_KEY;
            else process.env.OLLAMA_API_KEY = prevKey;
        }
    });
});
