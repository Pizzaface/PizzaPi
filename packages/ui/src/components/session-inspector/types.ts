/**
 * UI types mirroring the server-side session-analysis types.
 *
 * These match the output of reconstructContext() in:
 * packages/cli/src/session-analysis/analyzer.ts
 */

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    total: number;
  };
}

export interface ContextBlock {
  turnIndex: number;
  entryId: string;
  role:
    | "turn"
    | "system"
    | "compaction_summary"
    | "branch_summary"
    | "custom_message"
    | "context:builtin-prompt"
    | "context:global-rules"
    | "context:project-rules"
    | "context:append-prompt"
    | "context:skill"
    | "context:plugin"
    | "separator"
    | string;
  /** Estimated context contribution for this block. Always ≥ 0. */
  tokens: number;
  /** Raw delta from previous assistant input (may be negative). */
  rawTokenDelta: number;
  usage?: Usage;
  model?: { provider: string; id: string };
  /** Human-readable title (e.g., "Global Rules", "Project Rules", skill name). */
  title?: string;
  /** Heuristic per-role breakdown within the turn. */
  subBlocks?: Array<{
    role: "user" | "assistant" | "tool_result" | "thinking" | `tool:${string}`;
    tokens: number;
  }>;
}

export interface CompactionBoundary {
  entryId: string;
  tokensBeforeCompaction: number;
  estimatedSummaryTokens: number;
  estimatedTokensAfter: number | null;
  estimatedTokensFreed: number | null;
  firstKeptId: string;
  timestamp: string;
}

export interface ModelStats {
  provider: string;
  id: string;
  contextWindow?: number;
  turns: number;
  totalCost: number;
  cacheHitRate: number;
}

export interface SessionAnalysis {
  sessionId: string;
  activeModel: { provider: string; id: string; contextWindow?: number } | null;
  modelsUsed: ModelStats[];
  blocks: ContextBlock[];
  compactions: CompactionBoundary[];
  summary: {
    totalTokens: number;
    totalCost: number;
    cacheHitRate: number;
    estimatedCacheSavings: number | null;
    compactionCount: number;
    tokensFreedByCompaction: number | null;
    peakContextUsage: number | null;
    contextUtilization: number | null;
  };
}
