/**
 * Shared UI types mirroring the provider's SessionAnalysis.
 * All fields are optional for null-safe handling.
 */

export interface ContextBlock {
  /** Semantic role of this context block */
  role?: "turn" | "system" | "compaction_summary" | "branch_summary" | "custom_message" | "separator";
  /** Turn index within the session (if applicable) */
  turnIndex?: number;
  /** Estimated token count for this block */
  tokenCount?: number;
  /** Estimated cost for this block */
  cost?: number;
  /** Cache hit rate for this block (0–1) */
  cacheHitRate?: number;
  /** Human-readable title / summary */
  title?: string;
  /** Raw content preview */
  content?: string;
  /** ISO timestamp */
  timestamp?: string;
  /** Model ID associated with this block */
  modelId?: string;
}

export interface CompactionBoundary {
  /** Turn index where compaction occurred */
  turnIndex?: number;
  /** Tokens compacted away */
  compactedTokens?: number;
  /** Context size before compaction */
  beforeTokens?: number;
  /** Context size after compaction */
  afterTokens?: number;
  /** Net token savings from compaction */
  savingsTokens?: number;
  /** ISO timestamp */
  timestamp?: string;
}

export interface ModelStats {
  /** Model identifier */
  modelId?: string;
  /** Number of requests sent to this model */
  requests?: number;
  /** Total input tokens */
  inputTokens?: number;
  /** Total output tokens */
  outputTokens?: number;
  /** Cache read tokens */
  cacheReadTokens?: number;
  /** Cache write tokens */
  cacheWriteTokens?: number;
  /** Total cost for this model */
  cost?: number;
}

export interface SessionAnalysis {
  /** Context blocks in order (largest / current first, depending on provider) */
  contextBlocks?: ContextBlock[];
  /** Compaction boundaries that have occurred */
  boundaries?: CompactionBoundary[];
  /** Per-model statistics */
  modelStats?: ModelStats[];
  /** Total cost across all models */
  totalCost?: number;
  /** Total input tokens across all models */
  totalInputTokens?: number;
  /** Total output tokens across all models */
  totalOutputTokens?: number;
  /** Total cache-read tokens */
  totalCacheReadTokens?: number;
  /** Total cache-write tokens */
  totalCacheWriteTokens?: number;
  /** Overall cache hit rate (0–1) */
  cacheHitRate?: number;
  /** Estimated dollar savings from caching */
  estimatedSavings?: number;
  /** Peak context window tokens observed */
  peakContextTokens?: number;
  /** Number of compactions performed */
  compactionCount?: number;
}
