// ============================================================================
// remote-meta-events.ts — Discrete meta-state event emitters
// ============================================================================

import type { RelayContext } from "./remote-types.js";
import type {
  MetaTodoItem, MetaPendingQuestion, MetaPendingPlan, MetaRetryState,
  MetaPluginTrustPrompt, MetaMcpReport, MetaTokenUsage, MetaProviderUsage, MetaModelInfo,
} from "@pizzapi/protocol";

type ForwardCtx = Pick<RelayContext, "forwardEvent">;

export function emitTodoUpdated(rctx: ForwardCtx, todoList: MetaTodoItem[]): void {
  rctx.forwardEvent({ type: "todo_updated", todoList });
}
export function emitQuestionPending(rctx: ForwardCtx, question: MetaPendingQuestion): void {
  rctx.forwardEvent({ type: "question_pending", question });
}
export function emitQuestionCleared(rctx: ForwardCtx, toolCallId: string): void {
  rctx.forwardEvent({ type: "question_cleared", toolCallId });
}
export function emitPlanPending(rctx: ForwardCtx, plan: MetaPendingPlan): void {
  rctx.forwardEvent({ type: "plan_pending", plan });
}
export function emitPlanCleared(rctx: ForwardCtx, toolCallId: string): void {
  rctx.forwardEvent({ type: "plan_cleared", toolCallId });
}
export function emitPlanModeToggled(rctx: ForwardCtx, enabled: boolean): void {
  rctx.forwardEvent({ type: "plan_mode_toggled", enabled });
}
export function emitCompactStarted(rctx: ForwardCtx): void {
  rctx.forwardEvent({ type: "compact_started" });
}
export function emitCompactEnded(rctx: ForwardCtx): void {
  rctx.forwardEvent({ type: "compact_ended" });
}
export function emitRetryStateChanged(rctx: ForwardCtx, state: MetaRetryState | null): void {
  rctx.forwardEvent({ type: "retry_state_changed", state });
}
export function emitPluginTrustRequired(rctx: ForwardCtx, prompt: MetaPluginTrustPrompt): void {
  rctx.forwardEvent({ type: "plugin_trust_required", prompt });
}
export function emitPluginTrustResolved(rctx: ForwardCtx, promptId: string): void {
  rctx.forwardEvent({ type: "plugin_trust_resolved", promptId });
}
export function emitMcpStartupReport(rctx: ForwardCtx, report: MetaMcpReport): void {
  rctx.forwardEvent({ type: "mcp_startup_report", report, ts: Date.now() });
}
export function emitTokenUsageUpdated(rctx: ForwardCtx, tokenUsage: MetaTokenUsage, providerUsage: MetaProviderUsage): void {
  rctx.forwardEvent({ type: "token_usage_updated", tokenUsage, providerUsage });
}
export function emitThinkingLevelChanged(rctx: ForwardCtx, level: string | null): void {
  rctx.forwardEvent({ type: "thinking_level_changed", level });
}
export function emitAuthSourceChanged(rctx: ForwardCtx, source: string | null): void {
  rctx.forwardEvent({ type: "auth_source_changed", source });
}
export function emitModelChanged(rctx: ForwardCtx, model: MetaModelInfo | null): void {
  rctx.forwardEvent({ type: "model_changed", model });
}
