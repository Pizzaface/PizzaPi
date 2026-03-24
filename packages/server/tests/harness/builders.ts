/**
 * builders.ts — Factory functions that produce correctly-shaped agent events.
 *
 * No server dependency — these are data builders only.
 * Import protocol types directly from @pizzapi/protocol.
 *
 * Note: Builders are not pure — they use module-level counters and Date.now()/crypto.randomBytes()
 * for ID generation. Pass overrides to control specific fields in deterministic tests.
 */

import { randomBytes } from "node:crypto";
import {
    defaultMetaState,
    type SessionMetaState,
    type MetaTodoItem,
} from "@pizzapi/protocol";

import type { SessionInfo, RunnerInfo, ModelInfo } from "@pizzapi/protocol";

// ── HeartbeatEvent ────────────────────────────────────────────────────────────

export interface HeartbeatEvent {
    type: "heartbeat";
    active: boolean;
    isCompacting: boolean;
    ts: number;
    model: ModelInfo | null;
    sessionName: string | null;
    uptime: number | null;
    cwd: string | null;
}

/**
 * Build a heartbeat event with sensible defaults.
 *
 * Heartbeats are emitted periodically by running sessions to report liveness,
 * current model, session name, and working directory. Pass `overrides` to set
 * specific fields for targeted test assertions.
 *
 * @param overrides - Partial fields to merge over the defaults.
 * @returns A complete `HeartbeatEvent` ready to pass to `relay.emitEvent()`.
 *
 * @example
 * ```ts
 * const hb = buildHeartbeat({ active: true, sessionName: "my-session" });
 * relay.emitEvent(sessionId, token, hb, 0);
 * ```
 */
export function buildHeartbeat(overrides?: Partial<HeartbeatEvent>): HeartbeatEvent {
    return {
        type: "heartbeat",
        active: false,
        isCompacting: false,
        ts: Date.now(),
        model: null,
        sessionName: null,
        uptime: null,
        cwd: "/tmp/mock",
        ...overrides,
    };
}

// ── Message/content block builders ──────────────────────────────────────────

export interface AssistantMessageEvent {
    type: "message_update";
    role: "assistant";
    content: Array<{ type: "text"; text: string }>;
    messageId: string;
}

export interface ToolUseBlock {
    type: "tool_use";
    id: string;
    name: string;
    input: unknown;
}

export interface ToolResultBlock {
    type: "tool_result";
    tool_use_id: string;
    content: Array<{ type: "text"; text: string }>;
}

let _blockIdCounter = 0;
function nextId(prefix: string): string {
    return `${prefix}_${++_blockIdCounter}_${randomBytes(4).toString("hex")}`;
}

/**
 * Build an assistant `message_update` event containing a single text block.
 *
 * @param text      - The assistant message text.
 * @param overrides - Optional field overrides (e.g. a deterministic `messageId`).
 * @returns A `message_update` event shaped for relay emission.
 *
 * @example
 * ```ts
 * relay.emitEvent(sessionId, token, buildAssistantMessage("Hello!"), 0);
 * ```
 */
export function buildAssistantMessage(
    text: string,
    overrides?: Partial<AssistantMessageEvent>,
): AssistantMessageEvent {
    return {
        type: "message_update",
        role: "assistant",
        content: [{ type: "text", text }],
        messageId: nextId("msg"),
        ...overrides,
    };
}

/**
 * Build a `tool_use` content block representing an LLM-initiated tool call.
 *
 * @param toolName   - The name of the tool being called (e.g. `"bash"`).
 * @param input      - The tool input object.
 * @param toolCallId - Optional deterministic ID; auto-generated if omitted.
 * @returns A `ToolUseBlock` suitable for embedding in a `message_update` event.
 *
 * @example
 * ```ts
 * const block = buildToolUseEvent("bash", { command: "ls" });
 * ```
 */
export function buildToolUseEvent(
    toolName: string,
    input: unknown,
    toolCallId?: string,
): ToolUseBlock {
    return {
        type: "tool_use",
        id: toolCallId ?? nextId("tool"),
        name: toolName,
        input,
    };
}

/**
 * Build a `tool_result` content block representing the output of a tool call.
 *
 * @param toolCallId - The `id` from the corresponding `ToolUseBlock`.
 * @param output     - The tool's text output.
 * @returns A `ToolResultBlock` suitable for embedding in a `tool_result_message` event.
 *
 * @example
 * ```ts
 * const result = buildToolResultEvent(block.id, "file1.ts\nfile2.ts");
 * ```
 */
export function buildToolResultEvent(
    toolCallId: string,
    output: string,
): ToolResultBlock {
    return {
        type: "tool_result",
        tool_use_id: toolCallId,
        content: [{ type: "text", text: output }],
    };
}

// ── Conversation builder ─────────────────────────────────────────────────────

export type ConversationTurn =
    | { role: "user"; text: string }
    | { role: "assistant"; text: string }
    | { role: "assistant"; toolCall: { name: string; input: unknown } }
    | { role: "tool"; toolCallId: string; result: string };

