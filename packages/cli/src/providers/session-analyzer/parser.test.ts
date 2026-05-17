import { describe, test, expect } from "bun:test";
import { parseJsonlEntries, extractAssistantUsage, detectCompactions } from "./parser.js";
import type {
  ParsedEntry,
  ParsedMessageEntry,
  ParsedCompactionEntry,
  ParsedModelChangeEntry,
  ParsedBranchSummaryEntry,
  ParsedCustomMessageEntry,
} from "./types.js";

describe("parseJsonlEntries", () => {
  test("valid JSONL with multiple entry types", () => {
    const lines = [
      JSON.stringify({ type: "session", id: "s1", timestamp: "2024-01-01T00:00:00Z", cwd: "/tmp" }),
      JSON.stringify({
        type: "message", id: "m1", parentId: "s1", timestamp: "2024-01-01T00:00:01Z",
        message: { role: "assistant", content: "hello", provider: "anthropic", model: "claude-3", usage: { input: 100, output: 20, cacheRead: 5, cacheWrite: 10, totalTokens: 120 } },
      }),
      JSON.stringify({ type: "compaction", id: "c1", parentId: "m1", timestamp: "2024-01-01T00:00:02Z", summary: "summary", firstKeptEntryId: "m1", tokensBefore: 500 }),
      JSON.stringify({ type: "model_change", id: "mc1", parentId: "c1", timestamp: "2024-01-01T00:00:03Z", provider: "openai", modelId: "gpt-4" }),
      JSON.stringify({ type: "branch_summary", id: "b1", parentId: "mc1", timestamp: "2024-01-01T00:00:04Z", fromId: "m1", summary: "branch summary here" }),
      JSON.stringify({ type: "custom_message", id: "cm1", parentId: "b1", timestamp: "2024-01-01T00:00:05Z", customType: "status", content: "system update", display: true }),
    ];
    const content = lines.join("\n") + "\n";
    const result = parseJsonlEntries(content);

    expect(result.entries.length).toBe(6);
    expect(result.hasTrailingPartial).toBe(false);

    const expectedTypes = ["session", "message", "compaction", "model_change", "branch_summary", "custom_message"];
    for (let i = 0; i < expectedTypes.length; i++) {
      expect(result.entries[i].type).toBe(expectedTypes[i]);
    }

    expect(Buffer.byteLength(content, "utf-8")).toBe(result.bytesConsumed);
  });

  test("skips malformed lines but consumes their bytes", () => {
    const lines = [
      JSON.stringify({ type: "session", id: "s1", timestamp: "2024-01-01T00:00:00Z", cwd: "/tmp" }),
      "this is not json",
      JSON.stringify({ type: "message", id: "m1", parentId: "s1", timestamp: "2024-01-01T00:00:01Z", message: { role: "user", content: "hi" } }),
    ];
    const content = lines.join("\n") + "\n";
    const result = parseJsonlEntries(content);

    expect(result.entries.length).toBe(2);
    expect(result.entries[0].type).toBe("session");
    expect(result.entries[1].type).toBe("message");
    expect(result.hasTrailingPartial).toBe(false);
    expect(Buffer.byteLength(content, "utf-8")).toBe(result.bytesConsumed);
  });

  test("stops at incomplete trailing line (no trailing newline)", () => {
    const lines = [
      JSON.stringify({ type: "session", id: "s1", timestamp: "2024-01-01T00:00:00Z", cwd: "/tmp" }),
      JSON.stringify({ type: "message", id: "m1", parentId: "s1", timestamp: "2024-01-01T00:00:01Z", message: { role: "user", content: "hi" } }),
    ];
    const partial = JSON.stringify({ type: "compaction", id: "c1", parentId: "m1", timestamp: "2024-01-01T00:00:02Z", summary: "sum", firstKeptEntryId: "m1", tokensBefore: 500 }).slice(0, 20);
    const content = lines.join("\n") + "\n" + partial;
    const result = parseJsonlEntries(content);

    expect(result.entries.length).toBe(2);
    expect(result.hasTrailingPartial).toBe(true);

    const consumedPart = lines.join("\n") + "\n";
    expect(result.bytesConsumed).toBe(Buffer.byteLength(consumedPart, "utf-8"));
  });

  test("empty content", () => {
    const result = parseJsonlEntries("");
    expect(result.entries.length).toBe(0);
    expect(result.bytesConsumed).toBe(0);
    expect(result.hasTrailingPartial).toBe(false);
  });

  test("only a partial line", () => {
    const content = '{"type":"session","id":"s1"';
    const result = parseJsonlEntries(content);
    expect(result.entries.length).toBe(0);
    expect(result.bytesConsumed).toBe(0);
    expect(result.hasTrailingPartial).toBe(true);
  });

  test("UTF-8 multi-byte characters produce correct byte offsets", () => {
    const header = JSON.stringify({ type: "session", id: "s1", timestamp: "2024-01-01T00:00:00Z", cwd: "/tmp/日本語" });
    const msg = JSON.stringify({ type: "message", id: "m1", parentId: "s1", timestamp: "2024-01-01T00:00:01Z", message: { role: "user", content: "日本語テキスト" } });
    const content = header + "\n" + msg + "\n";
    const result = parseJsonlEntries(content);

    expect(result.entries.length).toBe(2);
    expect(result.hasTrailingPartial).toBe(false);
    expect(result.bytesConsumed).toBe(Buffer.byteLength(content, "utf-8"));
  });

  test("multiple empty lines are handled", () => {
    const content = "\n\n\n";
    const result = parseJsonlEntries(content);
    expect(result.entries.length).toBe(0);
    expect(result.hasTrailingPartial).toBe(false);
    expect(result.bytesConsumed).toBe(Buffer.byteLength(content, "utf-8"));
  });
});

