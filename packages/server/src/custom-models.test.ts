import { describe, test, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import {
    loadCustomModels,
    getAllModels,
    type CustomModelEntry,
} from "./custom-models.js";

describe("loadCustomModels", () => {
    let dir: string;

    beforeAll(() => {
        dir = mkdtempSync(join(tmpdir(), "pizzapi-custom-models-"));
    });

    afterAll(() => {
        try { rmSync(dir, { recursive: true, force: true }); } catch {}
    });

    test("returns empty array when file does not exist", () => {
        const models = loadCustomModels(join(dir, "nonexistent.json"));
        expect(models).toEqual([]);
    });

    test("parses valid custom models file", () => {
        const modelsPath = join(dir, "models.json");
        writeFileSync(modelsPath, JSON.stringify({
            models: [
                { provider: "openai", id: "gpt-5.4", name: "GPT-5.4" },
                { provider: "anthropic", id: "claude-new", name: "Claude New" },
            ],
        }));

        const models = loadCustomModels(modelsPath);
        expect(models).toHaveLength(2);
        expect(models[0]).toEqual({ provider: "openai", id: "gpt-5.4", name: "GPT-5.4" });
        expect(models[1]).toEqual({ provider: "anthropic", id: "claude-new", name: "Claude New" });
    });

    test("returns empty array for malformed JSON", () => {
        const modelsPath = join(dir, "bad.json");
        writeFileSync(modelsPath, "not valid {{{");

        const models = loadCustomModels(modelsPath);
        expect(models).toEqual([]);
    });

    test("returns empty array when models field is missing", () => {
        const modelsPath = join(dir, "empty.json");
        writeFileSync(modelsPath, JSON.stringify({ providers: {} }));

        const models = loadCustomModels(modelsPath);
        expect(models).toEqual([]);
    });

    test("skips entries missing required fields", () => {
        const modelsPath = join(dir, "partial.json");
        writeFileSync(modelsPath, JSON.stringify({
            models: [
                { provider: "openai", id: "gpt-5.4", name: "GPT-5.4" },
                { provider: "openai" },
                { id: "missing-provider", name: "No Provider" },
                { provider: "openai", id: "no-name" },
            ],
        }));

        const models = loadCustomModels(modelsPath);
        expect(models).toHaveLength(1);
        expect(models[0].id).toBe("gpt-5.4");
    });
});

describe("getAllModels", () => {
    let dir: string;

    beforeAll(() => {
        dir = mkdtempSync(join(tmpdir(), "pizzapi-all-models-"));
    });

    afterAll(() => {
        try { rmSync(dir, { recursive: true, force: true }); } catch {}
    });

    test("includes built-in models", () => {
        const models = getAllModels(join(dir, "nonexistent.json"));
        expect(models.length).toBeGreaterThan(0);
        // Should have at least some OpenAI models from pi-ai
        const hasOpenAI = models.some((m) => m.provider === "openai");
        expect(hasOpenAI).toBe(true);
    });

    test("merges custom models with built-in models", () => {
        const modelsPath = join(dir, "custom.json");
        writeFileSync(modelsPath, JSON.stringify({
            models: [
                { provider: "openai", id: "gpt-99", name: "GPT-99 Future" },
            ],
        }));

        const models = getAllModels(modelsPath);
        const custom = models.find((m) => m.id === "gpt-99");
        expect(custom).toBeDefined();
        expect(custom!.name).toBe("GPT-99 Future");
    });

    test("custom models do not duplicate built-in models", () => {
        const modelsPath = join(dir, "dupe.json");
        writeFileSync(modelsPath, JSON.stringify({
            models: [
                { provider: "openai", id: "gpt-4", name: "Custom GPT-4 Name" },
            ],
        }));

        const models = getAllModels(modelsPath);
        const gpt4s = models.filter((m) => m.provider === "openai" && m.id === "gpt-4");
        expect(gpt4s).toHaveLength(1);
        // Built-in should win — custom doesn't override existing
        expect(gpt4s[0].name).not.toBe("Custom GPT-4 Name");
    });
});
