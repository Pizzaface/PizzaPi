/**
 * Session Analysis — live metrics accumulated from turn_end events.
 *
 * No files, no SQLite, no post-hoc parsing. Usage data is already in every
 * assistant message; we just accumulate it here and emit via session metadata.
 *
 * Semantics mirror session-analysis/analyzer.ts: prompt size is
 * input + cacheRead + cacheWrite, cache metrics go null on incomplete
 * telemetry, and context deltas reset across model switches and failed turns.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type {
  CompactionBoundary,
  ContextBlock,
  SessionAnalysis,
  Usage,
} from "../session-analysis/types.js";
import { estimateCacheReadSavings } from "../session-analysis/pricing.js";

// ── Per-session state ───────────────────────────────────────────

const SESSION_ANALYSIS_TTL_MS = 24 * 60 * 60_000;
const SESSION_ANALYSIS_SWEEP_MS = 5 * 60_000;

type LiveModelStats = {
  provider: string;
  id: string;
  turns: number;
  totalCost: number;
  cacheRead: number;
  cacheWrite: number;
  totalInput: number;
  unknownUsage: boolean;
};

type SessionAnalysisState = {
  blocks: ContextBlock[];
  compactions: CompactionBoundary[];
  models: Map<string, LiveModelStats>;
  activeModel: SessionAnalysis["activeModel"];
  prevPromptTokens: number | null;
  prevModelKey: string | null;
  hasSeenUsage: boolean;
  hasUnknownUsage: boolean;
  cumulativeCacheRead: number;
  cumulativeCacheWrite: number;
  cumulativeInput: number;
  totalTokens: number;
  totalCost: number;
  peakPromptTokens: number;
  cumulativeCacheSavings: number;
  cacheSavingsKnown: boolean;
  updatedAt: number;
};

const sessions = new Map<string, SessionAnalysisState>();
let analysisSweep: ReturnType<typeof setInterval> | null = null;

export function sweepStaleSessionAnalysis(now = Date.now()): number {
  let deleted = 0;
  for (const [sessionId, state] of sessions) {
    if (now - state.updatedAt >= SESSION_ANALYSIS_TTL_MS) {
      sessions.delete(sessionId);
      deleted += 1;
    }
  }
  return deleted;
}

function ensureSessionAnalysisSweep() {
  if (analysisSweep) return;
  analysisSweep = setInterval(() => {
    sweepStaleSessionAnalysis();
  }, SESSION_ANALYSIS_SWEEP_MS);
  analysisSweep.unref?.();
}

function finiteNonNegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

// ── Public API ──────────────────────────────────────────────────

export function getSessionAnalysis(sessionId: string): SessionAnalysis | null {
  const s = sessions.get(sessionId);
  if (!s || s.blocks.length === 0) return null;

  const promptDenominator = s.cumulativeInput + s.cumulativeCacheRead + s.cumulativeCacheWrite;
  const cacheHitRate = s.hasUnknownUsage || promptDenominator <= 0
    ? null
    : s.cumulativeCacheRead / promptDenominator;

  return {
    sessionId,
    activeModel: s.activeModel,
    modelsUsed: Array.from(s.models.values()).map((m) => {
      const denominator = m.totalInput + m.cacheRead + m.cacheWrite;
      return {
        provider: m.provider,
        id: m.id,
        turns: m.turns,
        totalCost: m.totalCost,
        cacheHitRate: m.unknownUsage || denominator <= 0 ? null : m.cacheRead / denominator,
      };
    }),
    blocks: s.blocks,
    compactions: s.compactions,
    summary: {
      totalTokens: s.totalTokens,
      totalCost: s.totalCost,
      cacheHitRate,
      estimatedCacheSavings: s.cacheSavingsKnown && !s.hasUnknownUsage
        ? s.cumulativeCacheSavings
        : null,
      compactionCount: s.compactions.length,
      tokensFreedByCompaction: null,
      peakContextUsage: s.peakPromptTokens > 0 ? s.peakPromptTokens : null,
      contextUtilization: null,
    },
  };
}

export function resetSessionAnalysis(sessionId: string): void {
  sessions.delete(sessionId);
}

// ── Extension ───────────────────────────────────────────────────

export function sessionAnalysisExtension(pi: ExtensionAPI) {
  ensureSessionAnalysisSweep();

  pi.on("session_start", () => {
    const sessionId = process.env.PIZZAPI_SESSION_ID
      || process.env.SESSION_ID
      || "unknown";
    sessions.set(sessionId, {
      blocks: [],
      compactions: [],
      models: new Map(),
      activeModel: null,
      prevPromptTokens: 0,
      prevModelKey: null,
      hasSeenUsage: false,
      hasUnknownUsage: false,
      cumulativeCacheRead: 0,
      cumulativeCacheWrite: 0,
      cumulativeInput: 0,
      totalTokens: 0,
      totalCost: 0,
      peakPromptTokens: 0,
      cumulativeCacheSavings: 0,
      cacheSavingsKnown: true,
      updatedAt: Date.now(),
    });
  });

  pi.on("turn_end", (event: any) => {
    const sessionId = process.env.PIZZAPI_SESSION_ID
      || process.env.SESSION_ID
      || "unknown";
    const s = sessions.get(sessionId);
    if (!s) return;
    s.updatedAt = Date.now();

    const msg = event.message;
    if (!msg || msg.role !== "assistant") return;

    const provider = msg.provider as string | undefined;
    const model = msg.model as string | undefined;
    const activeModel = provider && model ? { provider, id: model } : null;
    s.activeModel = activeModel;
    const modelKey = `${provider ?? "unknown"}:${model ?? "unknown"}`;
    const stats = s.models.get(modelKey) ?? {
      provider: provider ?? "unknown",
      id: model ?? "unknown",
      turns: 0,
      totalCost: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalInput: 0,
      unknownUsage: false,
    };
    stats.turns += 1;
    s.models.set(modelKey, stats);

    const turnIndex = event.turnIndex ?? s.blocks.length;
    const entryId = typeof event.entryId === "string" ? event.entryId : `turn-${turnIndex}`;
    const isFailedTurn = msg.stopReason === "aborted" || msg.stopReason === "error";

    const rawUsage = msg.usage;
    const input = finiteNonNegative(rawUsage?.input);
    const cacheRead = finiteNonNegative(rawUsage?.cacheRead);
    const cacheWrite = finiteNonNegative(rawUsage?.cacheWrite);
    if (input == null || cacheRead == null || cacheWrite == null) {
      // Incomplete telemetry: cache metrics become unknown (unless this is a
      // failed turn, which often legitimately lacks usage) and context
      // continuity is broken either way.
      if (!isFailedTurn) s.hasUnknownUsage = true;
      if (!isFailedTurn) stats.unknownUsage = true;
      s.prevPromptTokens = null;
      return;
    }

    const output = finiteNonNegative(rawUsage?.output) ?? 0;
    const totalTokens = finiteNonNegative(rawUsage?.totalTokens)
      ?? input + output + cacheRead + cacheWrite;
    const cost = finiteNonNegative(rawUsage?.cost?.total);

    const normalizedUsage: Usage = {
      input,
      output,
      cacheRead,
      cacheWrite,
      totalTokens,
      cost: rawUsage?.cost,
    };

    stats.totalCost += cost ?? 0;
    stats.cacheRead += cacheRead;
    stats.cacheWrite += cacheWrite;
    stats.totalInput += input;

    s.cumulativeCacheRead += cacheRead;
    s.cumulativeCacheWrite += cacheWrite;
    s.cumulativeInput += input;
    s.totalTokens += totalTokens;
    s.totalCost += cost ?? 0;

    if (s.cacheSavingsKnown) {
      const turnSavings = estimateCacheReadSavings(provider, model, normalizedUsage);
      if (turnSavings == null) {
        s.cacheSavingsKnown = false;
        s.cumulativeCacheSavings = 0;
      } else {
        s.cumulativeCacheSavings += turnSavings;
      }
    }

    // Failed turns are billed but their prompt snapshot is not a trusted
    // context measurement.
    if (isFailedTurn) {
      s.blocks.push({
        role: "separator",
        turnIndex,
        entryId,
        tokens: 0,
        rawTokenDelta: 0,
        usage: normalizedUsage,
        model: activeModel ?? undefined,
      });
      s.prevPromptTokens = null;
      s.prevModelKey = modelKey;
      return;
    }

    // Prompt size spans all three buckets; `input` alone shrinks on cache hits.
    const promptTokens = input + cacheRead + cacheWrite;
    const delta = s.prevPromptTokens == null
      ? (s.hasSeenUsage ? null : promptTokens)
      : promptTokens - s.prevPromptTokens;
    const modelChanged = s.prevModelKey != null && s.prevModelKey !== modelKey;
    const isSeparator = delta == null || delta < 0 || modelChanged;
    const clampedDelta = delta == null || modelChanged ? 0 : Math.max(0, delta);

    s.blocks.push({
      role: isSeparator ? "separator" : "turn",
      turnIndex,
      entryId,
      tokens: clampedDelta,
      rawTokenDelta: delta ?? 0,
      usage: normalizedUsage,
      model: activeModel ?? undefined,
    });

    s.prevPromptTokens = promptTokens;
    s.prevModelKey = modelKey;
    s.hasSeenUsage = true;
    if (promptTokens > s.peakPromptTokens) s.peakPromptTokens = promptTokens;
  });

  pi.on("session_shutdown", () => {
    const sessionId = process.env.PIZZAPI_SESSION_ID
      || process.env.SESSION_ID
      || "unknown";
    sessions.delete(sessionId);
  });
}
