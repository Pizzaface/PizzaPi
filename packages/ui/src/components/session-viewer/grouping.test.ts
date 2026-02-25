import { describe, expect, test } from "bun:test";
import {
    groupToolExecutionMessages,
    groupSubAgentConversations,
} from "./grouping";
import type { RelayMessage } from "./types";

// ── helpers ─────────────────────────────────────────────────────────────────

function msg(overrides: Partial<RelayMessage> & { key: string; role: string }): RelayMessage {
    return { content: null, ...overrides };
}

// ── groupToolExecutionMessages ──────────────────────────────────────────────

describe("groupToolExecutionMessages", () => {
    test("passes through user messages unchanged", () => {
        const messages: RelayMessage[] = [
            msg({ key: "u1", role: "user", content: [{ type: "text", text: "hello" }] }),
        ];
        const result = groupToolExecutionMessages(messages);
        expect(result).toHaveLength(1);
        expect(result[0].role).toBe("user");
    });

    test("passes through assistant-only messages (no tool calls)", () => {
        const messages: RelayMessage[] = [
            msg({
                key: "a1",
                role: "assistant",
                content: [{ type: "text", text: "I'll help you" }],
            }),
        ];
        const result = groupToolExecutionMessages(messages);
        expect(result).toHaveLength(1);
        expect(result[0].key).toBe("a1:assistant:0");
    });

    test("splits assistant message with tool call into text + tool item", () => {
        const messages: RelayMessage[] = [
            msg({
                key: "a1",
                role: "assistant",
                content: [
                    { type: "text", text: "Let me check" },
                    { type: "toolCall", name: "bash", id: "tc1", arguments: { command: "ls" } },
                ],
            }),
        ];
        const result = groupToolExecutionMessages(messages);
        // Should have assistant text part + tool pending item
        expect(result.length).toBeGreaterThanOrEqual(2);
        expect(result[0].role).toBe("assistant");
        expect(result[1].role).toBe("tool");
        expect(result[1].toolName).toBe("bash");
    });

    test("merges toolResult into matching tool call by toolCallId", () => {
        const messages: RelayMessage[] = [
            msg({
                key: "a1",
                role: "assistant",
                content: [
                    { type: "toolCall", name: "bash", id: "tc1", arguments: { command: "ls" } },
                ],
            }),
            msg({
                key: "r1",
                role: "toolResult",
                toolCallId: "tc1",
                toolName: "bash",
                content: [{ type: "text", text: "file1.txt\nfile2.txt" }],
            }),
        ];
        const result = groupToolExecutionMessages(messages);
        const toolItem = result.find((m) => m.role === "tool");
        expect(toolItem).toBeDefined();
        expect(toolItem!.toolCallId).toBe("tc1");
        expect(toolItem!.content).toBeTruthy();
    });

    test("handles multiple tool calls in one assistant message", () => {
        const messages: RelayMessage[] = [
            msg({
                key: "a1",
                role: "assistant",
                content: [
                    { type: "toolCall", name: "bash", id: "tc1", arguments: { command: "ls" } },
                    { type: "toolCall", name: "read_file", id: "tc2", arguments: { path: "/a.ts" } },
                ],
            }),
            msg({ key: "r1", role: "toolResult", toolCallId: "tc1", content: [{ type: "text", text: "output1" }] }),
            msg({ key: "r2", role: "toolResult", toolCallId: "tc2", content: [{ type: "text", text: "output2" }] }),
        ];
        const result = groupToolExecutionMessages(messages);
        const tools = result.filter((m) => m.role === "tool");
        expect(tools).toHaveLength(2);
    });

    test("deduplicates assistant messages with same toolCallIds", () => {
        const messages: RelayMessage[] = [
            msg({
                key: "a1-partial",
                role: "assistant",
                content: [
                    { type: "toolCall", name: "bash", id: "tc1", arguments: { command: "ls" } },
                ],
            }),
            msg({
                key: "a1-final",
                role: "assistant",
                content: [
                    { type: "toolCall", name: "bash", id: "tc1", arguments: { command: "ls -la" } },
                ],
                timestamp: 12345,
            }),
            msg({ key: "r1", role: "toolResult", toolCallId: "tc1", content: [{ type: "text", text: "output" }] }),
        ];
        const result = groupToolExecutionMessages(messages);
        // Only the last assistant version should produce a tool item
        const tools = result.filter((m) => m.role === "tool");
        expect(tools).toHaveLength(1);
    });

    test("attaches thinking block to following tool call", () => {
        const messages: RelayMessage[] = [
            msg({
                key: "a1",
                role: "assistant",
                content: [
                    { type: "thinking", thinking: "I should run a command", durationSeconds: 2 },
                    { type: "toolCall", name: "bash", id: "tc1", arguments: { command: "ls" } },
                ],
            }),
        ];
        const result = groupToolExecutionMessages(messages);
        const toolItem = result.find((m) => m.role === "tool");
        expect(toolItem).toBeDefined();
        expect(toolItem!.thinking).toBe("I should run a command");
        expect(toolItem!.thinkingDuration).toBe(2);
    });

    test("keeps thinking block as separate assistant part when not before tool", () => {
        const messages: RelayMessage[] = [
            msg({
                key: "a1",
                role: "assistant",
                content: [
                    { type: "thinking", thinking: "Let me think..." },
                    { type: "text", text: "Here's my answer" },
                ],
            }),
        ];
        const result = groupToolExecutionMessages(messages);
        // Both thinking and text should be in the same assistant part
        expect(result).toHaveLength(1);
        expect(result[0].role).toBe("assistant");
    });

    test("handles empty message list", () => {
        expect(groupToolExecutionMessages([])).toEqual([]);
    });

    test("preserves message order for interleaved user/assistant", () => {
        const messages: RelayMessage[] = [
            msg({ key: "u1", role: "user", content: [{ type: "text", text: "q1" }] }),
            msg({ key: "a1", role: "assistant", content: [{ type: "text", text: "a1" }] }),
            msg({ key: "u2", role: "user", content: [{ type: "text", text: "q2" }] }),
            msg({ key: "a2", role: "assistant", content: [{ type: "text", text: "a2" }] }),
        ];
        const result = groupToolExecutionMessages(messages);
        expect(result).toHaveLength(4);
        expect(result[0].role).toBe("user");
        expect(result[1].role).toBe("assistant");
        expect(result[2].role).toBe("user");
        expect(result[3].role).toBe("assistant");
    });
});

