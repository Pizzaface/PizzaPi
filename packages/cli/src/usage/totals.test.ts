import { describe, expect, test } from "bun:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { collectSessionTokenUsage } from "./totals.js";

const usage = (input: number, output: number, cacheRead = 0, cacheWrite = 0, cost = 0) => ({
  input,
  output,
  cacheRead,
  cacheWrite,
  totalTokens: input + output + cacheRead + cacheWrite,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
});

describe("collectSessionTokenUsage", () => {
  test("counts assistant, nested tool-result, standalone usage, and summary costs once", () => {
    const entries = [
      {
        type: "message",
        id: "assistant-1",
        parentId: null,
        timestamp: "2026-03-23T12:00:00Z",
        message: {
          role: "assistant",
          content: [],
          api: "messages",
          provider: "anthropic",
          model: "claude-opus",
          usage: usage(10, 5, 1, 0, 0.01),
          stopReason: "stop",
          timestamp: 0,
        },
      },
      {
        type: "message",
        id: "tool-1",
        parentId: "assistant-1",
        timestamp: "2026-03-23T12:00:01Z",
        message: {
          role: "toolResult",
          toolCallId: "tc1",
          toolName: "codemode",
          content: [],
          isError: false,
          usage: usage(7, 3, 2, 1, 0.004),
          timestamp: 1,
        },
      },
      {
        type: "usage",
        id: "usage-1",
        parentId: "tool-1",
        timestamp: "2026-03-23T12:00:02Z",
        kind: "cache_warm",
        provider: "anthropic",
        model: "claude-opus",
        usage: usage(0, 0, 4, 0, 0.002),
      },
      {
        type: "branch_summary",
        id: "summary-1",
        parentId: "usage-1",
        timestamp: "2026-03-23T12:00:03Z",
        fromId: "assistant-1",
        summary: "summary",
        usage: usage(2, 1, 0, 0, -1),
      },
    ] satisfies SessionEntry[];

    expect(collectSessionTokenUsage(entries)).toEqual({
      input: 19,
      output: 9,
      cacheRead: 7,
      cacheWrite: 1,
      cost: 0.016,
    });
  });
});
