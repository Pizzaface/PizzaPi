import { describe, expect, test } from "bun:test";
import { deriveSessionMetadataUpdatePatch } from "./session-metadata-update.js";

describe("deriveSessionMetadataUpdatePatch", () => {
  test("applies live metadata updates even when hub meta is authoritative", () => {
    const patch = deriveSessionMetadataUpdatePatch({
      metadata: {
        model: { provider: "anthropic", id: "claude-sonnet-4-5" },
        sessionName: "Live Session",
        thinkingLevel: "high",
        todoList: [{ id: 1, text: "live", status: "pending" }],
        availableModels: [{ provider: "openai", id: "gpt-5" }],
        availableCommands: [{ name: "search_tools", description: "Search" }],
      },
      hubAuthoritative: true,
    });

    expect(patch).toEqual({
      activeModel: { provider: "anthropic", id: "claude-sonnet-4-5" },
      sessionName: "Live Session",
      thinkingLevel: "high",
      todoList: [{ id: 1, text: "live", status: "pending" }],
      availableModels: [{ provider: "openai", id: "gpt-5", name: undefined, reasoning: undefined, contextWindow: undefined }],
      availableCommands: [{ name: "search_tools", description: "Search", source: undefined }],
    });
  });

  test("applies the full metadata patch when hub meta is not authoritative", () => {
    const patch = deriveSessionMetadataUpdatePatch({
      metadata: {
        model: { provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
        sessionName: "  Session Name  ",
        thinkingLevel: "medium",
        todoList: [{ id: 1, text: "todo", status: "pending" }],
        availableModels: [{ provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" }],
        availableCommands: [{ name: "search_tools", description: "Search" }],
      },
      hubAuthoritative: false,
    });

    expect(patch).toEqual({
      activeModel: { provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
      sessionName: "Session Name",
      thinkingLevel: "medium",
      todoList: [{ id: 1, text: "todo", status: "pending" }],
      availableModels: [{ provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" }],
      availableCommands: [{ name: "search_tools", description: "Search" }],
    });
  });

  test("merges partial model metadata with the current active model", () => {
    const patch = deriveSessionMetadataUpdatePatch({
      metadata: {
        model: { provider: "anthropic", id: "claude-sonnet-4-5" },
      },
      currentActiveModel: {
        provider: "anthropic",
        id: "claude-sonnet-4-5",
        name: "Claude Sonnet 4.5",
        reasoning: true,
        contextWindow: 200000,
      },
    });

    expect(patch.activeModel).toEqual({
      provider: "anthropic",
      id: "claude-sonnet-4-5",
      name: "Claude Sonnet 4.5",
      reasoning: true,
      contextWindow: 200000,
    });
  });
});
