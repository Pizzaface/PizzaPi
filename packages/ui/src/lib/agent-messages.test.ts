import { describe, expect, test } from "bun:test";
import { extractAgentMessages } from "./agent-messages";
import type { RelayMessage } from "@/components/session-viewer/types";

// ── helpers ─────────────────────────────────────────────────────────────────

function msg(overrides: Partial<RelayMessage> & { key: string; role: string }): RelayMessage {
  return { content: null, ...overrides };
}

const CURRENT = "session-current";

// ── extractAgentMessages ────────────────────────────────────────────────────

describe("extractAgentMessages", () => {
  test("returns empty array for messages with no inter-agent tools", () => {
    const messages = [
      msg({ key: "u1", role: "user", content: "hello" }),
      msg({ key: "a1", role: "assistant", content: [{ type: "text", text: "hi" }] }),
    ];
    expect(extractAgentMessages(messages, CURRENT)).toEqual([]);
  });

  test("extracts sent messages from send_message tool results", () => {
    const messages = [
      msg({
        key: "t1",
        role: "tool",
        toolName: "send_message",
        toolInput: { sessionId: "target-1", message: "Hello sub-agent" },
        content: "Message delivered to session target-1",
        timestamp: 1000,
      }),
    ];

    const result = extractAgentMessages(messages, CURRENT);
    expect(result).toHaveLength(1);
    expect(result[0].direction).toBe("sent");
    expect(result[0].fromSessionId).toBe(CURRENT);
    expect(result[0].toSessionId).toBe("target-1");
    expect(result[0].message).toBe("Hello sub-agent");
    expect(result[0].isCompletion).toBe(false);
  });

  test("extracts received messages from wait_for_message results", () => {
    const messages = [
      msg({
        key: "t2",
        role: "tool",
        toolName: "wait_for_message",
        toolInput: { fromSessionId: "child-1" },
        content: "Message from session child-1:\n\nHere is my result",
        timestamp: 2000,
      }),
    ];

    const result = extractAgentMessages(messages, CURRENT);
    expect(result).toHaveLength(1);
    expect(result[0].direction).toBe("received");
    expect(result[0].fromSessionId).toBe("child-1");
    expect(result[0].toSessionId).toBe(CURRENT);
    expect(result[0].message).toBe("Here is my result");
  });

  test("skips wait_for_message that timed out", () => {
    const messages = [
      msg({
        key: "t3",
        role: "tool",
        toolName: "wait_for_message",
        toolInput: { fromSessionId: "child-1", timeout: 30 },
        content: "No message received within 30 seconds.",
        timestamp: 3000,
      }),
    ];

    const result = extractAgentMessages(messages, CURRENT);
    expect(result).toEqual([]);
  });

  test("extracts messages from check_messages results", () => {
    const messages = [
      msg({
        key: "t4",
        role: "tool",
        toolName: "check_messages",
        toolInput: {},
        content: "2 message(s) received:\n\n[child-a] First message\n\n[child-b] Second message",
        timestamp: 4000,
      }),
    ];

    const result = extractAgentMessages(messages, CURRENT);
    expect(result).toHaveLength(2);
    expect(result[0].fromSessionId).toBe("child-a");
    expect(result[0].message).toBe("First message");
    expect(result[0].direction).toBe("received");
    expect(result[1].fromSessionId).toBe("child-b");
    expect(result[1].message).toBe("Second message");
  });

  test("skips empty check_messages results", () => {
    const messages = [
      msg({
        key: "t5",
        role: "tool",
        toolName: "check_messages",
        toolInput: {},
        content: "No pending messages.",
        timestamp: 5000,
      }),
    ];

    const result = extractAgentMessages(messages, CURRENT);
    expect(result).toEqual([]);
  });

  test("detects completion messages", () => {
    const messages = [
      msg({
        key: "t6",
        role: "tool",
        toolName: "send_message",
        toolInput: { sessionId: "parent-1", message: "DONE: Task completed successfully" },
        content: "Message delivered",
        timestamp: 6000,
      }),
      msg({
        key: "t7",
        role: "tool",
        toolName: "wait_for_message",
        toolInput: {},
        content: "Message from session child-1:\n\nRESULT: All tests pass",
        timestamp: 7000,
      }),
    ];

    const result = extractAgentMessages(messages, CURRENT);
    expect(result).toHaveLength(2);
    expect(result[0].isCompletion).toBe(true);
    expect(result[1].isCompletion).toBe(true);
  });

  test("handles MCP-prefixed tool names", () => {
    const messages = [
      msg({
        key: "t8",
        role: "tool",
        toolName: "mcp.send_message",
        toolInput: { sessionId: "target-2", message: "Via MCP" },
        content: "Message delivered",
        timestamp: 8000,
      }),
    ];

    const result = extractAgentMessages(messages, CURRENT);
    expect(result).toHaveLength(1);
    expect(result[0].message).toBe("Via MCP");
  });

  test("sorts messages chronologically", () => {
    const messages = [
      msg({
        key: "t10",
        role: "tool",
        toolName: "send_message",
        toolInput: { sessionId: "a", message: "Second" },
        content: "ok",
        timestamp: 2000,
      }),
      msg({
        key: "t9",
        role: "tool",
        toolName: "send_message",
        toolInput: { sessionId: "b", message: "First" },
        content: "ok",
        timestamp: 1000,
      }),
    ];

    const result = extractAgentMessages(messages, CURRENT);
    expect(result).toHaveLength(2);
    expect(result[0].message).toBe("First");
    expect(result[1].message).toBe("Second");
  });

  test("skips send_message with empty message", () => {
    const messages = [
      msg({
        key: "t11",
        role: "tool",
        toolName: "send_message",
        toolInput: { sessionId: "target", message: "" },
        content: "ok",
        timestamp: 11000,
      }),
    ];

    const result = extractAgentMessages(messages, CURRENT);
    expect(result).toEqual([]);
  });

  test("handles toolResult role (not just tool)", () => {
    const messages = [
      msg({
        key: "t12",
        role: "toolResult",
        toolName: "send_message",
        toolInput: { sessionId: "target-3", message: "From toolResult" },
        content: "Delivered",
        timestamp: 12000,
      }),
    ];

    const result = extractAgentMessages(messages, CURRENT);
    expect(result).toHaveLength(1);
    expect(result[0].message).toBe("From toolResult");
  });

  test("handles content as array of text blocks", () => {
    const messages = [
      msg({
        key: "t13",
        role: "tool",
        toolName: "wait_for_message",
        toolInput: {},
        content: [{ type: "text", text: "Message from session xyz:\n\nHello world" }],
        timestamp: 13000,
      }),
    ];

    const result = extractAgentMessages(messages, CURRENT);
    expect(result).toHaveLength(1);
    expect(result[0].message).toBe("Hello world");
  });
});
