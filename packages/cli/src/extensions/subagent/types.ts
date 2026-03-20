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
            for (const part of msg.content) {
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
