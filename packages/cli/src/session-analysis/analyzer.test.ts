import { describe, expect, test } from "bun:test";
import { reconstructContext } from "./analyzer.js";
import type { ParsedEntry, Usage } from "./types.js";

function usage(input: number, costTotal?: number, cacheRead = 0): Usage {
  return {
    input,
    output: 0,
    cacheRead,
    cacheWrite: 0,
    totalTokens: input,
    ...(costTotal == null ? {} : { cost: { total: costTotal } }),
  };
}

describe("reconstructContext", () => {
  test("computes compaction savings from the next assistant turn after each compaction", () => {
    const entries: ParsedEntry[] = [
      {
        type: "session",
        id: "session-1",
        timestamp: "2026-05-28T00:00:00.000Z",
        cwd: "/tmp/session-analysis-test",
      },
      {
        type: "compaction",
        id: "compact-1",
        parentId: null,
        timestamp: "2026-05-28T00:00:01.000Z",
        summary: "First compacted summary",
        firstKeptEntryId: "",
        tokensBefore: 5_000,
      },
      {
        type: "message",
        id: "assistant-1",
        parentId: "compact-1",
        timestamp: "2026-05-28T00:00:02.000Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "first response" }],
          provider: "anthropic",
          model: "claude-sonnet-4-5",
          usage: usage(2_000),
        },
      },
      {
        type: "compaction",
        id: "compact-2",
        parentId: "assistant-1",
        timestamp: "2026-05-28T00:00:03.000Z",
        summary: "Second compacted summary",
        firstKeptEntryId: "",
        tokensBefore: 7_000,
      },
      {
        type: "message",
        id: "assistant-2",
        parentId: "compact-2",
        timestamp: "2026-05-28T00:00:04.000Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "second response" }],
          provider: "anthropic",
          model: "claude-sonnet-4-5",
          usage: usage(1_000),
        },
      },
    ];

    const analysis = reconstructContext(entries, "assistant-2");

    const first = analysis.compactions.find((c) => c.entryId === "compact-1");
    const second = analysis.compactions.find((c) => c.entryId === "compact-2");

    expect(first?.estimatedTokensAfter).toBe(2_000);
    expect(first?.estimatedTokensFreed).toBe(3_000);
    expect(second?.estimatedTokensAfter).toBe(1_000);
    expect(second?.estimatedTokensFreed).toBe(6_000);
    expect(analysis.blocks.find((b) => b.entryId === "assistant-2")?.role).toBe("separator");
  });

  test("keeps the firstKeptEntryId boundary after compaction", () => {
    const entries: ParsedEntry[] = [
      {
        type: "session",
        id: "session-1",
        timestamp: "2026-05-28T00:00:00.000Z",
        cwd: "/tmp/session-analysis-test",
      },
      {
        type: "message",
        id: "user-old",
        parentId: null,
        timestamp: "2026-05-28T00:00:01.000Z",
        message: { role: "user", content: "summarized prompt" },
      },
      {
        type: "message",
        id: "assistant-old",
        parentId: "user-old",
        timestamp: "2026-05-28T00:00:02.000Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "summarized response" }],
          provider: "anthropic",
          model: "claude-sonnet-4-5",
          usage: usage(1_000),
        },
      },
      {
        type: "message",
        id: "user-kept",
        parentId: "assistant-old",
        timestamp: "2026-05-28T00:00:03.000Z",
        message: { role: "user", content: "kept prompt" },
      },
      {
        type: "message",
        id: "assistant-kept",
        parentId: "user-kept",
        timestamp: "2026-05-28T00:00:04.000Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "kept response" }],
          provider: "anthropic",
          model: "claude-sonnet-4-5",
          usage: usage(1_500),
        },
      },
      {
        type: "compaction",
        id: "compact-1",
        parentId: "assistant-kept",
        timestamp: "2026-05-28T00:00:05.000Z",
        summary: "Old prompt and response were summarized.",
        firstKeptEntryId: "user-kept",
        tokensBefore: 2_000,
      },
      {
        type: "message",
        id: "assistant-after",
        parentId: "compact-1",
        timestamp: "2026-05-28T00:00:06.000Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "after compaction" }],
          provider: "anthropic",
          model: "claude-sonnet-4-5",
          usage: usage(800),
        },
      },
    ];

    const analysis = reconstructContext(entries, "assistant-after");

    expect(analysis.blocks.some((b) => b.entryId === "assistant-old")).toBe(false);
    expect(analysis.blocks.some((b) => b.entryId === "assistant-kept")).toBe(true);
    expect(analysis.blocks.some((b) => b.entryId === "assistant-after")).toBe(true);
  });

  test("includes non-context custom telemetry entries as context blocks", () => {
    const entries: ParsedEntry[] = [
      {
        type: "session",
        id: "session-1",
        timestamp: "2026-05-28T00:00:00.000Z",
        cwd: "/tmp/session-analysis-test",
      },
      {
        type: "custom",
        id: "context-1",
        parentId: null,
        timestamp: "2026-05-28T00:00:01.000Z",
        customType: "context:global-rules",
        data: { content: "Global rules content" },
      },
      {
        type: "message",
        id: "assistant-1",
        parentId: "context-1",
        timestamp: "2026-05-28T00:00:02.000Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "first response" }],
          provider: "anthropic",
          model: "claude-sonnet-4-5",
          usage: usage(1_000),
        },
      },
    ];

    const analysis = reconstructContext(entries, "assistant-1");

    expect(analysis.blocks).toContainEqual(expect.objectContaining({
      entryId: "context-1",
      role: "context:global-rules",
      title: "Global Rules",
    }));
    expect(analysis.summary.peakContextUsage).toBe(1_000);
    expect(analysis.blocks.reduce((sum, block) => sum + block.tokens, 0)).toBe(1_000);
  });

  test("computes cache hit rate as cache reads over total cacheable input", () => {
    const entries: ParsedEntry[] = [
      {
        type: "session",
        id: "session-1",
        timestamp: "2026-05-28T00:00:00.000Z",
        cwd: "/tmp/session-analysis-test",
      },
      {
        type: "message",
        id: "assistant-1",
        parentId: null,
        timestamp: "2026-05-28T00:00:01.000Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "cached response" }],
          provider: "anthropic",
          model: "claude-sonnet-4-5",
          usage: usage(900, 0.01, 100),
        },
      },
    ];

    const analysis = reconstructContext(entries, "assistant-1");

    expect(analysis.summary.cacheHitRate).toBe(0.1);
    expect(analysis.modelsUsed[0]?.cacheHitRate).toBe(0.1);
  });

  test("uses trailing model_change as the active model", () => {
    const entries: ParsedEntry[] = [
      {
        type: "session",
        id: "session-1",
        timestamp: "2026-05-28T00:00:00.000Z",
        cwd: "/tmp/session-analysis-test",
      },
      {
        type: "message",
        id: "assistant-1",
        parentId: null,
        timestamp: "2026-05-28T00:00:01.000Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "first response" }],
          provider: "anthropic",
          model: "claude-sonnet-4-5",
          usage: usage(1_000),
        },
      },
      {
        type: "model_change",
        id: "model-change-1",
        parentId: "assistant-1",
        timestamp: "2026-05-28T00:00:02.000Z",
        provider: "openai",
        modelId: "gpt-5.4-mini",
      },
    ];

    const analysis = reconstructContext(
      entries,
      "model-change-1",
      new Map([
        ["anthropic:claude-sonnet-4-5", 200_000],
        ["openai:gpt-5.4-mini", 128_000],
      ]),
    );

    expect(analysis.activeModel).toEqual({
      provider: "openai",
      id: "gpt-5.4-mini",
      contextWindow: 128_000,
    });
  });

  test("returns null total compaction savings when any compaction is unknown", () => {
    const entries: ParsedEntry[] = [
      {
        type: "session",
        id: "session-1",
        timestamp: "2026-05-28T00:00:00.000Z",
        cwd: "/tmp/session-analysis-test",
      },
      {
        type: "message",
        id: "assistant-1",
        parentId: null,
        timestamp: "2026-05-28T00:00:01.000Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "first response" }],
          provider: "anthropic",
          model: "claude-sonnet-4-5",
          usage: usage(1_000),
        },
      },
      {
        type: "compaction",
        id: "compact-1",
        parentId: "assistant-1",
        timestamp: "2026-05-28T00:00:02.000Z",
        summary: "Compacted summary",
        firstKeptEntryId: "assistant-1",
        tokensBefore: 5_000,
      },
    ];

    const analysis = reconstructContext(entries, "compact-1");

    expect(analysis.compactions[0]?.estimatedTokensFreed).toBeNull();
    expect(analysis.summary.tokensFreedByCompaction).toBeNull();
  });

  test("uses model-specific Anthropic pricing for cache savings", () => {
    const entries: ParsedEntry[] = [
      {
        type: "session",
        id: "session-1",
        timestamp: "2026-05-28T00:00:00.000Z",
        cwd: "/tmp/session-analysis-test",
      },
      {
        type: "message",
        id: "assistant-1",
        parentId: null,
        timestamp: "2026-05-28T00:00:01.000Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "haiku response" }],
          provider: "anthropic",
          model: "claude-haiku-4-5",
          usage: usage(2_000, 0.02, 1_000),
        },
      },
    ];

    const analysis = reconstructContext(entries, "assistant-1");

    expect(analysis.summary.estimatedCacheSavings).toBeCloseTo(0.00072);
  });

  test("returns null cache savings when any assistant turn has unknown pricing", () => {
    const entries: ParsedEntry[] = [
      {
        type: "session",
        id: "session-1",
        timestamp: "2026-05-28T00:00:00.000Z",
        cwd: "/tmp/session-analysis-test",
      },
      {
        type: "message",
        id: "assistant-1",
        parentId: null,
        timestamp: "2026-05-28T00:00:01.000Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "anthropic response" }],
          provider: "anthropic",
          model: "claude-sonnet-4-5",
          usage: usage(2_000, 0.02, 1_000),
        },
      },
      {
        type: "message",
        id: "assistant-2",
        parentId: "assistant-1",
        timestamp: "2026-05-28T00:00:02.000Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "openai response" }],
          provider: "openai",
          model: "gpt-5.4-mini",
          usage: usage(3_000, 0.03, 500),
        },
      },
    ];

    const analysis = reconstructContext(entries, "assistant-2");

    expect(analysis.summary.estimatedCacheSavings).toBeNull();
  });

  test("returns null cache savings when any assistant turn lacks cost data", () => {
    const entries: ParsedEntry[] = [
      {
        type: "session",
        id: "session-1",
        timestamp: "2026-05-28T00:00:00.000Z",
        cwd: "/tmp/session-analysis-test",
      },
      {
        type: "message",
        id: "assistant-1",
        parentId: null,
        timestamp: "2026-05-28T00:00:01.000Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "response without cost" }],
          provider: "anthropic",
          model: "claude-sonnet-4-5",
          usage: usage(2_000, undefined, 1_000),
        },
      },
    ];

    const analysis = reconstructContext(entries, "assistant-1");

    expect(analysis.summary.estimatedCacheSavings).toBeNull();
  });
});
