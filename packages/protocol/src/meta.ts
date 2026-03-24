// ============================================================================
// meta.ts — Session meta-state types shared across server, CLI, and UI
//
// SessionMetaState: authoritative shape stored in Redis (metaState field).
// MetaRelayEvent: discrete events emitted by CLI, intercepted by server.
// ============================================================================

export interface MetaTodoItem {
  id: number;
  text: string;
  status: "pending" | "in_progress" | "done" | "cancelled";
}

export interface MetaTokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

export type MetaProviderUsage = Record<string, Record<string, unknown>>;

export interface MetaModelInfo {
  provider: string;
  id: string;
  name?: string;
  reasoning?: boolean;
}

export interface MetaPendingQuestion {
  toolCallId: string;
  questions: Array<{ question: string; options: string[]; type?: string }>;
  display?: string;
}

export interface MetaPendingPlan {
  toolCallId: string;
  title: string;
  description?: string | null;
  steps?: Array<{ title: string; description?: string }>;
}

export interface MetaRetryState {
  errorMessage: string;
  detectedAt: number;
}

export interface MetaPluginTrustPrompt {
  promptId: string;
  pluginNames: string[];
  pluginSummaries: string[];
}

export interface MetaMcpReport {
  slow?: boolean;
  showSlowWarning?: boolean;
  errors?: Array<{ server: string; error: string }>;
  serverTimings?: Array<{ name: string; durationMs: number; toolCount: number; timedOut: boolean; error?: string }>;
  totalDurationMs?: number;
  ts?: number;
}

export interface SessionMetaState {
  todoList:           MetaTodoItem[];
  pendingQuestion:    MetaPendingQuestion | null;
  pendingPlan:        MetaPendingPlan | null;
  planModeEnabled:    boolean;
  isCompacting:       boolean;
  retryState:         MetaRetryState | null;
  pendingPluginTrust: MetaPluginTrustPrompt | null;
  mcpStartupReport:   MetaMcpReport | null;
  tokenUsage:         MetaTokenUsage | null;
  providerUsage:      MetaProviderUsage | null;
  thinkingLevel:      string | null;
  authSource:         string | null;
  model:              MetaModelInfo | null;
  /** Monotonic counter incremented on every updateSessionMetaState call. */
  version:            number;
}

export function defaultMetaState(): SessionMetaState {
  return {
    todoList: [],
    pendingQuestion: null,
    pendingPlan: null,
    planModeEnabled: false,
    isCompacting: false,
    retryState: null,
    pendingPluginTrust: null,
    mcpStartupReport: null,
    tokenUsage: null,
    providerUsage: null,
    thinkingLevel: null,
    authSource: null,
    model: null,
    version: 0,
  };
}

export type MetaRelayEvent =
  | { type: "todo_updated";            todoList: MetaTodoItem[] }
  | { type: "question_pending";        question: MetaPendingQuestion }
  | { type: "question_cleared";        toolCallId: string }
  | { type: "plan_pending";            plan: MetaPendingPlan }
  | { type: "plan_cleared";            toolCallId: string }
  | { type: "plan_mode_toggled";       enabled: boolean }
  | { type: "compact_started" }
  | { type: "compact_ended" }
  | { type: "retry_state_changed";     state: MetaRetryState | null }
  | { type: "plugin_trust_required";   prompt: MetaPluginTrustPrompt }
  | { type: "plugin_trust_resolved";   promptId: string }
  | { type: "mcp_startup_report";      report: MetaMcpReport; ts: number }
  | { type: "token_usage_updated";     tokenUsage: MetaTokenUsage; providerUsage: MetaProviderUsage }
  | { type: "thinking_level_changed";  level: string | null }
  | { type: "auth_source_changed";     source: string | null }
  | { type: "model_changed";           model: MetaModelInfo | null };

export const META_RELAY_EVENT_TYPES = new Set<string>([
  "todo_updated", "question_pending", "question_cleared",
  "plan_pending", "plan_cleared", "plan_mode_toggled",
  "compact_started", "compact_ended", "retry_state_changed",
  "plugin_trust_required", "plugin_trust_resolved", "mcp_startup_report",
  "token_usage_updated", "thinking_level_changed", "auth_source_changed", "model_changed",
]);

export function isMetaRelayEvent(event: { type?: unknown }): event is MetaRelayEvent {
  return typeof event.type === "string" && META_RELAY_EVENT_TYPES.has(event.type);
}

export function metaEventToPatch(event: MetaRelayEvent): Partial<SessionMetaState> {
  switch (event.type) {
    case "todo_updated":       return { todoList: event.todoList };
    case "question_pending":   return { pendingQuestion: event.question };
    case "question_cleared":   return { pendingQuestion: null };
    case "plan_pending":       return { pendingPlan: event.plan };
    case "plan_cleared":       return { pendingPlan: null };
    case "plan_mode_toggled":  return { planModeEnabled: event.enabled };
    case "compact_started":    return { isCompacting: true };
    case "compact_ended":      return { isCompacting: false };
    case "retry_state_changed":    return { retryState: event.state };
    case "plugin_trust_required":  return { pendingPluginTrust: event.prompt };
    case "plugin_trust_resolved":  return { pendingPluginTrust: null };
    case "mcp_startup_report":
      // Old CLI emits a flat format with no nested `report` field.
      // Return an empty patch rather than { mcpStartupReport: undefined },
      // which JSON.stringify would silently drop, wiping the stored value.
      // Old CLI emits a flat format with no nested `report` field; at runtime
      // the field may be absent even though the type says MetaMcpReport.
      return (event.report as MetaMcpReport | undefined) != null ? { mcpStartupReport: event.report } : {};
    case "token_usage_updated":    return { tokenUsage: event.tokenUsage, providerUsage: event.providerUsage };
    case "thinking_level_changed": return { thinkingLevel: event.level };
    case "auth_source_changed":    return { authSource: event.source };
    case "model_changed":          return { model: event.model };
  }
}