/**
 * Build a sequence of relay-compatible events from a high-level conversation spec.
 *
 * Each turn maps to one or more protocol events:
 * - `{ role: "user" }` → `harness:user_turn` marker (NOT a real protocol event — skip when emitting)
 * - `{ role: "assistant", text }` → `message_update` event
 * - `{ role: "assistant", toolCall }` → `message_update` with a `tool_use` block
 * - `{ role: "tool" }` → `tool_result_message` event
 *
 * **Important:** `harness:user_turn` entries in the output must be filtered out
 * before passing events to `relay.emitEvent()`. `TestScenario.sendConversation()`
 * does this automatically.
 *
 * @param turns - Ordered conversation turns describing the exchange.
 * @returns An array of event objects ready for relay emission (after filtering user turns).
 *
 * @example
 * ```ts
 * const events = buildConversation([
 *   { role: "assistant", text: "Running ls..." },
 *   { role: "assistant", toolCall: { name: "bash", input: { command: "ls" } } },
 * ]);
 * ```
 */
export function buildConversation(turns: ConversationTurn[]): unknown[] {
    const events: unknown[] = [];

    for (const turn of turns) {
        if (turn.role === "user") {
            // User input does not flow through the relay event pipeline — it arrives via the
            // /viewer namespace as "input" events. This harness marker is test scaffolding only
            // and is NOT a real protocol event type. Consumers should not emit it to the relay.
            events.push({
                type: "harness:user_turn",
                text: turn.text,
            });
        } else if (turn.role === "assistant") {
            if ("toolCall" in turn) {
                const toolId = nextId("tool");
                const block = buildToolUseEvent(turn.toolCall.name, turn.toolCall.input, toolId);
                events.push({
                    type: "message_update",
                    role: "assistant",
                    content: [block],
                    messageId: nextId("msg"),
                });
            } else {
                events.push(buildAssistantMessage(turn.text));
            }
        } else if (turn.role === "tool") {
            const resultBlock = buildToolResultEvent(turn.toolCallId, turn.result);
            events.push({
                type: "tool_result_message",
                content: [resultBlock],
            });
        }
    }

    return events;
}

// ── Protocol type builders ───────────────────────────────────────────────────

/**
 * Build a `SessionInfo` object with sensible test defaults.
 *
 * Useful for constructing expected values in hub/session assertion tests
 * or populating test fixtures without a live server.
 *
 * @param overrides - Partial fields to merge over the defaults.
 * @returns A complete `SessionInfo` object.
 *
 * @example
 * ```ts
 * const info = buildSessionInfo({ sessionId: "abc123", isActive: false });
 * ```
 */
export function buildSessionInfo(overrides?: Partial<SessionInfo>): SessionInfo {
    return {
        sessionId: `session_${nextId("s")}`,
        shareUrl: "http://localhost:3000/s/mock",
        cwd: "/tmp/mock",
        startedAt: new Date().toISOString(),
        viewerCount: 0,
        sessionName: null,
        isEphemeral: true,
        expiresAt: null,
        isActive: true,
        lastHeartbeatAt: null,
        model: null,
        runnerId: null,
        runnerName: null,
        parentSessionId: null,
        ...overrides,
    };
}

/**
 * Build a `RunnerInfo` object with sensible test defaults.
 *
 * Useful for constructing expected values in runner-related assertion tests.
 *
 * @param overrides - Partial fields to merge over the defaults.
 * @returns A complete `RunnerInfo` object.
 *
 * @example
 * ```ts
 * const runner = buildRunnerInfo({ name: "my-runner", platform: "darwin" });
 * ```
 */
export function buildRunnerInfo(overrides?: Partial<RunnerInfo>): RunnerInfo {
    return {
        runnerId: `runner_${nextId("r")}`,
        name: "Test Runner",
        roots: ["/tmp"],
        sessionCount: 0,
        skills: [],
        agents: [],
        plugins: [],
        hooks: [],
        version: "0.0.0",
        platform: "linux",
        ...overrides,
    };
}

/**
 * Build a `SessionMetaState` object with protocol defaults, optionally
 * merged with the provided overrides.
 *
 * The base is `defaultMetaState()` from `@pizzapi/protocol`, so the result
 * is always a fully valid meta state. Use this to construct expected values
 * when testing session meta update flows.
 *
 * @param overrides - Partial fields to merge over `defaultMetaState()`.
 * @returns A complete `SessionMetaState` object.
 *
 * @example
 * ```ts
 * const meta = buildMetaState({ todoList: buildTodoList([{ text: "Step 1" }]) });
 * ```
 */
export function buildMetaState(overrides?: Partial<SessionMetaState>): SessionMetaState {
    return {
        ...defaultMetaState(),
        ...overrides,
    };
}

/**
 * Build an array of `MetaTodoItem` objects from a concise item spec.
 *
 * Items are assigned sequential IDs starting from 1. Status defaults to
 * `"pending"` if not specified.
 *
 * @param items - Array of `{ text, status? }` descriptors.
 * @returns A `MetaTodoItem[]` suitable for use in `buildMetaState({ todoList })`.
 *
 * @example
 * ```ts
 * const todos = buildTodoList([
 *   { text: "Step 1", status: "done" },
 *   { text: "Step 2" },          // defaults to "pending"
 * ]);
 * ```
 */
export function buildTodoList(
    items: Array<{ text: string; status?: MetaTodoItem["status"] }>,
): MetaTodoItem[] {
    return items.map((item, index) => ({
        id: index + 1,
        text: item.text,
        status: item.status ?? "pending",
    }));
}
