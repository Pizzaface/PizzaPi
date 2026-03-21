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

    test("errored assistant message with incomplete tool args does not crash", () => {
        // When the Anthropic SSE stream is truncated mid-event, the assistant
        // message arrives with stopReason: "error" and partial tool call
        // arguments (incomplete JSON string). The grouping must handle this
        // gracefully without throwing.
        const messages: RelayMessage[] = [
            msg({
                key: "a1",
                role: "assistant",
                stopReason: "error",
                errorMessage: "JSON Parse error: Expected '}'",
                content: [
                    { type: "toolCall", name: "AskUserQuestion", id: "tc1", arguments: '{"questions": [{"question": "What' },
                ],
                timestamp: 99999,
            }),
        ];
        const result = groupToolExecutionMessages(messages);
        // Should produce a tool item without crashing
        const tools = result.filter((m) => m.role === "tool");
        expect(tools).toHaveLength(1);
        expect(tools[0].toolName).toBe("AskUserQuestion");
        // The errored assistant message should also be emitted (for the error banner)
        const errorMsgs = result.filter(
            (m) => m.role === "assistant" && m.stopReason === "error",
        );
        expect(errorMsgs).toHaveLength(1);
    });

    test("deduplication prefers non-errored message over errored one with same toolCallId", () => {
        // Scenario: streaming partial arrives first (no error, complete args),
        // then a final message with stopReason: "error" and the same toolCallId
        // arrives (truncated JSON args).  Dedup should PREFER the non-errored
        // partial so the tool card shows completed and NO error banner appears
        // on the assistant text bubble.
        const messages: RelayMessage[] = [
            msg({
                key: "a1-partial",
                role: "assistant",
                content: [
                    { type: "text", text: "Let me ask you something" },
                    { type: "toolCall", name: "AskUserQuestion", id: "tc1",
                      arguments: { questions: [{ question: "Color?", options: ["Red", "Blue"] }] } },
                ],
            }),
            msg({
                key: "a1-final",
                role: "assistant",
                stopReason: "error",
                errorMessage: "JSON Parse error: Expected '}'",
                content: [
                    { type: "text", text: "Let me ask you something" },
                    { type: "toolCall", name: "AskUserQuestion", id: "tc1",
                      arguments: '{"questions": [{"question": "Color?", "options": ["Red"' },
                ],
                timestamp: 12345,
            }),
            msg({
                key: "r1",
                role: "toolResult",
                toolCallId: "tc1",
                toolName: "AskUserQuestion",
                content: [{ type: "text", text: "User answered: Red" }],
            }),
        ];
        const result = groupToolExecutionMessages(messages);
        // The tool item should have content from the toolResult
        const tools = result.filter((m) => m.role === "tool");
        expect(tools).toHaveLength(1);
        expect(tools[0].content).toBeTruthy();
        // No error banner: the errored message was dropped in favour of the
        // non-errored partial, so no assistant part inherits stopReason "error".
        const errorParts = result.filter(
            (m) => m.role === "assistant" && m.stopReason === "error",
        );
        expect(errorParts).toHaveLength(0);
        // The assistant text bubble should come from the non-errored partial
        const textParts = result.filter((m) => m.role === "assistant");
        expect(textParts).toHaveLength(1);
        expect(textParts[0].stopReason).toBeUndefined();
        // Preserve the newer (timestamped) snapshot's timestamp so the assistant
        // text doesn't sort to the end of the transcript.
        expect(textParts[0].timestamp).toBe(12345);
    });

    test("P2: preserves assistant blocks that only exist in the newer errored snapshot", () => {
        // Scenario: a non-errored partial contains [text, tc1], but the newer
        // errored snapshot contains additional assistant content after the tool
        // call. When tc1 completes successfully, we still want to keep that
        // trailing assistant content (it is real transcript text).
        const messages: RelayMessage[] = [
            msg({
                key: "a1-partial",
                role: "assistant",
                content: [
                    { type: "text", text: "Let me ask you something" },
                    { type: "toolCall", name: "AskUserQuestion", id: "tc1",
                      arguments: { questions: [{ question: "Color?", options: ["Red", "Blue"] }] } },
                ],
            }),
            msg({
                key: "a1-final",
                role: "assistant",
                stopReason: "error",
                errorMessage: "JSON Parse error: Expected '}'",
                content: [
                    { type: "text", text: "Let me ask you something" },
                    { type: "toolCall", name: "AskUserQuestion", id: "tc1",
                      arguments: '{"questions": [{"question": "Color?", "options": ["Red"' },
                    { type: "text", text: "Trailing text that should not be lost" },
                ],
                timestamp: 12345,
            }),
            msg({
                key: "r1",
                role: "toolResult",
                toolCallId: "tc1",
                toolName: "AskUserQuestion",
                content: [{ type: "text", text: "User answered: Red" }],
            }),
        ];

        const result = groupToolExecutionMessages(messages);

        const tools = result.filter((m) => m.role === "tool");
        expect(tools).toHaveLength(1);
        expect(tools[0].content).toBeTruthy();

        // One assistant part before the tool call, one after it (trailing text)
        const assistantParts = result.filter((m) => m.role === "assistant");
        expect(assistantParts).toHaveLength(2);
        expect(assistantParts[0].stopReason).toBeUndefined();
        expect(assistantParts[1].stopReason).toBeUndefined();

        expect(assistantParts[1].content).toEqual([
            { type: "text", text: "Trailing text that should not be lost" },
        ]);
        // Timestamp should come from the newer snapshot so sorting stays correct.
        expect(assistantParts[1].timestamp).toBe(12345);
    });

    test("P1: keeps errored snapshot when no tool result follows (no non-errored partial)", () => {
        // Scenario: partial arrives (non-errored), then stream dies producing an
        // errored final for the same toolCallId with NO tool result ever arriving.
        // The errored snapshot must be kept so the failure banner is visible;
        // the non-errored partial should be dropped (it looks "pending" which is wrong).
        const messages: RelayMessage[] = [
            msg({
                key: "a1-partial",
                role: "assistant",
                content: [
                    { type: "toolCall", name: "AskUserQuestion", id: "tc1",
                      arguments: { questions: [{ question: "Color?", options: ["Red"] }] } },
                ],
            }),
            msg({
                key: "a1-final",
                role: "assistant",
                stopReason: "error",
                errorMessage: "Stream disconnected",
                content: [
                    { type: "toolCall", name: "AskUserQuestion", id: "tc1",
                      arguments: '{"questions": [{"question": "Color?", "options": ["Red"' },
                ],
                timestamp: 12345,
            }),
            // No toolResult message — stream died before the tool ran.
        ];
        const result = groupToolExecutionMessages(messages);
        // The errored final should be kept (not the non-errored partial),
        // because no tool result ever arrived.
        const errorParts = result.filter(
            (m) => m.role === "assistant" && m.stopReason === "error",
        );
        expect(errorParts).toHaveLength(1);
        // The non-errored partial should have been dropped.
        const nonErroredParts = result.filter(
            (m) => m.role === "assistant" && !m.stopReason,
        );
        expect(nonErroredParts).toHaveLength(0);
    });

    test("P2: keeps errored snapshot that introduces new tool call IDs", () => {
        // Scenario: a non-errored partial carries [tc1], then an errored final
        // carries [tc1, tc2].  The current "all IDs must agree" filter would
        // discard the errored final (because tc1 prefers the partial), silently
        // orphaning tc2.  With the "any ID" fix the errored final is kept so
        // tc2's tool entry is created and any subsequent toolResult for tc2 can
        // be matched.
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
                stopReason: "error",
                errorMessage: "Stream error",
                content: [
                    { type: "toolCall", name: "bash", id: "tc1", arguments: { command: "ls" } },
                    { type: "toolCall", name: "read_file", id: "tc2", arguments: { path: "/a.ts" } },
                ],
                timestamp: 12345,
            }),
            msg({
                key: "r2",
                role: "toolResult",
                toolCallId: "tc2",
                toolName: "read_file",
                content: [{ type: "text", text: "file content" }],
            }),
        ];
        const result = groupToolExecutionMessages(messages);
        // tc2's tool item must exist and have its result filled in.
        const tools = result.filter((m) => m.role === "tool");
        const tc2Tool = tools.find((t) => t.toolCallId === "tc2");
        expect(tc2Tool).toBeDefined();
        expect(tc2Tool!.content).toBeTruthy();
    });

    test("matches id-less tool results when preferring non-errored snapshots", () => {
        const messages: RelayMessage[] = [
            msg({
                key: "a1-partial",
                role: "assistant",
                content: [
                    { type: "text", text: "Let me ask you something" },
                    { type: "toolCall", name: "AskUserQuestion", id: "tc1",
                      arguments: { questions: [{ question: "Color?", options: ["Red", "Blue"] }] } },
                ],
            }),
            msg({
                key: "a1-final",
                role: "assistant",
                stopReason: "error",
                errorMessage: "JSON Parse error: Expected '}'",
                content: [
                    { type: "text", text: "Let me ask you something" },
                    { type: "toolCall", name: "AskUserQuestion", id: "tc1",
                      arguments: '{"questions": [{"question": "Color?", "options": ["Red"' },
                ],
            }),
            msg({
                key: "r1",
                role: "toolResult",
                toolName: "AskUserQuestion",
                content: [{ type: "text", text: "User answered: Red" }],
            }),
        ];

        const result = groupToolExecutionMessages(messages);
        const tools = result.filter((m) => m.role === "tool");
        expect(tools).toHaveLength(1);
        expect(tools[0].toolCallId).toBe("tc1");
        expect(tools[0].content).toBeTruthy();
        expect(result.filter((m) => m.role === "assistant" && m.stopReason === "error")).toHaveLength(0);
    });

    test("drops stale partial-only tool IDs removed from the final snapshot", () => {
        const messages: RelayMessage[] = [
            msg({
                key: "a1-partial",
                role: "assistant",
                content: [
                    { type: "text", text: "Running tools" },
                    { type: "toolCall", name: "bash", id: "tc1", arguments: { command: "ls" } },
                    { type: "toolCall", name: "read_file", id: "tc2", arguments: { path: "/tmp/a.txt" } },
                ],
            }),
            msg({
                key: "a1-final",
                role: "assistant",
                stopReason: "error",
                errorMessage: "Stream error",
                content: [
                    { type: "text", text: "Running tools" },
                    { type: "toolCall", name: "bash", id: "tc1", arguments: { command: "ls" } },
                ],
            }),
        ];

        const result = groupToolExecutionMessages(messages);
        expect(result.filter((m) => m.role === "assistant")).toHaveLength(1);
        expect(result.filter((m) => m.role === "tool" && m.toolCallId === "tc2")).toHaveLength(0);
    });

    test("P2 regression: older partial winner does not resurrect tool calls dropped by latest snapshot", () => {
        // Scenario: older partial has [text, tc1, tc2], latest errored has [text, tc1].
        // tc1 gets a real result, so the vote picks the non-errored partial as winner.
        // The merge must NOT copy tc2 from the winner since the server dropped it.
        const messages: RelayMessage[] = [
            msg({
                key: "a1-partial",
                role: "assistant",
                content: [
                    { type: "text", text: "Running tools" },
                    { type: "toolCall", name: "bash", id: "tc1", arguments: { command: "ls" } },
                    { type: "toolCall", name: "read_file", id: "tc2", arguments: { path: "/tmp/x" } },
                ],
            }),
            msg({
                key: "a1-final",
                role: "assistant",
                stopReason: "error",
                errorMessage: "Stream error",
                timestamp: 100,
                content: [
                    { type: "text", text: "Running tools" },
                    { type: "toolCall", name: "bash", id: "tc1", arguments: { command: "ls" } },
                ],
            }),
            msg({
                key: "r1",
                role: "tool",
                toolCallId: "tc1",
                content: "file1.txt\nfile2.txt",
                timestamp: 101,
            }),
        ];

        const result = groupToolExecutionMessages(messages);
        // tc2 should NOT appear — the latest snapshot intentionally removed it
        const tc2Tools = result.filter((m) => m.role === "tool" && m.toolCallId === "tc2");
        expect(tc2Tools).toHaveLength(0);
        // tc1 should still have its result
        const tc1Tools = result.filter((m) => m.role === "tool" && m.toolCallId === "tc1");
        expect(tc1Tools).toHaveLength(1);
    });

    test("incomplete tool args fall back to empty object (not raw string)", () => {
        // When the only version of an assistant message is the errored one
        // (no streaming partial), parseToolArguments must return {} rather than
        // the raw incomplete JSON string so downstream card components always
        // receive an object-shaped toolInput.
        const messages: RelayMessage[] = [
            msg({
                key: "a1",
                role: "assistant",
                stopReason: "error",
                errorMessage: "JSON Parse error: Expected '}'",
                content: [
                    { type: "toolCall", name: "AskUserQuestion", id: "tc1",
                      arguments: '{"questions": [{"question": "Color?", "options": ["Red"' },
                ],
                timestamp: 99999,
            }),
        ];
        const result = groupToolExecutionMessages(messages);
        const tools = result.filter((m) => m.role === "tool");
        expect(tools).toHaveLength(1);
        // toolInput must be an object (not the raw string)
        expect(tools[0].toolInput).toEqual({});
    });

    test("P1 regression: streaming partial (isStreamingPartial) is not counted as a terminal result", () => {
        // Scenario (mirrors the runtime state during a failed tool invocation):
        //   1. Non-errored assistant partial references tc1.
        //   2. A synthetic toolResult for tc1 arrives from tool_execution_update
        //      (isStreamingPartial: true) — the tool is still in-flight.
        //   3. The turn errors out; a final errored snapshot for tc1 is written.
        //   4. No real/terminal toolResult ever arrives for tc1.
        //
        // Without the fix, collectToolCallIdsWithResult counts the streaming
        // partial as proof that tc1 completed, causing the non-errored partial
        // to be preferred and the error banner to be silently dropped.
        const messages: RelayMessage[] = [
            msg({
                key: "a1-partial",
                role: "assistant",
                content: [
                    { type: "toolCall", name: "bash", id: "tc1", arguments: { command: "ls" } },
                ],
            }),
            // Synthetic streaming partial — in-flight, NOT a terminal result.
            msg({
                key: "toolResult:tool:tc1",
                role: "toolResult",
                toolCallId: "tc1",
                toolName: "bash",
                content: [{ type: "text", text: "partial output..." }],
                isStreamingPartial: true,
            }),
            msg({
                key: "a1-final",
                role: "assistant",
                stopReason: "error",
                errorMessage: "Stream disconnected mid-tool",
                content: [
                    { type: "toolCall", name: "bash", id: "tc1", arguments: { command: "ls" } },
                ],
                timestamp: 12345,
            }),
            // No real toolResult — the stream died before the tool finished.
        ];
        const result = groupToolExecutionMessages(messages);
        // The errored final must be kept so the failure banner is visible.
        const errorParts = result.filter(
            (m) => m.role === "assistant" && m.stopReason === "error",
        );
        expect(errorParts).toHaveLength(1);
        // The non-errored partial must be dropped (it looks "pending" which is wrong).
        const nonErroredParts = result.filter(
            (m) => m.role === "assistant" && !m.stopReason,
        );
        expect(nonErroredParts).toHaveLength(0);
    });

    test("P2 regression: non-errored partial [tc1] + errored final [tc1,tc2] with tc1 result does not duplicate text", () => {
        // Scenario: a non-errored partial covers [text, tc1]; then the stream
        // continues and issues tc2, dying before tc2 finishes.  The errored
        // final covers [text, tc1, tc2].  A real toolResult exists for tc1.
        //
        // Without the fix, the "keep if it wins for any ID" rule keeps BOTH
        // snapshots (partial wins for tc1 via lastNonErroredIndex; final wins
        // for tc2 via lastIndex) — the same assistant text is rendered twice.
        //
        // With the fix, the component has exactly ONE winner (the errored final,
        // because the tie goes to the latest snapshot), so text appears once.
        const messages: RelayMessage[] = [
            msg({
                key: "a1-partial",
                role: "assistant",
                content: [
                    { type: "text", text: "Running tools" },
                    { type: "toolCall", name: "bash", id: "tc1", arguments: { command: "ls" } },
                ],
            }),
            msg({
                key: "a1-final",
                role: "assistant",
                stopReason: "error",
                errorMessage: "Stream error",
                content: [
                    { type: "text", text: "Running tools" },
                    { type: "toolCall", name: "bash", id: "tc1", arguments: { command: "ls" } },
                    { type: "toolCall", name: "read_file", id: "tc2", arguments: { path: "/a.ts" } },
                ],
                timestamp: 12345,
            }),
            // Real terminal result for tc1 only — tc2 never ran.
            msg({
                key: "r1",
                role: "toolResult",
                toolCallId: "tc1",
                toolName: "bash",
                content: [{ type: "text", text: "file1.txt" }],
            }),
        ];
        const result = groupToolExecutionMessages(messages);
        // Exactly one assistant text bubble — no duplication.
        const assistantParts = result.filter((m) => m.role === "assistant");
        expect(assistantParts).toHaveLength(1);
        // Both tool cards must be present (tc1 with result, tc2 pending).
        const tools = result.filter((m) => m.role === "tool");
        expect(tools).toHaveLength(2);
        expect(tools.find((t) => t.toolCallId === "tc1")?.content).toBeTruthy();
        expect(tools.find((t) => t.toolCallId === "tc2")).toBeDefined();
    });

    test("passes through compactionSummary messages unchanged", () => {
        const messages: RelayMessage[] = [
            msg({
                key: "c1",
                role: "compactionSummary",
                summary: "## Goal\nBuild a widget",
                tokensBefore: 50000,
            }),
            msg({ key: "u1", role: "user", content: [{ type: "text", text: "continue" }] }),
        ];
        const result = groupToolExecutionMessages(messages);
        expect(result).toHaveLength(2);
        expect(result[0].role).toBe("compactionSummary");
        expect(result[0].summary).toBe("## Goal\nBuild a widget");
        expect(result[0].tokensBefore).toBe(50000);
        expect(result[1].role).toBe("user");
    });

    test("passes through branchSummary messages unchanged", () => {
        const messages: RelayMessage[] = [
            msg({
                key: "b1",
                role: "branchSummary",
                summary: "Branch explored a dead end",
            }),
            msg({ key: "u1", role: "user", content: [{ type: "text", text: "try again" }] }),
        ];
        const result = groupToolExecutionMessages(messages);
        expect(result).toHaveLength(2);
        expect(result[0].role).toBe("branchSummary");
        expect(result[0].summary).toBe("Branch explored a dead end");
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

    test("P2 regression: preserves trailing text from winner when blocks are merged", () => {
        // Scenario: A non-errored partial has [text, tc1], an errored final has
        // [text, tc1, trailing_text]. When tc1 completes, we prefer the partial
        // but must preserve the trailing text from the final.
        const messages: RelayMessage[] = [
            msg({
                key: "a1-partial",
                role: "assistant",
                content: [
                    { type: "text", text: "Starting task" },
                    { type: "toolCall", name: "bash", id: "tc1", arguments: { command: "ls" } },
                ],
            }),
            msg({
                key: "a1-final",
                role: "assistant",
                stopReason: "error",
                errorMessage: "Stream error",
                content: [
                    { type: "text", text: "Starting task" },
                    { type: "toolCall", name: "bash", id: "tc1", arguments: { command: "ls" } },
                    { type: "text", text: "Task in progress (tool still running)" },
                ],
                timestamp: 12345,
            }),
            msg({
                key: "r1",
                role: "toolResult",
                toolCallId: "tc1",
                toolName: "bash",
                content: [{ type: "text", text: "output" }],
            }),
        ];
        const result = groupToolExecutionMessages(messages);
        // Should have leading text, tool card, and trailing text
        const assistantParts = result.filter((m) => m.role === "assistant");
        expect(assistantParts.length).toBeGreaterThanOrEqual(2);
        // Check that trailing text is preserved
        const trailingPart = assistantParts[assistantParts.length - 1];
        const content = Array.isArray(trailingPart.content) ? trailingPart.content : [];
        const trailingText = content.find((b: unknown) => {
            if (!b || typeof b !== "object") return false;
            const block = b as Record<string, unknown>;
            return block.type === "text" && typeof block.text === "string" && block.text.includes("in progress");
        });
        expect(trailingText).toBeDefined();
    });

    test("P2 regression: deduplicates pending calls so id-less result matches correctly", () => {
        // Scenario: partial = [bash tc1], final(error) = [bash tc1, bash tc2],
        // result for tc1 arrives, then id-less bash result for tc2 arrives.
        // Without dedup, pending list has stale [bash/tc1 from partial, bash/tc1
        // from final, bash/tc2 from final], so the id-less result matches the
        // stale tc1 entry instead of tc2. With dedup, it matches tc2 correctly.
        const messages: RelayMessage[] = [
            msg({
                key: "a1-partial",
                role: "assistant",
                content: [
                    { type: "toolCall", name: "bash", id: "tc1", arguments: { command: "echo a" } },
                ],
            }),
            msg({
                key: "a1-final",
                role: "assistant",
                stopReason: "error",
                errorMessage: "Stream error",
                content: [
                    { type: "toolCall", name: "bash", id: "tc1", arguments: { command: "echo a" } },
                    { type: "toolCall", name: "bash", id: "tc2", arguments: { command: "echo b" } },
                ],
                timestamp: 12345,
            }),
            // Real result for tc1
            msg({
                key: "r1",
                role: "toolResult",
                toolCallId: "tc1",
                toolName: "bash",
                content: [{ type: "text", text: "a" }],
            }),
            // Id-less result for bash (should match tc2, not tc1)
            msg({
                key: "r2",
                role: "toolResult",
                toolName: "bash",
                content: [{ type: "text", text: "b" }],
            }),
        ];
        const result = groupToolExecutionMessages(messages);
        // Both tool calls should be completed with correct results
        const tools = result.filter((m) => m.role === "tool");
        expect(tools).toHaveLength(2);
        const tc1Tool = tools.find((t) => t.toolCallId === "tc1");
        const tc2Tool = tools.find((t) => t.toolCallId === "tc2");
        expect(tc1Tool?.content).toBeTruthy();
        expect(tc2Tool?.content).toBeTruthy();
    });

    test("P2 regression: prefers non-errored snapshot when all tools complete (tie-break)", () => {
        // Scenario: partial = [text, tc1], final(error) = [text, tc1, tc2],
        // results for both tc1 and tc2 arrive. Without the fix, the vote ties
        // (tc1 votes partial, tc2 votes final) and the tie-break picks latest
        // (errored final), so ERROR badge persists. With the fix, when all
        // tools complete, we prefer the non-errored partial.
        const messages: RelayMessage[] = [
            msg({
                key: "a1-partial",
                role: "assistant",
                content: [
                    { type: "text", text: "Running both tools" },
                    { type: "toolCall", name: "bash", id: "tc1", arguments: { command: "cmd1" } },
                ],
            }),
            msg({
                key: "a1-final",
                role: "assistant",
                stopReason: "error",
                errorMessage: "Stream error",
                content: [
                    { type: "text", text: "Running both tools" },
                    { type: "toolCall", name: "bash", id: "tc1", arguments: { command: "cmd1" } },
                    { type: "toolCall", name: "bash", id: "tc2", arguments: { command: "cmd2" } },
                ],
                timestamp: 12345,
            }),
            // Result for tc1
            msg({
                key: "r1",
                role: "toolResult",
                toolCallId: "tc1",
                toolName: "bash",
                content: [{ type: "text", text: "out1" }],
            }),
            // Result for tc2
            msg({
                key: "r2",
                role: "toolResult",
                toolCallId: "tc2",
                toolName: "bash",
                content: [{ type: "text", text: "out2" }],
            }),
        ];
        const result = groupToolExecutionMessages(messages);
        // The assistant text should come from the non-errored partial
        const assistantParts = result.filter((m) => m.role === "assistant");
        expect(assistantParts.length).toBeGreaterThan(0);
        // Should NOT have error badge since all tools completed
        const errorParts = assistantParts.filter((m) => m.stopReason === "error");
        expect(errorParts).toHaveLength(0);
    });

    test("P2 regression: keeps latest-only tool calls when a clean snapshot wins", () => {
        // Scenario: partial (non-errored) = [text, tc1], final (error) = [text, tc1, tc2]
        // Result for tc1 arrives → final wins (has both IDs). But current merge
        // logic only iterates through winner blocks and doesn't add tool calls
        // that exist only in latest. tc2 should still be added to the transcript.
        const messages: RelayMessage[] = [
            msg({
                key: "a1",
                role: "assistant",
                content: [
                    { type: "text", text: "Let me run these" },
                    { type: "toolCall", name: "bash", id: "tc1", arguments: { command: "ls" } },
                ],
            }),
            msg({
                key: "a2",
                role: "assistant",
                stopReason: "error",
                content: [
                    { type: "text", text: "Let me run these" },
                    { type: "toolCall", name: "bash", id: "tc1", arguments: { command: "ls" } },
                    { type: "toolCall", name: "bash", id: "tc2", arguments: { command: "pwd" } },
                ],
            }),
            msg({
                key: "r1",
                role: "toolResult",
                toolCallId: "tc1",
                toolName: "bash",
                content: [{ type: "text", text: "file1\nfile2" }],
            }),
        ];
        const result = groupToolExecutionMessages(messages);
        // Both tc1 and tc2 must be present as grouped tools, even though only tc1
        // has a result. tc2 should appear as a pending tool card.
        const tools = result.filter(
            (m) => m.role === "tool" && (m.toolCallId === "tc1" || m.toolCallId === "tc2")
        );
        expect(tools.length).toBeGreaterThanOrEqual(1); // At least tc1
        const tc2Tools = result.filter((m) => m.role === "tool" && m.toolCallId === "tc2");
        expect(tc2Tools.length).toBeGreaterThan(0);
    });

    test("P2 regression: preserves winner-only assistant text after first tool call", () => {
        // Scenario: partial (non-errored) = [text, tc1, "Between", tc2]
        //          final (error) = [text, tc1, tc2]
        // Results for both tools arrive.
        // The merge should keep the "Between" text from the winner even though
        // it doesn't exist in the final snapshot.
        const messages: RelayMessage[] = [
            msg({
                key: "a1",
                role: "assistant",
                content: [
                    { type: "text", text: "Let me run two things" },
                    { type: "toolCall", name: "bash", id: "tc1", arguments: { command: "ls" } },
                    { type: "text", text: "Between the tools" },
                    { type: "toolCall", name: "bash", id: "tc2", arguments: { command: "pwd" } },
                ],
            }),
            msg({
                key: "a2",
                role: "assistant",
                stopReason: "error",
                content: [
                    { type: "text", text: "Let me run two things" },
                    { type: "toolCall", name: "bash", id: "tc1", arguments: { command: "ls" } },
                    { type: "toolCall", name: "bash", id: "tc2", arguments: { command: "pwd" } },
                ],
            }),
            msg({
                key: "r1",
                role: "toolResult",
                toolCallId: "tc1",
                toolName: "bash",
                content: [{ type: "text", text: "file1" }],
            }),
            msg({
                key: "r2",
                role: "toolResult",
                toolCallId: "tc2",
                toolName: "bash",
                content: [{ type: "text", text: "/home" }],
            }),
        ];
        const result = groupToolExecutionMessages(messages);
        // The merged assistant block should include both "Let me run two things"
        // and "Between the tools" text.
        const assistantParts = result.filter((m) => m.role === "assistant");
        expect(assistantParts.length).toBeGreaterThan(0);
        const assistant = assistantParts[0];
        expect(assistant.content).toBeDefined();
        const content = assistant.content as unknown[];
        const textBlocks = content.filter((b) => !b || typeof b !== "object" ? false : (b as Record<string, unknown>).type === "text");
        const allText = textBlocks.map((b) => (b as Record<string, unknown>).text || "").join(" ");
        // Should contain both the intro and the "Between" text
        expect(allText).toContain("Let me run two things");
        expect(allText).toContain("Between the tools");
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
