import { describe, expect, test } from "bun:test";
import { renderHook } from "@testing-library/react";

import { getExportMessages, useMessageProcessor } from "./message-processor";
import { exportToMarkdown } from "@/lib/export-markdown";
import type { RelayMessage } from "./types";

function textMessage(index: number): RelayMessage {
  return {
    key: `m-${index}`,
    role: "assistant",
    timestamp: index,
    content: [{ type: "text", text: `message ${index}` }],
  };
}

describe("useMessageProcessor", () => {
  test("limits transcript processing to the visible tail window", () => {
    const messages = Array.from({ length: 600 }, (_, index) => textMessage(index));

    const { result } = renderHook(() => useMessageProcessor(messages, "session-1"));

    expect(result.current.visibleMessages).toHaveLength(50);
    expect(result.current.hasMore).toBe(true);
    expect(result.current.visibleMessages[0]?.key.startsWith("m-550")).toBe(true);
    expect(result.current.visibleMessages.at(-1)?.key.startsWith("m-599")).toBe(true);
  });

  test("orders messages chronologically while preserving ties", () => {
    const sorted = getExportMessages([
      textMessage(2),
      { ...textMessage(1), key: "first-tie" },
      { ...textMessage(1), key: "second-tie" },
      { ...textMessage(3), timestamp: undefined },
    ]);
    expect(sorted.map((message) => message.key)).toEqual([
      "first-tie:assistant:0", "second-tie:assistant:0", "m-2:assistant:0", "m-3:assistant:0",
    ]);
  });

  test("provides grouped tool input to the SessionViewer export path", () => {
    const messages: RelayMessage[] = [
      { key: "assistant", role: "assistant", timestamp: 1, content: [
        { type: "toolCall", name: "bash", id: "call-1", arguments: { command: "echo grouped" } },
      ] },
      { key: "result", role: "toolResult", toolName: "bash", toolCallId: "call-1", timestamp: 2, content: "ok" },
    ];
    expect(exportToMarkdown(messages)).not.toContain("**Input:**");
    expect(exportToMarkdown(getExportMessages(messages))).toContain("**Input:**");
  });

  test("expands backward when a raw tail contains too few visible messages", () => {
    const messages = Array.from({ length: 600 }, (_, index) => ({
      ...textMessage(index),
      content: index % 10 === 0 ? [{ type: "text", text: `message ${index}` }] : [],
    }));
    const { result } = renderHook(() => useMessageProcessor(messages, "session-1"));
    expect(result.current.visibleMessages).toHaveLength(50);
    expect(result.current.visibleMessages[0]?.key).toBe("m-100:assistant:0");
    expect(result.current.hasMore).toBe(true);
  });

  test("extends grouping lookbehind to include a tool call before the window", () => {
    const messages = Array.from({ length: 80 }, (_, index) => textMessage(index));
    messages[5] = {
      key: "call", role: "assistant", timestamp: 5,
      content: [{ type: "toolCall", name: "bash", id: "call-1", arguments: { command: "echo hi" } }],
    };
    messages[75] = { key: "result", role: "toolResult", toolName: "bash", toolCallId: "call-1", timestamp: 75, content: "done" };

    const { result } = renderHook(() => useMessageProcessor(messages, "session-1"));
    expect(result.current.visibleMessages.some((message) => message.key === "result")).toBe(false);
    expect(result.current.visibleMessages.find((message) => message.key === "pending-tool:call-1")?.toolInput)
      .toEqual({ command: "echo hi" });
  });
});
