import { describe, expect, test } from "bun:test";
import {
  toRelayMessage,
  deduplicateMessages,
  normalizeMessages,
  normalizeModel,
  normalizeSessionName,
  augmentThinkingDurations,
  normalizeModelList,
} from "./message-helpers";
import type { RelayMessage } from "@/components/session-viewer/types";

// ── helpers ───────────────────────────────────────────────────────────────────

function assistantMsg(
  overrides: Partial<RelayMessage> & { key: string }
): RelayMessage {
  return { role: "assistant", content: null, ...overrides };
}

// ── toRelayMessage ────────────────────────────────────────────────────────────

describe("toRelayMessage", () => {
  test("returns null for null input", () => {
    expect(toRelayMessage(null, "fallback")).toBeNull();
  });

  test("returns null for non-object input", () => {
    expect(toRelayMessage("string", "fallback")).toBeNull();
    expect(toRelayMessage(42, "fallback")).toBeNull();
    expect(toRelayMessage(undefined, "fallback")).toBeNull();
  });

  test("uses id-based key when id field is present", () => {
    const result = toRelayMessage({ role: "user", id: "abc123" }, "fallback");
    expect(result?.key).toBe("user:id:abc123");
  });

  test("uses toolCallId-based key when id is absent but toolCallId is present", () => {
    const result = toRelayMessage({ role: "tool_result", toolCallId: "tc1" }, "fallback");
    expect(result?.key).toBe("tool_result:tool:tc1");
  });

  test("uses timestamp-based key when id and toolCallId are absent", () => {
    const result = toRelayMessage({ role: "assistant", timestamp: 1234 }, "fallback");
    expect(result?.key).toBe("assistant:ts:1234");
  });

  test("uses fallback key when no id, toolCallId, or timestamp", () => {
    const result = toRelayMessage({ role: "user" }, "snap-0");
    expect(result?.key).toBe("user:fallback:snap-0");
  });

  test("defaults role to 'message' if role is missing or non-string", () => {
    const result = toRelayMessage({ role: 99 }, "x");
    expect(result?.role).toBe("message");
  });

  test("sets isError=true when stopReason is 'error'", () => {
    const result = toRelayMessage({ role: "assistant", stopReason: "error" }, "x");
    expect(result?.isError).toBe(true);
    expect(result?.stopReason).toBe("error");
  });

  test("sets isError=true when isError field is true", () => {
    const result = toRelayMessage({ role: "tool_result", isError: true }, "x");
    expect(result?.isError).toBe(true);
  });

  test("preserves summary and tokensBefore for compaction messages", () => {
    const result = toRelayMessage(
      { role: "compactionSummary", summary: "Compacted context", tokensBefore: 5000 },
      "x"
    );
    expect(result?.summary).toBe("Compacted context");
    expect(result?.tokensBefore).toBe(5000);
  });

  test("preserves structured details field", () => {
    const details = { subagentId: "s1", status: "done" };
    const result = toRelayMessage({ role: "tool_result", details }, "x");
    expect(result?.details).toEqual(details);
  });

  test("omits toolCallId from output when input toolCallId is empty string", () => {
    const result = toRelayMessage({ role: "user", toolCallId: "" }, "x");
    expect(result?.toolCallId).toBeUndefined();
  });

  test("accepts modelId as fallback for id field in returned message", () => {
    // toRelayMessage doesn't use modelId — verify it doesn't leak
    const result = toRelayMessage({ role: "user", modelId: "gpt-4" }, "x");
    expect(result?.role).toBe("user");
  });
});

// ── deduplicateMessages ───────────────────────────────────────────────────────

