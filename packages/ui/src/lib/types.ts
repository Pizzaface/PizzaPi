/**
 * Shared UI types — canonical definitions used across App, SessionViewer,
 * tool cards, and other components.
 *
 * Import from "@/lib/types" instead of defining locally.
 */

import type { QuestionType, QuestionDisplayMode } from "@/lib/ask-user-questions";
import type { ProviderUsageMap } from "@/components/UsageIndicator";
import type { RelayMessage } from "@/components/session-viewer/types";

export interface TodoItem {
  id: number;
  text: string;
  status: "pending" | "in_progress" | "done" | "cancelled";
}

export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  /** Current context window consumption (tokens), or null/undefined if unknown. */
  contextTokens?: number | null;
}

export interface ConfiguredModelInfo {
  provider: string;
  id: string;
  name?: string;
  reasoning?: boolean;
  contextWindow?: number;
}

export interface ResumeSessionOption {
  id: string;
  path: string;
  name: string | null;
  modified: string;
  firstMessage?: string;
}

export interface QueuedMessage {
  id: string;
  text: string;
  deliverAs: "steer" | "followUp";
  timestamp: number;
}

export interface SessionUiCacheEntry {
  // ── Session-scoped (always reset on session switch) ───────────────────
  messages: RelayMessage[];
  activeModel: ConfiguredModelInfo | null;
  sessionName: string | null;
  agentActive: boolean;
  isCompacting: boolean;
  effortLevel: string | null;
  planModeEnabled: boolean;
  tokenUsage: TokenUsage | null;
  lastHeartbeatAt: number | null;
  todoList: TodoItem[];
  pendingQuestion: { toolCallId: string; questions: Array<{ question: string; options: string[]; type?: QuestionType }>; display: QuestionDisplayMode } | null;
  pendingPlan: {
    toolCallId: string;
    title: string;
    description: string | null;
    steps: Array<{ title: string; description?: string }>;
  } | null;
  workerType: string;

  // ── Runner-scoped (preserved on same-runner session switch) ───────────
  // These values are identical across sessions on the same runner.
  // openSession() skips resetting them when the runnerId hasn't changed
  // to avoid flash-to-empty and unnecessary header re-renders.
  availableModels: ConfiguredModelInfo[];
  availableCommands: Array<{ name: string; description?: string; source?: string }>;
  authSource: string | null;
  providerUsage: ProviderUsageMap | null;

  // ── Metadata ──────────────────────────────────────────────────────────
  lastAccessed: number;
}
