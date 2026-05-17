import { describe, test, expect } from "bun:test";
import { reconstructContext } from "./analyzer";
import type { ParsedEntry } from "./types";

describe("reconstructContext", () => {
  test("simple session with two assistant turns", () => {
    const entries: ParsedEntry[] = [
      { type: "session", id: "abc", timestamp: "2024-01-01T00:00:00.000Z", cwd: "/test" },
      { type: "message", id: "u1", parentId: null, timestamp: "2024-01-01T00:00:01.000Z", message: { role: "user", content: "hello" } },
      { type: "message", id: "a1", parentId: "u1", timestamp: "2024-01-01T00:00:02.000Z", message: { role: "assistant", content: [{ type: "text", text: "hi" }], provider: "anthropic", model: "sonnet", usage: { input: 800, output: 50, cacheRead: 0, cacheWrite: 800, totalTokens: 850 } } },
      { type: "message", id: "u2", parentId: "a1", timestamp: "2024-01-01T00:00:03.000Z", message: { role: "user", content: "more" } },
      { type: "message", id: "a2", parentId: "u2", timestamp: "2024-01-01T00:00:04.000Z", message: { role: "assistant", content: [{ type: "text", text: "ok" }], provider: "anthropic", model: "sonnet", usage: { input: 1200, output: 30, cacheRead: 400, cacheWrite: 200, totalTokens: 1230 } } },
    ];

    const result = reconstructContext(entries, "a2");
    expect(result.sessionId).toBe("abc");
    expect(result.blocks.length).toBeGreaterThanOrEqual(2);

    const t0 = result.blocks.find((b) => b.role === "turn" && b.turnIndex === 0);
    expect(t0).toBeDefined();
    expect(t0!.tokens).toBe(800);

    const t1 = result.blocks.find((b) => b.role === "turn" && b.turnIndex === 1);
    expect(t1).toBeDefined();
    expect(t1!.tokens).toBe(400);

    expect(result.summary.cacheHitRate).toBeCloseTo(400 / 2000, 2);
    expect(result.compactions.length).toBe(0);
  });

  test("session with compaction produces separator block and compaction boundary", () => {
    const entries: ParsedEntry[] = [
      { type: "session", id: "abc", timestamp: "2024-01-01T00:00:00.000Z", cwd: "/test" },
      { type: "message", id: "u1", parentId: null, timestamp: "2024-01-01T00:00:01.000Z", message: { role: "user", content: "hello" } },
      { type: "message", id: "a1", parentId: "u1", timestamp: "2024-01-01T00:00:02.000Z", message: { role: "assistant", content: [{ type: "text", text: "hi" }], provider: "anthropic", model: "sonnet", usage: { input: 5000, output: 50, cacheRead: 0, cacheWrite: 5000, totalTokens: 5050 } } },
      { type: "compaction", id: "c1", parentId: "a1", timestamp: "2024-01-01T00:05:00.000Z", summary: "summary text here", firstKeptEntryId: "u1", tokensBefore: 5000 },
      { type: "message", id: "u2", parentId: "c1", timestamp: "2024-01-01T00:05:01.000Z", message: { role: "user", content: "more" } },
      { type: "message", id: "a2", parentId: "u2", timestamp: "2024-01-01T00:05:02.000Z", message: { role: "assistant", content: [{ type: "text", text: "ok" }], provider: "anthropic", model: "sonnet", usage: { input: 500, output: 30, cacheRead: 0, cacheWrite: 500, totalTokens: 530 } } },
    ];

    const result = reconstructContext(entries, "a2");
    expect(result.compactions.length).toBe(1);
    expect(result.compactions[0]!.tokensBeforeCompaction).toBe(5000);

    const separator = result.blocks.find((b) => b.role === "separator");
    expect(separator).toBeDefined();
    expect(separator!.rawTokenDelta).toBeLessThan(0);
  });

  test("session with model change tracks multiple models", () => {
    const entries: ParsedEntry[] = [
      { type: "session", id: "abc", timestamp: "2024-01-01T00:00:00.000Z", cwd: "/test" },
      { type: "message", id: "u1", parentId: null, timestamp: "2024-01-01T00:00:01.000Z", message: { role: "user", content: "hello" } },
      { type: "message", id: "a1", parentId: "u1", timestamp: "2024-01-01T00:00:02.000Z", message: { role: "assistant", content: [{ type: "text", text: "hi" }], provider: "anthropic", model: "sonnet", usage: { input: 500, output: 50, cacheRead: 100, cacheWrite: 500, totalTokens: 550 } } },
      { type: "model_change", id: "mc1", parentId: "a1", timestamp: "2024-01-01T00:05:00.000Z", provider: "openai", modelId: "gpt-5.4" },
      { type: "message", id: "u2", parentId: "mc1", timestamp: "2024-01-01T00:05:01.000Z", message: { role: "user", content: "more" } },
      { type: "message", id: "a2", parentId: "u2", timestamp: "2024-01-01T00:05:02.000Z", message: { role: "assistant", content: [{ type: "text", text: "ok" }], provider: "openai-codex", model: "gpt-5.4", usage: { input: 800, output: 30, cacheRead: 0, cacheWrite: 0, totalTokens: 830 } } },
    ];

    const result = reconstructContext(entries, "a2");
    expect(result.modelsUsed.length).toBe(2);
  });

  test("branch summary entry creates a block", () => {
    const entries: ParsedEntry[] = [
      { type: "session", id: "abc", timestamp: "2024-01-01T00:00:00.000Z", cwd: "/test" },
      { type: "message", id: "u1", parentId: null, timestamp: "2024-01-01T00:00:01.000Z", message: { role: "user", content: "hello" } },
      { type: "message", id: "a1", parentId: "u1", timestamp: "2024-01-01T00:00:02.000Z", message: { role: "assistant", content: [{ type: "text", text: "hi" }], provider: "anthropic", model: "sonnet", usage: { input: 500, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 550 } } },
      { type: "branch_summary", id: "bs1", parentId: "a1", timestamp: "2024-01-01T00:05:00.000Z", fromId: "a1", summary: "Previous branch explored approach A" },
    ];

    const result = reconstructContext(entries, "bs1");
    const bs = result.blocks.find((b) => b.role === "branch_summary");
    expect(bs).toBeDefined();
    expect(bs!.tokens).toBeGreaterThan(0);
  });

  test("custom message entry creates a block", () => {
    const entries: ParsedEntry[] = [
      { type: "session", id: "abc", timestamp: "2024-01-01T00:00:00.000Z", cwd: "/test" },
      { type: "message", id: "u1", parentId: null, timestamp: "2024-01-01T00:00:01.000Z", message: { role: "user", content: "hello" } },
      { type: "message", id: "a1", parentId: "u1", timestamp: "2024-01-01T00:00:02.000Z", message: { role: "assistant", content: [{ type: "text", text: "hi" }], provider: "anthropic", model: "sonnet", usage: { input: 500, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 550 } } },
      { type: "custom_message", id: "cm1", parentId: "a1", timestamp: "2024-01-01T00:05:00.000Z", customType: "test", content: "Injected context from extension", display: true },
    ];

    const result = reconstructContext(entries, "cm1");
    const cm = result.blocks.find((b) => b.role === "custom_message");
    expect(cm).toBeDefined();
    expect(cm!.tokens).toBeGreaterThan(0);
  });

  test("multiple compactions", () => {
    const entries: ParsedEntry[] = [
      { type: "session", id: "abc", timestamp: "2024-01-01T00:00:00.000Z", cwd: "/test" },
      { type: "message", id: "u1", parentId: null, timestamp: "2024-01-01T00:00:01.000Z", message: { role: "user", content: "hello" } },
      { type: "message", id: "a1", parentId: "u1", timestamp: "2024-01-01T00:00:02.000Z", message: { role: "assistant", content: [{ type: "text", text: "hi" }], provider: "anthropic", model: "sonnet", usage: { input: 5000, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 5050 } } },
      { type: "compaction", id: "c1", parentId: "a1", timestamp: "2024-01-01T00:10:00.000Z", summary: "first compaction", firstKeptEntryId: "u1", tokensBefore: 5000 },
      { type: "message", id: "u2", parentId: "c1", timestamp: "2024-01-01T00:10:01.000Z", message: { role: "user", content: "more" } },
      { type: "message", id: "a2", parentId: "u2", timestamp: "2024-01-01T00:10:02.000Z", message: { role: "assistant", content: [{ type: "text", text: "ok" }], provider: "anthropic", model: "sonnet", usage: { input: 6000, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 6050 } } },
      { type: "compaction", id: "c2", parentId: "a2", timestamp: "2024-01-01T00:20:00.000Z", summary: "second compaction", firstKeptEntryId: "u2", tokensBefore: 6000 },
      { type: "message", id: "u3", parentId: "c2", timestamp: "2024-01-01T00:20:01.000Z", message: { role: "user", content: "even more" } },
      { type: "message", id: "a3", parentId: "u3", timestamp: "2024-01-01T00:20:02.000Z", message: { role: "assistant", content: [{ type: "text", text: "ok" }], provider: "anthropic", model: "sonnet", usage: { input: 500, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 550 } } },
    ];

    const result = reconstructContext(entries, "a3");
    expect(result.compactions.length).toBe(2);
    expect(result.summary.compactionCount).toBe(2);
  });

  test("empty session with no assistant messages", () => {
    const entries: ParsedEntry[] = [
      { type: "session", id: "abc", timestamp: "2024-01-01T00:00:00.000Z", cwd: "/test" },
      { type: "message", id: "u1", parentId: null, timestamp: "2024-01-01T00:00:01.000Z", message: { role: "user", content: "hello" } },
    ];

    const result = reconstructContext(entries, "u1");
    expect(result.blocks.filter((b) => b.role === "turn").length).toBe(0);
    expect(result.summary.totalTokens).toBe(0);
    expect(result.summary.cacheHitRate).toBe(0);
  });

  test("missing cost data returns null savings", () => {
    const entries: ParsedEntry[] = [
      { type: "session", id: "abc", timestamp: "2024-01-01T00:00:00.000Z", cwd: "/test" },
      { type: "message", id: "u1", parentId: null, timestamp: "2024-01-01T00:00:01.000Z", message: { role: "user", content: "hello" } },
      { type: "message", id: "a1", parentId: "u1", timestamp: "2024-01-01T00:00:02.000Z", message: { role: "assistant", content: [{ type: "text", text: "hi" }], provider: "openai", model: "gpt-4o", usage: { input: 500, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 550 } } },
    ];

    const result = reconstructContext(entries, "a1");
    expect(result.summary.estimatedCacheSavings).toBeNull();
  });

  test("contextUtilization is null when no contextWindow provided", () => {
    const entries: ParsedEntry[] = [
      { type: "session", id: "abc", timestamp: "2024-01-01T00:00:00.000Z", cwd: "/test" },
      { type: "message", id: "u1", parentId: null, timestamp: "2024-01-01T00:00:01.000Z", message: { role: "user", content: "hello" } },
      { type: "message", id: "a1", parentId: "u1", timestamp: "2024-01-01T00:00:02.000Z", message: { role: "assistant", content: [{ type: "text", text: "hi" }], provider: "anthropic", model: "sonnet", usage: { input: 500, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 550 } } },
    ];

    const result = reconstructContext(entries, "a1");
    expect(result.summary.contextUtilization).toBeNull();
  });

  test("contextUtilization computed when contextWindow provided", () => {
    const entries: ParsedEntry[] = [
      { type: "session", id: "abc", timestamp: "2024-01-01T00:00:00.000Z", cwd: "/test" },
      { type: "message", id: "u1", parentId: null, timestamp: "2024-01-01T00:00:01.000Z", message: { role: "user", content: "hello" } },
      { type: "message", id: "a1", parentId: "u1", timestamp: "2024-01-01T00:00:02.000Z", message: { role: "assistant", content: [{ type: "text", text: "hi" }], provider: "anthropic", model: "sonnet", usage: { input: 50000, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 50050 } } },
    ];

    const ctxWindows = new Map([["anthropic:sonnet", 200000]]);
    const result = reconstructContext(entries, "a1", ctxWindows);
    expect(result.summary.contextUtilization).toBeCloseTo(0.25, 2);
  });

  test("UTF-8 content in messages does not break analysis", () => {
    const entries: ParsedEntry[] = [
      { type: "session", id: "abc", timestamp: "2024-01-01T00:00:00.000Z", cwd: "/test" },
      { type: "message", id: "u1", parentId: null, timestamp: "2024-01-01T00:00:01.000Z", message: { role: "user", content: "héllo wörld 🎉" } },
      { type: "message", id: "a1", parentId: "u1", timestamp: "2024-01-01T00:00:02.000Z", message: { role: "assistant", content: [{ type: "text", text: "café résumé" }], provider: "anthropic", model: "sonnet", usage: { input: 500, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 550 } } },
    ];

    const result = reconstructContext(entries, "a1");
    expect(result.blocks.length).toBeGreaterThanOrEqual(1);
    const turn = result.blocks.find((b) => b.role === "turn");
    expect(turn).toBeDefined();
    expect(turn!.tokens).toBe(500);
  });
});
