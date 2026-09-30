import { describe, expect, test } from "bun:test";
import type { RelayMessage } from "@/components/SessionViewer";
import {
  extractTextContent,
  mergeStreamingPartials,
  mergeToolStreamPartials,
  upsertRelayMessage,
} from "./relay-message-merge";

const msg = (key: string, extra: Partial<RelayMessage> = {}): RelayMessage => ({
  key,
  role: "assistant",
  content: key,
  ...extra,
});

describe("extractTextContent", () => {
  test("returns string content untouched (not trimmed)", () => {
    expect(extractTextContent("  hi  ")).toBe("  hi  ");
  });

  test("joins only text blocks from array content", () => {
    expect(extractTextContent([
      { type: "text", text: "a" },
      { type: "image", data: "x" },
      { type: "text", text: "b" },
      null,
      { type: "text", text: 3 },
    ])).toBe("ab");
  });

  test("returns empty string for other shapes", () => {
    expect(extractTextContent(undefined)).toBe("");
    expect(extractTextContent({ text: "x" })).toBe("");
  });
});

describe("upsertRelayMessage", () => {
  test("appends a new key", () => {
    const prev = [msg("a")];
    const next = upsertRelayMessage(prev, msg("b"), null);
    expect(next.map((m) => m.key)).toEqual(["a", "b"]);
    expect(prev).toHaveLength(1);
  });

  test("replaces an existing key in place without mutating prev", () => {
    const prev = [msg("a"), msg("b")];
    const replacement = msg("a", { content: "new" });
    const next = upsertRelayMessage(prev, replacement, null);
    expect(next).not.toBe(prev);
    expect(next[0]).toBe(replacement);
    expect(prev[0].content).toBe("a");
  });

  test("evicts the streaming partial before appending the final message", () => {
    const prev = [msg("user:1", { role: "user" }), msg("assistant:fallback:x")];
    const next = upsertRelayMessage(prev, msg("assistant:ts:5"), "assistant:fallback:x");
    expect(next.map((m) => m.key)).toEqual(["user:1", "assistant:ts:5"]);
  });

  test("eviction of a missing partial is a no-op", () => {
    const prev = [msg("a")];
    const next = upsertRelayMessage(prev, msg("b"), "missing");
    expect(next.map((m) => m.key)).toEqual(["a", "b"]);
  });

  test("server-echoed user message replaces a matching optimistic steer message", () => {
    const steer = msg("user:steer:1", { role: "user", content: "go left" });
    const prev = [msg("a"), steer];
    const echoed = msg("user:ts:9", { role: "user", content: [{ type: "text", text: " go left " }] });
    const next = upsertRelayMessage(prev, echoed, null);
    expect(next.map((m) => m.key)).toEqual(["a", "user:ts:9"]);
  });

  test("user message with different text does not replace the steer message", () => {
    const prev = [msg("user:steer:1", { role: "user", content: "go left" })];
    const next = upsertRelayMessage(prev, msg("user:ts:9", { role: "user", content: "go right" }), null);
    expect(next).toHaveLength(2);
  });
});

describe("mergeStreamingPartials", () => {
  test("returns prev unchanged when nothing converts", () => {
    const prev = [msg("a")];
    expect(mergeStreamingPartials(prev, [{ raw: null, key: "x" }])).toBe(prev);
  });

  test("appends a partial and updates it in place on the next flush", () => {
    const first = mergeStreamingPartials([], [{ raw: { role: "assistant", id: "m1", content: "he" }, key: "k" }]);
    expect(first).toHaveLength(1);
    expect(first[0].key).toBe("assistant:id:m1");
    const second = mergeStreamingPartials(first, [{ raw: { role: "assistant", id: "m1", content: "hello" }, key: "k" }]);
    expect(second).toHaveLength(1);
    expect(second[0].content).toBe("hello");
  });

  test("a fallback-keyed partial adopts the key of a trailing untimestamped partial of the same role", () => {
    const prev = [msg("user:ts:1", { role: "user", timestamp: 1 }), msg("assistant:id:old")];
    const next = mergeStreamingPartials(prev, [{ raw: { role: "assistant", content: "more" }, key: "stream" }]);
    expect(next).toHaveLength(2);
    expect(next[1].key).toBe("assistant:id:old");
    expect(next[1].content).toBe("more");
  });

  test("never adopts a completed (timestamped) trailing message", () => {
    const prev = [msg("assistant:ts:5", { timestamp: 5 })];
    const next = mergeStreamingPartials(prev, [{ raw: { role: "assistant", content: "new turn" }, key: "stream" }]);
    expect(next).toHaveLength(2);
    expect(next[0].content).toBe("assistant:ts:5");
  });

  test("never adopts an error message", () => {
    const prev = [msg("assistant:id:e", { isError: true })];
    const next = mergeStreamingPartials(prev, [{ raw: { role: "assistant", content: "x" }, key: "stream" }]);
    expect(next).toHaveLength(2);
  });
});

describe("mergeToolStreamPartials", () => {
  test("upserts synthetic tool results by toolCallId", () => {
    const partial = (text: string) => ({ role: "toolResult", toolCallId: "t1", content: text });
    const first = mergeToolStreamPartials([], [partial("a")]);
    expect(first.map((m) => m.key)).toEqual(["tool-call:t1"]);
    const second = mergeToolStreamPartials(first, [partial("ab"), { role: "toolResult", toolCallId: "t2", content: "z" }]);
    expect(second.map((m) => m.key)).toEqual(["tool-call:t1", "tool-call:t2"]);
    expect(second[0].content).toBe("ab");
  });

  test("returns prev when every partial is invalid", () => {
    const prev = [msg("a")];
    expect(mergeToolStreamPartials(prev, [undefined, 42])).toBe(prev);
  });
});
