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
  /** Current context window consumption (tokens), or null if unknown. */
  contextTokens?: number | null;
}

export type MetaProviderUsage = Record<string, Record<string, unknown>>;

export interface MetaModelInfo {
  provider: string;
  id: string;
  name?: string;
  reasoning?: boolean;
  contextWindow?: number;
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

// ── Extension approvals ──────────────────────────────────────────────────────
// A round-trip an extension drives to get an explicit decision from the web UI
// before a gated tool runs. Shared by the CLI (which emits it), the server
// (which relays it), and the UI (which renders the approval card).

export interface ApprovalField {
  key: string;
  label: string;
  value: string;
  /** When true, the user can edit this value before approving. */
  editable?: boolean;
  /** Render as a multi-line textarea (e.g. an email body). */
  multiline?: boolean;
}

export interface ApprovalAction {
  /** Returned as ApprovalDecision.action. "approve"/"reject" are conventional. */
  id: string;
  label: string;
  style?: "primary" | "danger" | "default";
}

/** What an extension asks the user to decide on. */
export interface ApprovalRequest {
  title: string;
  /** Markdown summary / preview shown above the fields. */
  message?: string;
  /** The tool this approval gates, for display. */
  toolName?: string;
  /** Lucide icon name for the card header. */
  icon?: string;
  fields?: ApprovalField[];
  /** Custom actions. Defaults to Approve + Reject when omitted. */
  actions?: ApprovalAction[];
}

/** The user's answer to an ApprovalRequest. */
export interface ApprovalDecision {
  /** Action id chosen ("approve", "reject", or a custom action id). */
  action: string;
  /** Convenience flag: true for the "approve" action. */
  approved: boolean;
  /** Edited values for editable fields, keyed by field key. */
  edits?: Record<string, string>;
  /** True when no approval UI was reachable (headless / disconnected). */
  unavailable?: boolean;
}

/** The pending approval the web UI renders (request + its id). */
export interface MetaPendingApproval extends ApprovalRequest {
  promptId: string;
}

export interface MetaMcpReport {
  slow?: boolean;
  showSlowWarning?: boolean;
  errors?: Array<{ server: string; error: string }>;
  serverTimings?: Array<{ name: string; durationMs: number; toolCount: number; timedOut: boolean; error?: string }>;
  totalDurationMs?: number;
  ts?: number;
}

export interface MetaGoalStatus {
  id: string;
  description: string;
  status: "active" | "met" | "failed" | "cancelled";
  turnCount: number;
  maxTurns?: number;
  tokenSpend: number;
  maxTokens?: number;
  costSpend: number;
  maxCost?: number;
  lastReason?: string;
}

export interface SessionMetaState {
  todoList:           MetaTodoItem[];
  pendingQuestion:    MetaPendingQuestion | null;
  pendingPlan:        MetaPendingPlan | null;
  planModeEnabled:    boolean;
  isCompacting:       boolean;
  retryState:         MetaRetryState | null;
  pendingPluginTrust: MetaPluginTrustPrompt | null;
  pendingApproval:    MetaPendingApproval | null;
  mcpStartupReport:   MetaMcpReport | null;
  tokenUsage:         MetaTokenUsage | null;
  providerUsage:      MetaProviderUsage | null;
  thinkingLevel:      string | null;
  authSource:         string | null;
  model:              MetaModelInfo | null;
  goal:               MetaGoalStatus | null;
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
    pendingApproval: null,
    mcpStartupReport: null,
    tokenUsage: null,
    providerUsage: null,
    thinkingLevel: null,
    authSource: null,
    model: null,
    goal: null,
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
  | { type: "approval_pending";        approval: MetaPendingApproval }
  | { type: "approval_cleared";        promptId: string }
  | { type: "mcp_startup_report";      report: MetaMcpReport; ts: number }
  | { type: "token_usage_updated";     tokenUsage: MetaTokenUsage; providerUsage: MetaProviderUsage }
  | { type: "thinking_level_changed";  level: string | null }
  | { type: "auth_source_changed";     source: string | null }
  | { type: "model_changed";           model: MetaModelInfo | null }
  | { type: "goal_updated";            goal: MetaGoalStatus | null };

export const META_RELAY_EVENT_TYPES = new Set<string>([
  "todo_updated", "question_pending", "question_cleared",
  "plan_pending", "plan_cleared", "plan_mode_toggled",
  "compact_started", "compact_ended", "retry_state_changed",
  "plugin_trust_required", "plugin_trust_resolved",
  "approval_pending", "approval_cleared", "mcp_startup_report",
  "token_usage_updated", "thinking_level_changed", "auth_source_changed", "model_changed",
  "goal_updated",
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
    case "approval_pending":       return { pendingApproval: event.approval };
    case "approval_cleared":       return { pendingApproval: null };
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
    case "goal_updated":           return { goal: event.goal };
  }
}
