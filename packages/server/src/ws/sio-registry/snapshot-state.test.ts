import { describe, expect, test } from "bun:test";
import {
    buildSnapshotPatchFromCapabilities,
    buildSnapshotPatchFromMetadata,
    mergeSnapshotStatePatch,
    mergeSnapshotOverlay,
    applySnapshotOverlayToState,
    shouldPersistSnapshotPatch,
} from "./snapshot-state.js";

describe("mergeSnapshotOverlay", () => {
    test("starts a fresh overlay when none exists", () => {
        expect(mergeSnapshotOverlay(null, { thinkingLevel: "high" })).toEqual({ thinkingLevel: "high" });
    });

    test("accumulates patches, later values winning", () => {
        const first = mergeSnapshotOverlay(null, { todoList: [1], thinkingLevel: "low" });
        const second = mergeSnapshotOverlay(JSON.stringify(first), { thinkingLevel: "high" });
        expect(second).toEqual({ todoList: [1], thinkingLevel: "high" });
    });

    test("merges same-model patches field-wise", () => {
        const first = mergeSnapshotOverlay(null, { model: { provider: "p", id: "m", contextWindow: 1000 } });
        const second = mergeSnapshotOverlay(JSON.stringify(first), { model: { provider: "p", id: "m", thinking: true } });
        expect(second.model).toEqual({ provider: "p", id: "m", contextWindow: 1000, thinking: true });
    });

    test("replaces the model when provider/id change", () => {
        const first = mergeSnapshotOverlay(null, { model: { provider: "p", id: "m", contextWindow: 1000 } });
        const second = mergeSnapshotOverlay(JSON.stringify(first), { model: { provider: "p2", id: "m2" } });
        expect(second.model).toEqual({ provider: "p2", id: "m2" });
    });

    test("recovers from a corrupt existing overlay", () => {
        expect(mergeSnapshotOverlay("{not json", { goal: null })).toEqual({ goal: null });
    });
});

describe("applySnapshotOverlayToState", () => {
    test("returns state unchanged for empty/missing/corrupt overlay", () => {
        const state = { messages: [1] };
        expect(applySnapshotOverlayToState(state, null)).toBe(state);
        expect(applySnapshotOverlayToState(state, "")).toBe(state);
        expect(applySnapshotOverlayToState(state, "{}")).toBe(state);
        expect(applySnapshotOverlayToState(state, "{broken")).toBe(state);
    });

    test("overlays metadata without touching messages", () => {
        const state = { messages: [1, 2], queuedMessages: [], thinkingLevel: "low" };
        const result = applySnapshotOverlayToState(
            state,
            JSON.stringify({ queuedMessages: ["q"], thinkingLevel: "high" }),
        ) as Record<string, unknown>;
        expect(result.messages).toEqual([1, 2]);
        expect(result.queuedMessages).toEqual(["q"]);
        expect(result.thinkingLevel).toBe("high");
        // Original untouched
        expect(state.queuedMessages).toEqual([]);
    });

    test("merges same-model overlay field-wise with the state's model", () => {
        const state = { model: { provider: "p", id: "m", contextWindow: 5 } };
        const result = applySnapshotOverlayToState(
            state,
            JSON.stringify({ model: { provider: "p", id: "m", thinking: true } }),
        ) as Record<string, unknown>;
        expect(result.model).toEqual({ provider: "p", id: "m", contextWindow: 5, thinking: true });
    });

    test("passes non-object state through untouched", () => {
        expect(applySnapshotOverlayToState(null, "{\"a\":1}")).toBeNull();
        expect(applySnapshotOverlayToState([1], "{\"a\":1}")).toEqual([1]);
    });
});

