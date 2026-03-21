// ============================================================================
// runners.test.ts — Tests for hidden-model enforcement in the spawn endpoint
//
// The server-side validation is implemented via the exported `isHiddenModel`
// pure helper.  Testing it directly avoids mocking the entire dependency
// chain (auth, Redis, sockets) while still validating the exact logic used
// by the route handler.
// ============================================================================

import { describe, it, expect } from "bun:test";
import { isHiddenModel } from "./model-guard.js";

describe("isHiddenModel", () => {
    it("returns true when the model key is in the hidden list", () => {
        const hidden = ["anthropic/claude-3-5-haiku-20241022"];
        expect(isHiddenModel(hidden, { provider: "anthropic", id: "claude-3-5-haiku-20241022" })).toBe(true);
    });

    it("returns true for any matching provider/id pair", () => {
        const hidden = ["google/gemini-2.0-flash", "openai/gpt-4o"];
        expect(isHiddenModel(hidden, { provider: "google", id: "gemini-2.0-flash" })).toBe(true);
        expect(isHiddenModel(hidden, { provider: "openai", id: "gpt-4o" })).toBe(true);
    });

    it("returns false when the model is not in the hidden list", () => {
        const hidden = ["anthropic/claude-3-5-haiku-20241022"];
        expect(isHiddenModel(hidden, { provider: "anthropic", id: "claude-opus-4-5" })).toBe(false);
    });

    it("returns false when the hidden list is empty", () => {
        expect(isHiddenModel([], { provider: "anthropic", id: "claude-opus-4-5" })).toBe(false);
    });

    it("uses exact key matching — no partial/prefix matches", () => {
        // "anthropic/claude" should NOT match "anthropic/claude-opus-4-5"
        const hidden = ["anthropic/claude"];
        expect(isHiddenModel(hidden, { provider: "anthropic", id: "claude-opus-4-5" })).toBe(false);
    });

    it("is case-sensitive for both provider and model id", () => {
        const hidden = ["Anthropic/Claude-3-5-Haiku"];
        expect(isHiddenModel(hidden, { provider: "anthropic", id: "claude-3-5-haiku" })).toBe(false);
        expect(isHiddenModel(hidden, { provider: "Anthropic", id: "Claude-3-5-Haiku" })).toBe(true);
    });

    it("correctly formats the key as 'provider/id'", () => {
        // Verify the key format — provider and id joined with /
        const hidden = ["my-provider/my-model-v2"];
        expect(isHiddenModel(hidden, { provider: "my-provider", id: "my-model-v2" })).toBe(true);
        expect(isHiddenModel(hidden, { provider: "my-provider", id: "my-model-v1" })).toBe(false);
        expect(isHiddenModel(hidden, { provider: "other-provider", id: "my-model-v2" })).toBe(false);
    });
});