describe("extractAssistantUsage", () => {
  test("extracts usage from assistant message entry", () => {
    const entry: ParsedMessageEntry = {
      type: "message",
      id: "m1",
      parentId: null,
      timestamp: "2024-01-01T00:00:00Z",
      message: {
        role: "assistant",
        content: "hi",
        provider: "anthropic",
        model: "claude-3",
        usage: { input: 100, output: 20, cacheRead: 5, cacheWrite: 10, totalTokens: 120 },
      },
    };
    const usage = extractAssistantUsage(entry);
    expect(usage).toBeDefined();
    expect(usage!.input).toBe(100);
    expect(usage!.cacheRead).toBe(5);
  });

  test("returns undefined for non-assistant message", () => {
    const entry: ParsedMessageEntry = {
      type: "message",
      id: "m1",
      parentId: null,
      timestamp: "2024-01-01T00:00:00Z",
      message: { role: "user", content: "hi" },
    };
    expect(extractAssistantUsage(entry)).toBeUndefined();
  });

  test("returns undefined for non-message entry", () => {
    const entry: ParsedEntry = { type: "compaction", id: "c1", parentId: null, timestamp: "2024-01-01T00:00:00Z", summary: "s", firstKeptEntryId: "m1", tokensBefore: 100 };
    expect(extractAssistantUsage(entry)).toBeUndefined();
  });
});

describe("detectCompactions", () => {
  test("returns compaction entries only", () => {
    const entries: ParsedEntry[] = [
      { type: "session", id: "s1", timestamp: "2024-01-01T00:00:00Z", cwd: "/tmp" },
      { type: "compaction", id: "c1", parentId: null, timestamp: "2024-01-01T00:00:00Z", summary: "s1", firstKeptEntryId: "m1", tokensBefore: 100 },
      { type: "message", id: "m1", parentId: null, timestamp: "2024-01-01T00:00:00Z", message: { role: "user", content: "hi" } },
      { type: "compaction", id: "c2", parentId: null, timestamp: "2024-01-01T00:00:00Z", summary: "s2", firstKeptEntryId: "m2", tokensBefore: 200 },
    ];
    const compactions = detectCompactions(entries);
    expect(compactions.length).toBe(2);
    expect(compactions[0].id).toBe("c1");
    expect(compactions[1].id).toBe("c2");
  });

  test("returns empty array when no compactions", () => {
    const entries: ParsedEntry[] = [
      { type: "message", id: "m1", parentId: null, timestamp: "2024-01-01T00:00:00Z", message: { role: "user", content: "hi" } },
    ];
    expect(detectCompactions(entries).length).toBe(0);
  });
});
