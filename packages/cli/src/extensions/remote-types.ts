/**
 * Shared types for the remote extension modules.
 *
 * All interfaces and type definitions that were previously defined inline
 * inside the `remoteExtension` closure are extracted here so they can be
 * imported by the individual extracted modules.
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { Socket } from "socket.io-client";
import type { RelayClientToServerEvents, RelayServerToClientEvents } from "@pizzapi/protocol";
import type { RemoteExecResponse } from "./remote-commands.js";
import type { ConversationTrigger } from "./triggers/types.js";

// ── Relay state ──────────────────────────────────────────────────────────────

export interface RelayState {
    sessionId: string;
    token: string;
    shareUrl: string;
    /** Monotonic sequence number for the next event forwarded to relay */
    seq: number;
    /** Highest cumulative seq acknowledged by relay */
    ackedSeq: number;
}

// ── AskUserQuestion types ────────────────────────────────────────────────────

export type AskUserQuestionDisplay = "stepper";

export type AskUserQuestionType = "radio" | "checkbox" | "ranked";

export interface AskUserQuestionItem {
    question: string;
    options: string[];
    /** Selection mode: "radio" (single select, default), "checkbox" (multiselect), or "ranked" (ranked choice). */
    type?: AskUserQuestionType;
}

export interface AskUserQuestionParams {
    /** Canonical format */
    questions?: AskUserQuestionItem[];
    /** Optional multi-question UI layout preference. */
    display?: AskUserQuestionDisplay;
    /** Legacy single-question fields (older callers) */
    question?: string;
    placeholder?: string;
    options?: string[];
}

export interface AskUserQuestionDetails {
    questions: AskUserQuestionItem[];
    display: AskUserQuestionDisplay;
    answers: Record<string, string> | null;
    answer: string | null;
    source: "tui" | "web" | null;
    cancelled: boolean;
    status?: "waiting" | "answered";
}

export interface PendingAskUserQuestion {
    toolCallId: string;
    questions: AskUserQuestionItem[];
    display: AskUserQuestionDisplay;
    resolve: (answer: string | null) => void;
}

// ── Plan Mode types ──────────────────────────────────────────────────────────

export interface PlanModeStep {
    title: string;
    description?: string;
}

export interface PlanModeParams {
    title: string;
    description?: string;
    steps?: PlanModeStep[];
}

/** User responses for plan mode: execute with/without context clear, edit, or cancel. */
export type PlanModeAction = "execute" | "execute_keep_context" | "edit" | "cancel";

export interface PlanModeDetails {
    title: string;
    description: string | null;
    steps: PlanModeStep[];
    action: PlanModeAction | null;
    editSuggestion: string | null;
    status?: "waiting" | "responded";
}

export interface PendingPlanMode {
    toolCallId: string;
    title: string;
    description: string | null;
    steps: PlanModeStep[];
    resolve: (response: { action: PlanModeAction; editSuggestion?: string } | null) => void;
}

// ── Model info ───────────────────────────────────────────────────────────────

export interface RelayModelInfo {
    provider: string;
    id: string;
    name: string;
    reasoning: boolean;
    contextWindow: number;
}

// ── Provider usage types ─────────────────────────────────────────────────────

export interface UsageWindow {
    label: string;
    utilization: number;
    resets_at: string;
}

export interface ProviderUsageData {
    windows: UsageWindow[];
    status?: "ok" | "unknown";
    errorCode?: number;
}

// ── MCP startup report ───────────────────────────────────────────────────────

export interface McpStartupReportSummary {
    toolCount: number;
    serverCount: number;
    totalDurationMs: number;
    slow: boolean;
    /** Whether slow-startup warnings should be shown (from config). */
    showSlowWarning: boolean;
    errors: Array<{ server: string; error: string }>;
    serverTimings: Array<{
        name: string;
        durationMs: number;
        toolCount: number;
        timedOut: boolean;
        error?: string;
    }>;
    ts: number;
}

// ── Retry state ──────────────────────────────────────────────────────────────

export interface RetryState {
    errorMessage: string;
    detectedAt: number;
}

// ── Auth source ──────────────────────────────────────────────────────────────

export type AuthSource = "oauth" | "auth.json" | "env" | "unknown";

// ── Plugin trust ─────────────────────────────────────────────────────────────

export interface PendingPluginTrust {
    promptId: string;
    pluginNames: string[];
    pluginSummaries: string[];
    respond: (trusted: boolean) => void;
}

// ── Remote input attachment ──────────────────────────────────────────────────

export type RemoteInputAttachment = {
    attachmentId?: string;
    mediaType?: string;
    filename?: string;
    url?: string;
};

// ── Trigger response ─────────────────────────────────────────────────────────

export interface TriggerResponse {
    response: string;
    action?: string;
    cancelled?: boolean;
}

// ── RelayContext — the shared injectable state for all extracted modules ──────

export interface RelayContext {
    // Core references — the pi instance is typed loosely since the actual
    // PiInstance type is internal to the extension factory closure.
    readonly pi: any;
    relay: RelayState | null;
    sioSocket: Socket<RelayServerToClientEvents, RelayClientToServerEvents> | null;
    latestCtx: ExtensionContext | null;

    // Mutable flags
    isAgentActive: boolean;
    isCompacting: boolean;
    shuttingDown: boolean;
    wasAborted: boolean;
    sessionStartedAt: number | null;
    lastRetryableError: RetryState | null;

    // Child session identity
    parentSessionId: string | null;
    isChildSession: boolean;
    relaySessionId: string;

    // Pending interaction state
    pendingAskUserQuestion: PendingAskUserQuestion | null;
    pendingPlanMode: PendingPlanMode | null;
    pendingPluginTrust: PendingPluginTrust | null;

    // Cached state
    lastMcpStartupReport: McpStartupReportSummary | null;

    // Helpers
    forwardEvent(event: unknown): void;
    sendToWeb(payload: RemoteExecResponse): void;
    relayUrl(): string;
    relayHttpBaseUrl(): string;
    apiKey(): string | undefined;
    setRelayStatus(text?: string): void;
    disconnectedStatusText(): string | undefined;
    isConnected(): boolean;

    // State builders
    buildSessionState(): any;
    /** Emit session_active with automatic chunking for large sessions. */
    emitSessionActive(): void;
    buildHeartbeat(): any;
    buildCapabilitiesState(): any;
    getConfiguredModels(): RelayModelInfo[];
    getAvailableCommands(): Array<{ name: string; description?: string; source?: string }>;
    getCurrentSessionName(): string | null;
    getCurrentThinkingLevel(): string | null;

    // Relay status text — direct access for footer
    relayStatusText: string;

    // Trigger helpers (for child session trigger pattern)
    emitTrigger(trigger: ConversationTrigger): void;
    waitForTriggerResponse(triggerId: string, timeoutMs: number, signal?: AbortSignal): Promise<TriggerResponse>;

    // Session name sync
    markSessionNameBroadcasted(): void;
}
