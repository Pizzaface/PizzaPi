import { describe, expect, test } from "bun:test";
import { reconstructContext } from "./analyzer.js";
import type { ParsedEntry, Usage } from "./types.js";

function usage(
  input: number,
  costTotal?: number,
  cacheRead = 0,
  cacheWrite = 0,
  costInput?: number,
  costCacheRead?: number,
): Usage {
  return {
    input,
    output: 0,
    cacheRead,
    cacheWrite,
    totalTokens: input + cacheRead + cacheWrite,
    ...(costTotal == null
      ? {}
      : {
          cost: {
            total: costTotal,
            ...(costInput == null ? {} : { input: costInput }),
            ...(costCacheRead == null ? {} : { cacheRead: costCacheRead }),
          },
        }),
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
    // Latest-compaction reconstruction (pi semantics): assistant-1 was
    // summarized away by compact-2 and is no longer in active context.
    expect(analysis.blocks.some((b) => b.entryId === "assistant-1")).toBe(false);
    expect(analysis.blocks.find((b) => b.entryId === "assistant-2")?.role).toBe("separator");
  });

  test("does not claim compaction savings after new context telemetry", () => {
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
        summary: "Compacted summary",
        firstKeptEntryId: "",
        tokensBefore: 5_000,
      },
      {
        type: "custom",
        id: "context-1",
        parentId: "compact-1",
        timestamp: "2026-05-28T00:00:02.000Z",
        customType: "context:skill:demo",
        data: { content: "A newly activated skill" },
      },
      {
        type: "message",
        id: "assistant-1",
        parentId: "context-1",
        timestamp: "2026-05-28T00:00:03.000Z",
        message: {
          role: "assistant",
          provider: "openai",
          model: "gpt",
          usage: usage(10_500),
        },
      },
    ];

    const analysis = reconstructContext(entries, "assistant-1");

    expect(analysis.compactions[0]?.estimatedTokensAfter).toBe(10_500);
    expect(analysis.compactions[0]?.estimatedTokensFreed).toBeNull();
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

  test("includes context telemetry entries as context blocks", () => {
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
          usage: usage(900, 0.01, 100, 50),
        },
      },
    ];

    const analysis = reconstructContext(entries, "assistant-1");

    expect(analysis.summary.cacheHitRate).toBeCloseTo(100 / 1_050);
    expect(analysis.modelsUsed[0]?.cacheHitRate).toBeCloseTo(100 / 1_050);
  });

  test("uses the full prompt token count for context deltas", () => {
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
        message: { role: "assistant", provider: "openai", model: "gpt", usage: usage(900, 0, 100, 50) },
      },
      {
        type: "message",
        id: "assistant-2",
        parentId: "assistant-1",
        timestamp: "2026-05-28T00:00:02.000Z",
        message: { role: "assistant", provider: "openai", model: "gpt", usage: usage(950, 0, 100, 50) },
      },
    ];

    const analysis = reconstructContext(entries, "assistant-2");

    expect(analysis.blocks.map((block) => block.tokens)).toEqual([1_050, 50]);
    expect(analysis.summary.peakContextUsage).toBe(1_100);
  });

  test("uses each assistant message model and its context window", () => {
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
        message: { role: "assistant", provider: "anthropic", model: "claude", usage: usage(900) },
      },
      {
        type: "message",
        id: "assistant-2",
        parentId: "assistant-1",
        timestamp: "2026-05-28T00:00:02.000Z",
        message: { role: "assistant", provider: "openai", model: "gpt", usage: usage(1_000) },
      },
    ];

    const analysis = reconstructContext(entries, "assistant-2", new Map([
      ["anthropic:claude", 1_000],
      ["openai:gpt", 10_000],
    ]));

    expect(analysis.modelsUsed.map((model) => model.id)).toEqual(["claude", "gpt"]);
    expect(analysis.summary.contextUtilization).toBe(0.9);
  });

  test("does not fabricate a growth delta across missing usage", () => {
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
        message: { role: "assistant", provider: "openai", model: "gpt", usage: usage(1_000) },
      },
      {
        type: "message",
        id: "assistant-2",
        parentId: "assistant-1",
        timestamp: "2026-05-28T00:00:02.000Z",
        message: { role: "assistant", provider: "openai", model: "gpt" },
      },
      {
        type: "message",
        id: "assistant-3",
        parentId: "assistant-2",
        timestamp: "2026-05-28T00:00:03.000Z",
        message: { role: "assistant", provider: "openai", model: "gpt", usage: usage(1_200) },
      },
    ];

    const analysis = reconstructContext(entries, "assistant-3");

    expect(analysis.blocks.find((block) => block.entryId === "assistant-3")).toMatchObject({
      role: "separator",
      tokens: 0,
    });
    expect(analysis.summary.cacheHitRate).toBeNull();
  });

  test("does not double-count branch summaries as sized blocks", () => {
    const entries: ParsedEntry[] = [
      {
        type: "session",
        id: "session-1",
        timestamp: "2026-05-28T00:00:00.000Z",
        cwd: "/tmp/session-analysis-test",
      },
      {
        type: "branch_summary",
        id: "branch-1",
        parentId: null,
        timestamp: "2026-05-28T00:00:01.000Z",
        fromId: "old-branch",
        summary: "A summary already represented in prompt usage",
      },
      {
        type: "message",
        id: "assistant-1",
        parentId: "branch-1",
        timestamp: "2026-05-28T00:00:02.000Z",
        message: { role: "assistant", provider: "openai", model: "gpt", usage: usage(1_000) },
      },
    ];

    const analysis = reconstructContext(entries, "assistant-1");

    expect(analysis.blocks.some((block) => block.role === "branch_summary")).toBe(false);
  });

  test("counts compaction and branch-summary generation usage in totals", () => {
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
        summary: "Summary",
        firstKeptEntryId: "",
        tokensBefore: 1_000,
        usage: usage(40, 0.4, 10, 5),
      },
      {
        type: "message",
        id: "assistant-1",
        parentId: "compact-1",
        timestamp: "2026-05-28T00:00:02.000Z",
        message: { role: "assistant", provider: "openai", model: "gpt", usage: usage(100, 1, 20) },
      },
    ];

    const analysis = reconstructContext(entries, "assistant-1");

    expect(analysis.summary.totalTokens).toBe(175);
    expect(analysis.summary.totalCost).toBe(1.4);
    expect(analysis.summary.cacheHitRate).toBeCloseTo(30 / 175);
  });

  test("terminates on malformed parent cycles", () => {
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
        parentId: "assistant-2",
        timestamp: "2026-05-28T00:00:01.000Z",
        message: { role: "assistant", provider: "openai", model: "gpt", usage: usage(1_000) },
      },
      {
        type: "message",
        id: "assistant-2",
        parentId: "assistant-1",
        timestamp: "2026-05-28T00:00:02.000Z",
        message: { role: "assistant", provider: "openai", model: "gpt", usage: usage(1_200) },
      },
    ];

    // A parent cycle must not hang; both entries appear once.
    const analysis = reconstructContext(entries, "assistant-2");
    expect(analysis.blocks).toHaveLength(2);
  });

  test("excludes aborted turns from context but keeps them in totals", () => {
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
        message: { role: "assistant", provider: "openai", model: "gpt", usage: usage(1_000, 1) },
      },
      {
        type: "message",
        id: "assistant-aborted",
        parentId: "assistant-1",
        timestamp: "2026-05-28T00:00:02.000Z",
        message: {
          role: "assistant",
          provider: "openai",
          model: "gpt",
          stopReason: "aborted",
          usage: usage(9_000, 1),
        },
      },
      {
        type: "message",
        id: "assistant-2",
        parentId: "assistant-aborted",
        timestamp: "2026-05-28T00:00:03.000Z",
        message: { role: "assistant", provider: "openai", model: "gpt", usage: usage(1_200, 1) },
      },
    ];

    const analysis = reconstructContext(entries, "assistant-2", new Map([["openai:gpt", 10_000]]));

    // The aborted turn's inflated 9k snapshot must not set the peak or utilization.
    expect(analysis.summary.peakContextUsage).toBe(1_200);
    expect(analysis.summary.contextUtilization).toBe(0.12);
    expect(analysis.blocks.find((b) => b.entryId === "assistant-aborted")?.role).toBe("separator");
    // Billed usage still counts toward totals.
    expect(analysis.summary.totalTokens).toBe(11_200);
    expect(analysis.summary.totalCost).toBe(3);
    // Continuity after the aborted turn is unknown → separator, not growth.
    expect(analysis.blocks.find((b) => b.entryId === "assistant-2")?.role).toBe("separator");
  });

  test("subtracts the cache-write premium from net savings", () => {
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
          provider: "anthropic",
          model: "claude",
          usage: {
            input: 1_000,
            output: 0,
            cacheRead: 0,
            cacheWrite: 1_000,
            totalTokens: 2_000,
            // Write premium: 0.00375 - 1000 * (0.003 / 1000) = 0.00075
            cost: { total: 0.01, input: 0.003, cacheWrite: 0.00375 },
          },
        },
      },
    ];

    const analysis = reconstructContext(entries, "assistant-1");

    expect(analysis.summary.estimatedCacheSavings).toBeCloseTo(-0.00075);
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

  test("uses reported input and cache-read costs for cache savings", () => {
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
          usage: usage(2_000, 0.02, 1_000, 0, 0.0016, 0.00008),
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
