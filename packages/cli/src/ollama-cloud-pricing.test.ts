import { describe, expect, test } from "bun:test";
import { ollamaCloudRates } from "./ollama-cloud-pricing.js";
import { toOllamaCloudRuntimeModel, type OllamaCloudModel } from "./ollama-cloud-models.js";

function model(id: string): OllamaCloudModel {
    return {
        id,
        name: id,
        provider: "ollama-cloud",
        api: "openai-completions",
        baseUrl: "https://ollama.com/v1",
        reasoning: true,
        input: ["text"],
        contextWindow: 1048576,
        maxTokens: 32768,
    };
}

describe("ollamaCloudRates", () => {
    test("exact id match", () => {
        expect(ollamaCloudRates("glm-5.3")).toEqual({ input: 1.4, output: 4.4, cacheRead: 0.26 });
    });

    test("falls back to the family for tagged ids", () => {
        expect(ollamaCloudRates("deepseek-v4-pro:0813")).toEqual(ollamaCloudRates("deepseek-v4-pro"));
    });

    test("prefers the exact id over the family prefix", () => {
        // glm-5.3-flash must not resolve to glm-5.3's much higher rates.
        expect(ollamaCloudRates("glm-5.3-flash").input).toBe(0.15);
    });

    test("unlisted models are free, not undefined", () => {
        expect(ollamaCloudRates("gemma4:31b")).toEqual({ input: 0, output: 0, cacheRead: 0 });
    });
});

describe("toOllamaCloudRuntimeModel", () => {
    test("carries published rates onto the runtime model", () => {
        expect(toOllamaCloudRuntimeModel(model("kimi-k2.7-code")).cost).toEqual({
            input: 0.95,
            output: 4.0,
            cacheRead: 0.19,
            cacheWrite: 0.95,
        });
    });
});
