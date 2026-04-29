import { describe, expect, test } from "bun:test";
import {
    buildSnapshotPatchFromCapabilities,
    buildSnapshotPatchFromMetadata,
    mergeSnapshotStatePatch,
    shouldPersistSnapshotPatch,
} from "./snapshot-state.js";

describe("buildSnapshotPatchFromMetadata", () => {
    test("captures reconnect-relevant session metadata including models and commands", () => {
        const patch = buildSnapshotPatchFromMetadata({
            model: { provider: "anthropic", id: "claude-sonnet-4-5" },
            sessionName: "  Session Name  ",
            thinkingLevel: "high",
            availableModels: [{ provider: "anthropic", id: "claude-sonnet-4-5" }],
            availableCommands: [{ name: "search_tools", description: "search" }],
            todoList: [{ id: 1, text: "todo", status: "pending" }],
        });

        expect(patch).toEqual({
            model: { provider: "anthropic", id: "claude-sonnet-4-5" },
            sessionName: "Session Name",
            thinkingLevel: "high",
            availableModels: [{ provider: "anthropic", id: "claude-sonnet-4-5" }],
            availableCommands: [{ name: "search_tools", description: "search" }],
            todoList: [{ id: 1, text: "todo", status: "pending" }],
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
        });

        expect(patch).toEqual({
            model: null,
            sessionName: null,
            thinkingLevel: null,
            availableModels: [],
            availableCommands: [],
            todoList: [],
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

    test("persists patches that explicitly update messages immediately", () => {
        expect(shouldPersistSnapshotPatch({
            patch: { messages: [{ role: "user", content: "hi" }] },
            lastWriteAt: 39_000,
            now: 40_000,
            throttleMs: 30_000,
        })).toBe(true);
    });
});
