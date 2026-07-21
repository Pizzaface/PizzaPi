import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _setGlobalConfigDir } from "./config/io.js";
import { filterVisibleModels, isModelHidden, modelKey, normalizeHiddenModels, setHiddenModels } from "./model-visibility.js";

describe("model visibility", () => {
    test("normalizes, deduplicates, and matches provider/model keys", () => {
        const hidden = normalizeHiddenModels([" anthropic / claude-opus ", "anthropic/claude-opus", null, "invalid"]);
        expect(hidden).toEqual(["anthropic/claude-opus"]);
        expect(modelKey({ provider: " anthropic ", id: " claude-opus " })).toBe("anthropic/claude-opus");
        expect(isModelHidden({ provider: "anthropic", id: "claude-opus" }, hidden)).toBe(true);
    });

    test("persists the normalized runner-local policy", () => {
        const dir = mkdtempSync(join(tmpdir(), "model-visibility-"));
        _setGlobalConfigDir(dir);
        try {
            expect(setHiddenModels([" openai / hidden ", "openai/hidden"])).toEqual(["openai/hidden"]);
            expect(JSON.parse(readFileSync(join(dir, "config.json"), "utf8")).hiddenModels).toEqual(["openai/hidden"]);
        } finally {
            _setGlobalConfigDir(null);
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test("preserves slashes inside model IDs and filters hidden models", () => {
        const models = [
            { provider: "openrouter", id: "vendor/model" },
            { provider: "openai", id: "gpt-5" },
        ];
        expect(filterVisibleModels(models, ["openrouter/vendor/model"])).toEqual([models[1]]);
    });
});