// ── groupSubAgentConversations ──────────────────────────────────────────────

describe("groupSubAgentConversations", () => {
    test("passes through non-sub-agent messages unchanged", () => {
        const messages: RelayMessage[] = [
            msg({ key: "u1", role: "user", content: [{ type: "text", text: "hello" }] }),
            msg({ key: "t1", role: "tool", toolName: "bash", content: [{ type: "text", text: "output" }] }),
        ];
        const result = groupSubAgentConversations(messages);
        expect(result).toHaveLength(2);
        expect(result[0].role).toBe("user");
        expect(result[1].role).toBe("tool");
    });

    test("groups consecutive send_message calls into conversation", () => {
        const messages: RelayMessage[] = [
            msg({
                key: "t1",
                role: "tool",
                toolName: "send_message",
                toolInput: { sessionId: "s1", message: "hello" },
                content: [{ type: "text", text: "Message sent" }],
            }),
            msg({
                key: "t2",
                role: "tool",
                toolName: "wait_for_message",
                toolInput: { fromSessionId: "s1" },
                content: [{ type: "text", text: "Message from session s1:\n\nhi back" }],
            }),
        ];
        const result = groupSubAgentConversations(messages);
        expect(result).toHaveLength(1);
        expect(result[0].role).toBe("subAgentConversation");
        expect(result[0].subAgentTurns).toHaveLength(2);
        expect(result[0].subAgentTurns![0].type).toBe("sent");
        expect(result[0].subAgentTurns![1].type).toBe("received");
    });

    test("handles check_messages with no messages", () => {
        const messages: RelayMessage[] = [
            msg({
                key: "t1",
                role: "tool",
                toolName: "check_messages",
                toolInput: {},
                content: [{ type: "text", text: "No pending messages." }],
            }),
        ];
        const result = groupSubAgentConversations(messages);
        expect(result).toHaveLength(1);
        expect(result[0].role).toBe("subAgentConversation");
        const turn = result[0].subAgentTurns![0];
        expect(turn.type).toBe("check");
        if (turn.type === "check") {
            expect(turn.isEmpty).toBe(true);
        }
    });

    test("does not group non-consecutive sub-agent tools", () => {
        const messages: RelayMessage[] = [
            msg({
                key: "t1",
                role: "tool",
                toolName: "send_message",
                toolInput: { sessionId: "s1", message: "hello" },
                content: [{ type: "text", text: "sent" }],
            }),
            msg({ key: "a1", role: "assistant", content: [{ type: "text", text: "thinking..." }] }),
            msg({
                key: "t2",
                role: "tool",
                toolName: "wait_for_message",
                toolInput: {},
                content: [{ type: "text", text: "Message from session s1:\n\nreply" }],
            }),
        ];
        const result = groupSubAgentConversations(messages);
        expect(result).toHaveLength(3);
        expect(result[0].role).toBe("subAgentConversation");
        expect(result[1].role).toBe("assistant");
        expect(result[2].role).toBe("subAgentConversation");
    });

    test("handles empty message list", () => {
        expect(groupSubAgentConversations([])).toEqual([]);
    });

    test("handles wait_for_message timeout", () => {
        const messages: RelayMessage[] = [
            msg({
                key: "t1",
                role: "tool",
                toolName: "wait_for_message",
                toolInput: { timeout: 10 },
                content: [{ type: "text", text: "No message received within timeout." }],
            }),
        ];
        const result = groupSubAgentConversations(messages);
        expect(result).toHaveLength(1);
        const turn = result[0].subAgentTurns![0];
        expect(turn.type).toBe("waiting");
        if (turn.type === "waiting") {
            expect(turn.isTimedOut).toBe(true);
        }
    });
});
