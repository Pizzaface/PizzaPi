/**
 * Shared types, constants, and pure type-based utilities for the subagent tool.
 */

import type { AgentToolResult } from "@mariozechner/pi-coding-agent";
import type { Message } from "@mariozechner/pi-ai";
import type { AgentScope } from "../subagent-agents.js";

// ── Constants ──────────────────────────────────────────────────────────

export const DEFAULT_MAX_PARALLEL_TASKS = 8;
export const DEFAULT_MAX_CONCURRENCY = 4;
export const COLLAPSED_ITEM_COUNT = 10;
/** Byte threshold for spilling parallel results to temp files instead of inline. */
export const PARALLEL_SPILL_THRESHOLD = 100 * 1024; // 100KB

/** Coerce an unknown config value to a finite positive integer, or return the fallback. */
export function toFinitePositiveInt(value: unknown, fallback: number): number {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 1) return fallback;
    return Math.floor(n);
}

// ── Types ──────────────────────────────────────────────────────────────

export interface UsageStats {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    cost: number;
    contextTokens: number;
    turns: number;
}

export interface SingleResult {
    agent: string;
    agentSource: "user" | "project" | "unknown";
    task: string;
    exitCode: number;
    messages: Message[];
    stderr: string;
    usage: UsageStats;
    model?: string;
    stopReason?: string;
    errorMessage?: string;
    step?: number;
    /** True when this result is a lightweight streaming summary, not the full transcript. */
    summaryOnly?: boolean;
    /** Latest assistant text preview for summary-only updates. */
    latestOutput?: string;
    /** Number of tool calls seen so far for summary-only updates. */
    toolCallCount?: number;
}

export interface SubagentDetails {
    mode: "single" | "parallel" | "chain";
    agentScope: AgentScope;
    projectAgentsDir: string | null;
    results: SingleResult[];
}

export type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void;

export type DisplayItem =
    | { type: "text"; text: string }
    | { type: "toolCall"; name: string; args: Record<string, any> };

// ── Pure utilities ─────────────────────────────────────────────────────

/** Shared predicate for determining if a subagent result represents a failure. */
export function isFailed(r: SingleResult): boolean {
    return r.exitCode !== 0 || r.stopReason === "error" || r.stopReason === "aborted";
}

export function getFinalOutput(messages: Message[]): string {
    for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i];
        if (msg.role === "assistant") {
            for (let j = msg.content.length - 1; j >= 0; j--) {
                const part = msg.content[j];
                if (part.type === "text") return part.text;
            }
        }
    }
    return "";
}

export function getDisplayItems(messages: Message[]): DisplayItem[] {
    const items: DisplayItem[] = [];
    for (const msg of messages) {
        if (msg.role === "assistant") {
            for (const part of msg.content) {
                if (part.type === "text") items.push({ type: "text", text: part.text });
                else if (part.type === "toolCall") items.push({ type: "toolCall", name: part.name, args: part.arguments });
            }
        }
    }
    return items;
}

export function getToolCallCount(messages: Message[]): number {
    let count = 0;
    for (const msg of messages) {
        if (msg.role !== "assistant") continue;
        for (const part of msg.content) {
            if (part.type === "toolCall") count++;
        }
    }
    return count;
}

export function summarizeResultForStreaming(result: SingleResult): SingleResult {
    return {
        ...result,
        messages: [],
        summaryOnly: true,
        latestOutput: getFinalOutput(result.messages),
        toolCallCount: getToolCallCount(result.messages),
    };
}

export function summarizeResultsForStreaming(results: SingleResult[]): SingleResult[] {
    return results.map(summarizeResultForStreaming);
}

export function shouldSpillParallelOutput(text: string, threshold = PARALLEL_SPILL_THRESHOLD): boolean {
    return Buffer.byteLength(text, "utf8") > threshold;
}

export function sanitizeAgentFileSegment(agent: string): string {
    const sanitized = agent
        .trim()
        .replace(/[\\/]+/g, "-")
        .replace(/[^a-zA-Z0-9._-]+/g, "-")
        .replace(/^[-.]+/, "")
        .replace(/[-.]+$/, "")
        .slice(0, 64);
    return sanitized || "agent";
}
