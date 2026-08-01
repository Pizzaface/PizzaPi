import { afterEach, describe, expect, test } from "bun:test";
import { getHiddenModelKeys, isModelHidden, setHiddenModelKeys } from "./hidden-models.js";

const previous = process.env.PIZZAPI_HIDDEN_MODELS;

afterEach(() => {
    if (previous === undefined) delete process.env.PIZZAPI_HIDDEN_MODELS;
    else process.env.PIZZAPI_HIDDEN_MODELS = previous;
});

describe("hidden-models env helpers", () => {
    test("empty/missing env yields empty set", () => {
        delete process.env.PIZZAPI_HIDDEN_MODELS;
        expect(getHiddenModelKeys().size).toBe(0);
        expect(isModelHidden("anthropic", "claude-3-5-haiku")).toBe(false);
    });

    test("corrupt env yields empty set", () => {
        process.env.PIZZAPI_HIDDEN_MODELS = "not json";
        expect(getHiddenModelKeys().size).toBe(0);
    });

    test("isModelHidden matches provider/id keys, including ids with slashes", () => {
        process.env.PIZZAPI_HIDDEN_MODELS = JSON.stringify([
            "anthropic/claude-3-5-haiku",
            "openrouter/vendor/model",
        ]);
        expect(isModelHidden("anthropic", "claude-3-5-haiku")).toBe(true);
        expect(isModelHidden("openrouter", "vendor/model")).toBe(true);
        expect(isModelHidden("anthropic", "claude-sonnet-4")).toBe(false);
    });

    test("setHiddenModelKeys updates the env for subsequent reads", () => {
        setHiddenModelKeys(["ollama-cloud/glm-5.2"]);
        expect(isModelHidden("ollama-cloud", "glm-5.2")).toBe(true);
        setHiddenModelKeys([]);
        expect(isModelHidden("ollama-cloud", "glm-5.2")).toBe(false);
        // Non-array input clears the list instead of throwing
        setHiddenModelKeys("garbage" as unknown);
        expect(getHiddenModelKeys().size).toBe(0);
    });
});