describe("buildSnapshotPatchFromMetadata", () => {
    test("captures reconnect-relevant session metadata including models and commands", () => {
        const patch = buildSnapshotPatchFromMetadata({
            model: { provider: "anthropic", id: "claude-sonnet-4-5" },
            sessionName: "  Session Name  ",
            thinkingLevel: "high",
            availableModels: [{ provider: "anthropic", id: "claude-sonnet-4-5" }],
            availableCommands: [{ name: "search_tools", description: "search" }],
            todoList: [{ id: 1, text: "todo", status: "pending" }],
            goal: { id: "goal_1", description: "tests pass", status: "active", turnCount: 3, tokenSpend: 0, costSpend: 0 },
        });

        expect(patch).toEqual({
            model: { provider: "anthropic", id: "claude-sonnet-4-5" },
            sessionName: "Session Name",
            thinkingLevel: "high",
            availableModels: [{ provider: "anthropic", id: "claude-sonnet-4-5" }],
            availableCommands: [{ name: "search_tools", description: "search" }],
            todoList: [{ id: 1, text: "todo", status: "pending" }],
            goal: { id: "goal_1", description: "tests pass", status: "active", turnCount: 3, tokenSpend: 0, costSpend: 0 },
        });
    });

    test("preserves explicit clears for nullable fields", () => {
        const patch = buildSnapshotPatchFromMetadata({
            model: null,
            sessionName: null,
            thinkingLevel: null,
            availableModels: [],
            availableCommands: [],
            todoList: [],
            goal: null,
        });

        expect(patch).toEqual({
            model: null,
            sessionName: null,
            thinkingLevel: null,
            availableModels: [],
            availableCommands: [],
            todoList: [],
            goal: null,
        });
    });
});

describe("buildSnapshotPatchFromCapabilities", () => {
    test("maps capabilities payload into snapshot keys", () => {
        expect(buildSnapshotPatchFromCapabilities({
            models: [{ provider: "google", id: "gemini-2.5-pro" }],
            commands: [{ name: "set_session_name" }],
        })).toEqual({
            availableModels: [{ provider: "google", id: "gemini-2.5-pro" }],
            availableCommands: [{ name: "set_session_name" }],
        });
    });
});

describe("mergeSnapshotStatePatch", () => {
    test("merges metadata without dropping transcript messages", () => {
        const merged = mergeSnapshotStatePatch(
            JSON.stringify({
                messages: [{ role: "user", content: "hi" }],
                sessionName: "Old",
                availableCommands: [],
            }),
            {
                sessionName: "New",
                availableCommands: [{ name: "search_tools" }],
            },
        );

        expect(merged).toEqual({
            messages: [{ role: "user", content: "hi" }],
            sessionName: "New",
            availableCommands: [{ name: "search_tools" }],
        });
    });

    test("preserves richer snapshot model fields when a later patch is partial", () => {
        const merged = mergeSnapshotStatePatch(
            JSON.stringify({
                model: {
                    provider: "anthropic",
                    id: "claude-sonnet-4-5",
                    name: "Claude Sonnet 4.5",
                    reasoning: true,
                    contextWindow: 200000,
                },
            }),
            {
                model: {
                    provider: "anthropic",
                    id: "claude-sonnet-4-5",
                },
            },
        );

        expect(merged).toEqual({
            model: {
                provider: "anthropic",
                id: "claude-sonnet-4-5",
                name: "Claude Sonnet 4.5",
                reasoning: true,
                contextWindow: 200000,
            },
        });
    });

    test("returns null when there is no existing snapshot state to patch", () => {
        expect(mergeSnapshotStatePatch(null, { availableCommands: [] })).toBeNull();
        expect(mergeSnapshotStatePatch("not json", { availableCommands: [] })).toBeNull();
    });
});

describe("shouldPersistSnapshotPatch", () => {
    test("throttles metadata-only patches even when the merged snapshot already has messages", () => {
        expect(shouldPersistSnapshotPatch({
            patch: { availableCommands: [{ name: "search_tools" }] },
            lastWriteAt: 1_000,
            now: 5_000,
            throttleMs: 30_000,
        })).toBe(false);
    });

    test("allows metadata-only patches through once the throttle window expires", () => {
        expect(shouldPersistSnapshotPatch({
            patch: { availableCommands: [{ name: "search_tools" }] },
            lastWriteAt: 1_000,
            now: 40_000,
            throttleMs: 30_000,
        })).toBe(true);
    });

    test("throttles message-bearing patches like any other (no bypass)", () => {
        expect(shouldPersistSnapshotPatch({
            patch: { messages: [{ role: "user", content: "hi" }] },
            lastWriteAt: 39_000,
            now: 40_000,
            throttleMs: 30_000,
        })).toBe(false);
    });
});