describe("deduplicateMessages", () => {
  test("returns empty array unchanged", () => {
    expect(deduplicateMessages([])).toEqual([]);
  });

  test("returns same reference when nothing is dropped", () => {
    const msgs: RelayMessage[] = [
      assistantMsg({ key: "a1", timestamp: 100 }),
    ];
    const result = deduplicateMessages(msgs);
    expect(result).toBe(msgs); // same reference = nothing filtered
  });

  test("drops no-timestamp assistant immediately followed by timestamped assistant", () => {
    const partial = assistantMsg({ key: "partial" }); // no timestamp
    const final = assistantMsg({ key: "final", timestamp: 200 });
    const result = deduplicateMessages([partial, final]);
    expect(result).toHaveLength(1);
    expect(result[0].key).toBe("final");
  });

  test("keeps both when no-timestamp assistant is NOT followed by a timestamped one", () => {
    const a = assistantMsg({ key: "a" });
    const b = assistantMsg({ key: "b" });
    const result = deduplicateMessages([a, b]);
    expect(result).toHaveLength(2);
  });

  test("drops partial when it shares a toolCallId with a later timestamped message", () => {
    const partial = assistantMsg({
      key: "partial",
      content: [{ type: "toolCall", toolCallId: "tc1" }],
    });
    const final = assistantMsg({
      key: "final",
      timestamp: 300,
      content: [{ type: "toolCall", toolCallId: "tc1" }],
    });
    // Another message in between to test the extended heuristic
    const other: RelayMessage = { key: "user1", role: "user", content: null };
    const result = deduplicateMessages([partial, other, final]);
    expect(result.map((m) => m.key)).toEqual(["user1", "final"]);
  });

  test("drops text-only partial that is a prefix of a later timestamped assistant", () => {
    const partial = assistantMsg({
      key: "partial",
      content: [{ type: "text", text: "Hello wor" }],
    });
    const final = assistantMsg({
      key: "final",
      timestamp: 400,
      content: [{ type: "text", text: "Hello world!" }],
    });
    const result = deduplicateMessages([partial, final]);
    expect(result.map((m) => m.key)).toEqual(["final"]);
  });

  test("keeps text partial when it is NOT a prefix of any later timestamped message (with intervening message)", () => {
    // Note: the "immediately followed" heuristic fires for [partial, timestamped],
    // so we need an intervening non-assistant message to bypass it.
    const partial = assistantMsg({
      key: "partial",
      content: [{ type: "text", text: "Something else" }],
    });
    const user: RelayMessage = { key: "u1", role: "user", content: null };
    const final = assistantMsg({
      key: "final",
      timestamp: 500,
      content: [{ type: "text", text: "Completely different" }],
    });
    const result = deduplicateMessages([partial, user, final]);
    expect(result).toHaveLength(3); // partial kept — no toolCallId overlap, not a text prefix
  });

  test("preserves non-assistant messages regardless", () => {
    const user: RelayMessage = { key: "u1", role: "user", content: null };
    const tool: RelayMessage = { key: "tr1", role: "tool_result", content: null };
    const result = deduplicateMessages([user, tool]);
    expect(result).toHaveLength(2);
  });
});

// ── normalizeMessages ─────────────────────────────────────────────────────────

describe("normalizeMessages", () => {
  test("filters out nulls from malformed raw messages", () => {
    const raw: unknown[] = [null, undefined, 42, { role: "user" }];
    const result = normalizeMessages(raw);
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe("user");
  });

  test("applies keyOffset to fallback keys", () => {
    const raw: unknown[] = [{ role: "user" }, { role: "assistant" }];
    const result = normalizeMessages(raw, 10);
    expect(result[0].key).toBe("user:fallback:snapshot-10");
    expect(result[1].key).toBe("assistant:fallback:snapshot-11");
  });

  test("deduplicates after converting", () => {
    const raw: unknown[] = [
      { role: "assistant" }, // no timestamp — partial
      { role: "assistant", timestamp: 1 }, // timestamped final
    ];
    const result = normalizeMessages(raw);
    expect(result).toHaveLength(1);
    expect(result[0].timestamp).toBe(1);
  });
});

// ── normalizeModel ────────────────────────────────────────────────────────────

describe("normalizeModel", () => {
  test("returns null for null/non-object input", () => {
    expect(normalizeModel(null)).toBeNull();
    expect(normalizeModel("string")).toBeNull();
    expect(normalizeModel(42)).toBeNull();
  });

  test("returns null when provider is missing", () => {
    expect(normalizeModel({ id: "gpt-4" })).toBeNull();
  });

  test("returns null when both id and modelId are missing", () => {
    expect(normalizeModel({ provider: "openai" })).toBeNull();
  });

  test("parses standard availableModels shape (id field)", () => {
    const result = normalizeModel({ provider: "openai", id: "gpt-4o", name: "GPT-4o" });
    expect(result).toEqual({
      provider: "openai",
      id: "gpt-4o",
      name: "GPT-4o",
      reasoning: undefined,
      contextWindow: undefined,
    });
  });

  test("parses buildSessionContext shape (modelId field)", () => {
    const result = normalizeModel({ provider: "anthropic", modelId: "claude-opus-4" });
    expect(result).toEqual({
      provider: "anthropic",
      id: "claude-opus-4",
      name: undefined,
      reasoning: undefined,
      contextWindow: undefined,
    });
  });

  test("prefers id over modelId when both present", () => {
    const result = normalizeModel({ provider: "openai", id: "gpt-4o", modelId: "gpt-4" });
    expect(result?.id).toBe("gpt-4o");
  });

  test("trims whitespace from provider and id", () => {
    const result = normalizeModel({ provider: "  openai  ", id: "  gpt-4  " });
    expect(result?.provider).toBe("openai");
    expect(result?.id).toBe("gpt-4");
  });

  test("preserves optional fields: reasoning, contextWindow", () => {
    const result = normalizeModel({
      provider: "anthropic",
      id: "claude-3-7-sonnet",
      reasoning: true,
      contextWindow: 200000,
    });
    expect(result?.reasoning).toBe(true);
    expect(result?.contextWindow).toBe(200000);
  });
});

