import { describe, expect, test } from "bun:test";
import { renderHook } from "@testing-library/react";

import { useMessageProcessor } from "./message-processor";
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
    expect(result.current.renderedMessages).toHaveLength(50);
    expect(result.current.hasMore).toBe(true);
    expect(result.current.renderedMessages[0]?.key.startsWith("m-550")).toBe(true);
    expect(result.current.renderedMessages.at(-1)?.key.startsWith("m-599")).toBe(true);
  });
});
