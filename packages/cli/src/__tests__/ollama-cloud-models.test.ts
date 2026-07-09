import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    fetchOllamaCloudModels,
    extractContextLength,
    capabilitiesInclude,
    getCachedOllamaCloudModels,
    findCachedOllamaCloudModel,
} from "../ollama-cloud-models.js";

const originalHome = process.env.HOME;

describe("ollama-cloud dynamic model discovery", () => {
    let tempHome: string;

    beforeEach(() => {
        tempHome = mkdtempSync(join(tmpdir(), "ollama-cloud-models-test-"));
        process.env.HOME = tempHome;
    });

    afterEach(() => {
        process.env.HOME = originalHome;
        try {
            rmSync(tempHome, { recursive: true, force: true });
        } catch {
            // ignore
        }
    });

    test("extractContextLength returns first context_length key", () => {
        expect(extractContextLength({ "glm5.1.context_length": 202752 })).toBe(202752);
        expect(extractContextLength({ context_length: 131072 })).toBe(131072);
        expect(extractContextLength({ foo: "bar" })).toBeUndefined();
    });

    test("capabilitiesInclude is case-insensitive", () => {
        expect(capabilitiesInclude(["Thinking", "completion"], "thinking")).toBe(true);
        expect(capabilitiesInclude(["completion"], "thinking")).toBe(false);
    });

    test("invalid cached models are ignored", () => {
        const dir = join(tempHome, ".pizzapi");
        mkdirSync(dir, { recursive: true });
        writeFileSync(
            join(dir, "ollama-cloud-models-cache.json"),
            JSON.stringify({ models: [{ id: "broken" }], fetchedAt: Date.now() }),
        );

        expect(getCachedOllamaCloudModels()).toBeNull();
    });

    test("fetchOllamaCloudModels returns cached data when cache is fresh", async () => {
        const expected: import("../ollama-cloud-models.js").OllamaCloudModel[] = [
            {
                id: "cached-model",
                name: "cached-model",
                provider: "ollama-cloud",
                api: "openai-completions",
                baseUrl: "https://ollama.com/v1",
                reasoning: true,
                input: ["text"],
                contextWindow: 1234,
                maxTokens: 32768,
            },
        ];

        const dir = join(tempHome, ".pizzapi");
        mkdirSync(dir, { recursive: true });
        writeFileSync(
            join(dir, "ollama-cloud-models-cache.json"),
            JSON.stringify({ models: expected, fetchedAt: Date.now() }),
        );

        const result = await fetchOllamaCloudModels();
        expect(result).toEqual(expected);
    });

    test("findCachedOllamaCloudModel resolves a cached id, ignores other providers", () => {
        const dir = join(tempHome, ".pizzapi");
        mkdirSync(dir, { recursive: true });
        writeFileSync(
            join(dir, "ollama-cloud-models-cache.json"),
            JSON.stringify({
                models: [
                    {
                        id: "glm-5.2",
                        name: "glm-5.2",
                        provider: "ollama-cloud",
                        api: "openai-completions",
                        baseUrl: "https://ollama.com/v1",
                        reasoning: true,
                        input: ["text"],
                        contextWindow: 1000000,
                        maxTokens: 32768,
                    },
                ],
                fetchedAt: Date.now(),
            }),
        );

        const model = findCachedOllamaCloudModel("ollama-cloud", "glm-5.2");
        expect(model?.id).toBe("glm-5.2");
        expect(model?.api).toBe("openai-completions");
        expect(findCachedOllamaCloudModel("ollama-cloud", "nope")).toBeUndefined();
        expect(findCachedOllamaCloudModel("anthropic", "glm-5.2")).toBeUndefined();
    });

    test("force refetches even when cache is fresh", async () => {
        const dir = join(tempHome, ".pizzapi");
        mkdirSync(dir, { recursive: true });
        writeFileSync(
            join(dir, "ollama-cloud-models-cache.json"),
            JSON.stringify({
                models: [
                    {
                        id: "stale-model",
                        name: "stale-model",
                        provider: "ollama-cloud",
                        api: "openai-completions",
                        baseUrl: "https://ollama.com/v1",
                        reasoning: false,
                        input: ["text"],
                        contextWindow: 1234,
                        maxTokens: 32768,
                    },
                ],
                fetchedAt: Date.now(),
            }),
        );

        let calls = 0;
        const originalFetch = globalThis.fetch;
        globalThis.fetch = (async (url: string | URL) => {
            calls++;
            const u = String(url);
            if (u.includes("/v1/models")) {
                return new Response(JSON.stringify({ data: [{ id: "new-model" }] }), { status: 200 });
            }
            return new Response(
                JSON.stringify({ capabilities: ["thinking"], model_info: { "new.context_length": 4096 } }),
                { status: 200 },
            );
        }) as typeof globalThis.fetch;

        try {
            const result = await fetchOllamaCloudModels({ force: true });
            expect(calls).toBeGreaterThan(0);
            expect(result.some((m) => m.id === "new-model")).toBe(true);
            expect(result.some((m) => m.id === "stale-model")).toBe(false);
        } finally {
            globalThis.fetch = originalFetch;
        }
    });
});
