/**
 * Types for the session-analyzer provider.
 *
 * Mirrors the spec in:
 * docs/superpowers/specs/2026-05-16-session-context-caching-insights-design.md
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
  /**
   * A block represents a turn's total context contribution (user + assistant + tool results),
   * a special entry (compaction/branch summary, custom message), a system prompt section,
   * or the system/base overhead.
   */
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
    | string; // customType passthrough for unrecognized
  /**
   * Estimated context contribution for this block. Always ≥ 0 for rendering.
   * Negative raw deltas are captured in rawTokenDelta and rendered as separators.
   */
  tokens: number;
  /** Raw delta from previous assistant input (may be negative). Used for sparkline only. */
  rawTokenDelta: number;
  usage?: Usage; // from the assistant message in this turn
  model?: { provider: string; id: string }; // model active at this turn
  /** Human-readable title (e.g., "Global Rules", "Project Rules", skill name). */
  title?: string;
  /**
   * Heuristic breakdown of the turn block into per-role sub-components.
   * Estimated from content blocks (text, toolCall, thinking) in the assistant message.
   * Null for non-turn blocks.
   */
  subBlocks?: Array<{
    role: "user" | "assistant" | "tool_result" | "thinking" | `tool:${string}`;
    tokens: number; // estimated from content
  }>;
}

export interface CompactionBoundary {
  entryId: string;
  tokensBeforeCompaction: number; // pre-compaction context size (from CompactionEntry.tokensBefore)
  estimatedSummaryTokens: number; // heuristic estimate of summary token cost
  estimatedTokensAfter: number | null; // estimated post-compaction context (null if unknown)
  estimatedTokensFreed: number | null; // before - after (null if after is unknown)
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
  /** Model at the current leaf (for display purposes) */
  activeModel: { provider: string; id: string; contextWindow?: number } | null;
  /** All models used, with per-model stats */
  modelsUsed: ModelStats[];
  blocks: ContextBlock[];
  compactions: CompactionBoundary[];
  summary: {
    totalTokens: number;
    totalCost: number;
    /** cacheRead / (input + cacheRead) — per Anthropic caching semantics */
    cacheHitRate: number;
    /**
     * Estimated $ saved by caching. Computed per-model as:
     *   Σ (cacheReadTokens * (uncachedInputPricePerToken - cacheReadPricePerToken))
     * Requires both cost data and per-model pricing. Falls back to null if any turn is
     * missing cost or if the model's pricing is unavailable.
     */
    estimatedCacheSavings: number | null;
    compactionCount: number;
    /** Sum of estimatedTokensFreed across all compactions (null if any are unknown) */
    tokensFreedByCompaction: number | null;
    /** Highest observed usage.input value (context peak, heuristic) */
    peakContextUsage: number | null;
    /** Mean % of context window used (null if contextWindow is unknown) */
    contextUtilization: number | null;
  };
}

// ── Parsed JSONL entry shapes used by the parser ────────────────────────────

export interface ParsedSessionHeader {
  type: "session";
  id: string;
  timestamp: string;
  cwd: string;
  version?: number;
  parentSession?: string;
}

export interface ParsedMessageEntry {
  type: "message";
  id: string;
  parentId: string | null;
  timestamp: string;
  message: {
    role: string;
    content?: unknown;
    provider?: string;
    model?: string;
    usage?: Usage;
    tool_calls?: unknown[];
    [key: string]: unknown;
  };
}

export interface ParsedCompactionEntry {
  type: "compaction";
  id: string;
  parentId: string | null;
  timestamp: string;
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
  details?: unknown;
  fromHook?: boolean;
}

export interface ParsedBranchSummaryEntry {
  type: "branch_summary";
  id: string;
  parentId: string | null;
  timestamp: string;
  fromId: string;
  summary: string;
  details?: unknown;
  fromHook?: boolean;
}

export interface ParsedCustomMessageEntry {
  type: "custom_message";
  id: string;
  parentId: string | null;
  timestamp: string;
  customType: string;
  content: string | unknown[];
  display: boolean;
  details?: unknown;
}

export interface ParsedCustomEntry {
  type: "custom";
  id: string;
  parentId: string | null;
  timestamp: string;
  customType: string;
  data?: unknown;
}

export interface ParsedModelChangeEntry {
  type: "model_change";
  id: string;
  parentId: string | null;
  timestamp: string;
  provider: string;
  modelId: string;
}

export interface ParsedUnknownEntry {
  type: string;
  id?: string;
  parentId?: string | null;
  timestamp?: string;
  [key: string]: unknown;
}

export type ParsedEntry =
  | ParsedSessionHeader
  | ParsedMessageEntry
  | ParsedCompactionEntry
  | ParsedBranchSummaryEntry
  | ParsedCustomMessageEntry
  | ParsedCustomEntry
  | ParsedModelChangeEntry
  | ParsedUnknownEntry;
