// ============================================================================
// meta-state-apply.ts — Pure mapping from MetaRelayEvent to React state patch
//
// No React dependencies — easily testable in isolation.
// App.tsx uses metaEventToStatePatch() and applies the returned patch.
// ============================================================================

import type { TodoItem, TokenUsage } from "@/lib/types";
import {
  parsePendingQuestions,
  parsePendingQuestionDisplayMode,
  type ParsedQuestion,
  type QuestionDisplayMode,
} from "@/lib/ask-user-questions";
import type { MetaRelayEvent, SessionMetaState, MetaPendingQuestion } from "@pizzapi/protocol";
import type { ProviderUsageMap } from "@/components/UsageIndicator";

interface PendingQuestionState {
  toolCallId: string;
  questions: ParsedQuestion[];
  display: QuestionDisplayMode;
}

export interface MetaStatePatch {
  todoList?: TodoItem[];
  pendingQuestion?: PendingQuestionState | null;
  setPendingQuestion?: boolean;
  pendingPlan?: SessionMetaState["pendingPlan"] | null;
  setPendingPlan?: boolean;
  planModeEnabled?: boolean;
  isCompacting?: boolean;
  retryState?: SessionMetaState["retryState"] | null;
  pluginTrustPrompt?: { promptId: string; pluginNames: string[]; pluginSummaries: string[] } | null;
  tokenUsage?: TokenUsage | null;
  providerUsage?: ProviderUsageMap | null;
  thinkingLevel?: string | null;
  authSource?: string | null;
  model?: { provider: string; id: string; name?: string; reasoning?: boolean } | null;
  viewerStatusOverride?: string;
}

function parsePendingQuestionShape(pq: MetaPendingQuestion): PendingQuestionState | null {
  const questions = parsePendingQuestions(pq as unknown as Record<string, unknown>);
  if (questions.length === 0) return null;
  return {
    toolCallId: pq.toolCallId,
    questions,
    display: parsePendingQuestionDisplayMode(pq as unknown as Record<string, unknown>, questions.length),
  };
}

export function metaEventToStatePatch(event: MetaRelayEvent): MetaStatePatch {
  switch (event.type) {
    case "todo_updated":
      return { todoList: event.todoList as TodoItem[] };
    case "question_pending": {
      const parsed = parsePendingQuestionShape(event.question);
      return {
        setPendingQuestion: true,
        pendingQuestion: parsed,
        viewerStatusOverride: parsed ? "Waiting for answer…" : undefined,
      };
    }
    case "question_cleared":
      return { setPendingQuestion: true, pendingQuestion: null };
    case "plan_pending":
      return {
        setPendingPlan: true,
        pendingPlan: event.plan as SessionMetaState["pendingPlan"],
        viewerStatusOverride: "Waiting for plan review…",
      };
    case "plan_cleared":
      return { setPendingPlan: true, pendingPlan: null };
    case "plan_mode_toggled":
      return { planModeEnabled: event.enabled };
    case "compact_started":
      return { isCompacting: true, viewerStatusOverride: "Compacting…" };
    case "compact_ended":
      return { isCompacting: false };
    case "retry_state_changed":
      return { retryState: event.state };
    case "plugin_trust_required":
      return { pluginTrustPrompt: event.prompt };
    case "plugin_trust_resolved":
      return { pluginTrustPrompt: null };
    case "token_usage_updated":
      return {
        tokenUsage: event.tokenUsage as TokenUsage,
        providerUsage: event.providerUsage as unknown as ProviderUsageMap,
      };
    case "thinking_level_changed":
      return { thinkingLevel: event.level };
    case "auth_source_changed":
      return { authSource: event.source };
    case "model_changed":
      return { model: event.model };
    default:
      return {};
  }
}