// ── normalizeSessionName ──────────────────────────────────────────────────────

describe("normalizeSessionName", () => {
  test("returns null for non-string input", () => {
    expect(normalizeSessionName(null)).toBeNull();
    expect(normalizeSessionName(42)).toBeNull();
    expect(normalizeSessionName(undefined)).toBeNull();
  });

  test("returns null for empty string", () => {
    expect(normalizeSessionName("")).toBeNull();
  });

  test("returns null for whitespace-only string", () => {
    expect(normalizeSessionName("   ")).toBeNull();
  });

  test("returns trimmed name for valid string", () => {
    expect(normalizeSessionName("  My Session  ")).toBe("My Session");
  });

  test("returns string as-is when no surrounding whitespace", () => {
    expect(normalizeSessionName("Session Name")).toBe("Session Name");
  });
});

// ── augmentThinkingDurations ──────────────────────────────────────────────────

describe("augmentThinkingDurations", () => {
  test("returns original message when durations map is empty", () => {
    const msg = { role: "assistant", content: [{ type: "thinking", text: "..." }] };
    const result = augmentThinkingDurations(msg, new Map());
    expect(result).toBe(msg); // same reference
  });

  test("returns original message for null/non-object input", () => {
    const durations = new Map([[0, 3.5]]);
    expect(augmentThinkingDurations(null, durations)).toBeNull();
    expect(augmentThinkingDurations("string", durations)).toBe("string");
  });

  test("injects durationSeconds into thinking block at matching index", () => {
    const msg = {
      role: "assistant",
      content: [
        { type: "thinking", text: "pondering..." },
        { type: "text", text: "answer" },
      ],
    };
    const durations = new Map([[0, 2.5]]);
    const result = augmentThinkingDurations(msg, durations) as typeof msg;
    expect((result.content[0] as Record<string, unknown>).durationSeconds).toBe(2.5);
    // Non-thinking block unchanged
    expect((result.content[1] as Record<string, unknown>).durationSeconds).toBeUndefined();
  });

  test("does NOT overwrite existing durationSeconds", () => {
    const msg = {
      role: "assistant",
      content: [{ type: "thinking", text: "...", durationSeconds: 1.0 }],
    };
    const durations = new Map([[0, 9.9]]);
    const result = augmentThinkingDurations(msg, durations) as typeof msg;
    expect((result.content[0] as Record<string, unknown>).durationSeconds).toBe(1.0);
  });

  test("returns new object reference when content changed", () => {
    const msg = {
      role: "assistant",
      content: [{ type: "thinking", text: "..." }],
    };
    const durations = new Map([[0, 5.0]]);
    const result = augmentThinkingDurations(msg, durations);
    expect(result).not.toBe(msg); // new object
  });

  test("handles message with no content array", () => {
    const msg = { role: "assistant", content: "string-content" };
    const durations = new Map([[0, 1.0]]);
    const result = augmentThinkingDurations(msg, durations);
    expect(result).toBe(msg); // unchanged when content isn't array
  });
});

// ── normalizeModelList ────────────────────────────────────────────────────────

describe("normalizeModelList", () => {
  test("returns empty array for empty input", () => {
    expect(normalizeModelList([])).toEqual([]);
  });

  test("filters out invalid model entries", () => {
    const result = normalizeModelList([null, undefined, "string", 42, { provider: "openai" }]);
    expect(result).toHaveLength(0);
  });

  test("deduplicates models with same provider/id", () => {
    const models: unknown[] = [
      { provider: "openai", id: "gpt-4o" },
      { provider: "openai", id: "gpt-4o" }, // duplicate
      { provider: "anthropic", id: "claude-3" },
    ];
    const result = normalizeModelList(models);
    expect(result).toHaveLength(2);
  });

  test("sorts by provider then id", () => {
    const models: unknown[] = [
      { provider: "openai", id: "gpt-4o" },
      { provider: "anthropic", id: "claude-opus-4" },
      { provider: "anthropic", id: "claude-haiku" },
    ];
    const result = normalizeModelList(models);
    expect(result.map((m) => `${m.provider}/${m.id}`)).toEqual([
      "anthropic/claude-haiku",
      "anthropic/claude-opus-4",
      "openai/gpt-4o",
    ]);
  });

  test("keeps last entry wins when deduplicating (map behavior)", () => {
    const models: unknown[] = [
      { provider: "openai", id: "gpt-4o", name: "First" },
      { provider: "openai", id: "gpt-4o", name: "Second" }, // overwrites
    ];
    const result = normalizeModelList(models);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("Second");
  });
});
