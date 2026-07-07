import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    mergeModelLists,
    readSessionModelsCache,
    resetSessionModelsCacheMemo,
    writeSessionModelsCache,
    type SessionModelEntry,
} from "./session-models-cache.js";

const model = (provider: string, id: string, extra: Partial<SessionModelEntry> = {}): SessionModelEntry => ({
    provider,
    id,
    name: id,
    reasoning: false,
    contextWindow: 100000,
    ...extra,
});

let tempHome: string;
let originalHome: string | undefined;

beforeEach(() => {
    originalHome = process.env.HOME;
    tempHome = mkdtempSync(join(tmpdir(), "pizzapi-models-cache-"));
    process.env.HOME = tempHome;
    resetSessionModelsCacheMemo();
});

afterEach(() => {
    process.env.HOME = originalHome;
    rmSync(tempHome, { recursive: true, force: true });
});

describe("session models cache", () => {
    test("write/read roundtrip", () => {
        const models = [model("claude-subscription", "claude-sonnet-5"), model("openrouter", "gpt-6")];
        writeSessionModelsCache(models);
        expect(readSessionModelsCache()).toEqual(models);
    });

    test("returns null when cache file is missing", () => {
        expect(readSessionModelsCache()).toBeNull();
    });

    test("returns null for corrupt or malformed cache", () => {
        const dir = join(tempHome, ".pizzapi");
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "session-models-cache.json"), "not json");
        expect(readSessionModelsCache()).toBeNull();

        writeFileSync(join(dir, "session-models-cache.json"), JSON.stringify({ models: "nope", fetchedAt: Date.now() }));
        expect(readSessionModelsCache()).toBeNull();
    });

    test("returns null for stale cache", () => {
        const dir = join(tempHome, ".pizzapi");
        mkdirSync(dir, { recursive: true });
        writeFileSync(
            join(dir, "session-models-cache.json"),
            JSON.stringify({ models: [model("p", "m")], fetchedAt: Date.now() - 8 * 24 * 60 * 60 * 1000 }),
        );
        expect(readSessionModelsCache()).toBeNull();
    });

    test("filters invalid entries", () => {
        const dir = join(tempHome, ".pizzapi");
        mkdirSync(dir, { recursive: true });
        writeFileSync(
            join(dir, "session-models-cache.json"),
            JSON.stringify({ models: [model("p", "m"), { provider: "x" }], fetchedAt: Date.now() }),
        );
        expect(readSessionModelsCache()).toEqual([model("p", "m")]);
    });

    test("skips writes for empty and unchanged lists", () => {
        writeSessionModelsCache([]);
        expect(readSessionModelsCache()).toBeNull();

        const models = [model("p", "m")];
        writeSessionModelsCache(models);
        const path = join(tempHome, ".pizzapi", "session-models-cache.json");
        const first = readFileSync(path, "utf-8");
        writeSessionModelsCache(models); // unchanged — should not rewrite
        expect(readFileSync(path, "utf-8")).toBe(first);
    });
});

describe("mergeModelLists", () => {
    test("preferred wins conflicts, extras appended, sorted by provider then id", () => {
        const preferred = [model("anthropic", "opus", { contextWindow: 200000 })];
        const extra = [
            model("anthropic", "opus", { contextWindow: 1 }),
            model("claude-subscription", "sonnet"),
            model("anthropic", "haiku"),
        ];
        const merged = mergeModelLists(preferred, extra);
        expect(merged.map((m) => `${m.provider}:${m.id}`)).toEqual([
            "anthropic:haiku",
            "anthropic:opus",
            "claude-subscription:sonnet",
        ]);
        expect(merged.find((m) => m.id === "opus")?.contextWindow).toBe(200000);
    });

    test("handles empty inputs", () => {
        expect(mergeModelLists([], [])).toEqual([]);
        expect(mergeModelLists([], [model("p", "m")])).toEqual([model("p", "m")]);
        expect(mergeModelLists([model("p", "m")], [])).toEqual([model("p", "m")]);
    });
});
