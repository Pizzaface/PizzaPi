/**
 * builders.ts — Pure factory functions that produce correctly-shaped agent events.
 *
 * No server dependency — these are data builders only.
 * Import protocol types directly from @pizzapi/protocol.
 */

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
    return `${prefix}_${++_blockIdCounter}_${Math.random().toString(36).slice(2, 8)}`;
}

export function buildAssistantMessage(
    text: string,
    overrides?: Record<string, unknown>,
): AssistantMessageEvent {
    return {
        type: "message_update",
        role: "assistant",
        content: [{ type: "text", text }],
        messageId: nextId("msg"),
        ...overrides,
    } as AssistantMessageEvent;
}

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

export function buildConversation(turns: ConversationTurn[]): unknown[] {
    const events: unknown[] = [];

    for (const turn of turns) {
        if (turn.role === "user") {
            events.push({
                type: "user_message",
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

export function buildMetaState(overrides?: Partial<SessionMetaState>): SessionMetaState {
    return {
        ...defaultMetaState(),
        ...overrides,
    };
}

export function buildTodoList(
    items: Array<{ text: string; status?: MetaTodoItem["status"] }>,
): MetaTodoItem[] {
    return items.map((item, index) => ({
        id: index + 1,
        text: item.text,
        status: item.status ?? "pending",
    }));
}
