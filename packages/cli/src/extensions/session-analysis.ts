/**
 * Session Analysis — live metrics accumulated from turn_end events.
 *
 * No files, no SQLite, no post-hoc parsing. Usage data is already in every
 * assistant message; we just accumulate it here and emit via session metadata.
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type {
  CompactionBoundary,
  ContextBlock,
  ModelStats,
  SessionAnalysis,
  Usage,
} from "../session-analysis/types.js";
import { estimateCacheReadSavings } from "../session-analysis/pricing.js";

// ── Per-session state ───────────────────────────────────────────

const SESSION_ANALYSIS_TTL_MS = 24 * 60 * 60_000;
const SESSION_ANALYSIS_SWEEP_MS = 5 * 60_000;

type SessionAnalysisState = {
  blocks: ContextBlock[];
  compactions: CompactionBoundary[];
  models: Map<string, ModelStats & { cacheRead: number; totalInput: number }>;
  activeModel: SessionAnalysis["activeModel"];
  prevInput: number;
  cumulativeCacheRead: number;
  cumulativeInput: number;
  totalTokens: number;
  totalCost: number;
  peakInput: number;
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

// ── Public API ──────────────────────────────────────────────────

export function getSessionAnalysis(sessionId: string): SessionAnalysis | null {
  const s = sessions.get(sessionId);
  if (!s || s.blocks.length === 0) return null;

  const cacheHitRateDenominator = s.cumulativeInput + s.cumulativeCacheRead;
  const cacheHitRate = cacheHitRateDenominator > 0
    ? s.cumulativeCacheRead / cacheHitRateDenominator
    : 0;

  return {
    sessionId,
    activeModel: s.activeModel,
    modelsUsed: Array.from(s.models.values()).map(({ cacheRead, totalInput, ...model }) => {
      const denominator = totalInput + cacheRead;
      return {
        ...model,
        cacheHitRate: denominator > 0 ? cacheRead / denominator : 0,
      };
    }),
    blocks: s.blocks,
    compactions: s.compactions,
    summary: {
      totalTokens: s.totalTokens,
      totalCost: s.totalCost,
      cacheHitRate,
      estimatedCacheSavings: s.cacheSavingsKnown ? s.cumulativeCacheSavings : null,
      compactionCount: s.compactions.length,
      tokensFreedByCompaction: null,
      peakContextUsage: s.peakInput > 0 ? s.peakInput : null,
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
      prevInput: 0,
      cumulativeCacheRead: 0,
      cumulativeInput: 0,
      totalTokens: 0,
      totalCost: 0,
      peakInput: 0,
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

    const usage = msg.usage;
    if (!usage || typeof usage.input !== "number") return;

    const input = usage.input as number;
    const cacheRead = (usage.cacheRead as number) ?? 0;
    const cacheWrite = (usage.cacheWrite as number) ?? 0;
    const output = (usage.output as number) ?? 0;
    const totalTokens = (usage.totalTokens as number) ?? input + output + cacheRead + cacheWrite;
    const cost = usage.cost?.total as number | undefined;
    const provider = msg.provider as string | undefined;
    const model = msg.model as string | undefined;
    const turnIndex = event.turnIndex ?? s.blocks.length;
    const entryId = typeof event.entryId === "string" ? event.entryId : `turn-${turnIndex}`;

    const normalizedUsage: Usage = {
      input,
      output,
      cacheRead,
      cacheWrite,
      totalTokens,
      cost: usage.cost,
    };

    const activeModel = provider && model ? { provider, id: model } : null;
    s.activeModel = activeModel;

    if (activeModel) {
      const key = `${activeModel.provider}:${activeModel.id}`;
      const stats = s.models.get(key) ?? {
        provider: activeModel.provider,
        id: activeModel.id,
        turns: 0,
        totalCost: 0,
        cacheHitRate: 0,
        cacheRead: 0,
        totalInput: 0,
      };
      stats.turns += 1;
      stats.totalCost += cost ?? 0;
      stats.cacheRead += cacheRead;
      stats.totalInput += input;
      s.models.set(key, stats);
    }

    const delta = input - s.prevInput;
    const isCompaction = delta < 0;

    if (isCompaction) {
      s.compactions.push({
        entryId,
        tokensBeforeCompaction: s.prevInput,
        estimatedSummaryTokens: input,
        estimatedTokensAfter: input,
        estimatedTokensFreed: s.prevInput - input,
        firstKeptId: entryId,
        timestamp: new Date().toISOString(),
      });
    }

    s.blocks.push({
      role: isCompaction ? "separator" : "turn",
      turnIndex,
      entryId,
      tokens: Math.max(0, delta),
      rawTokenDelta: delta,
      usage: normalizedUsage,
      model: activeModel ?? undefined,
    });

    s.prevInput = input;
    s.cumulativeCacheRead += cacheRead;
    s.cumulativeInput += input;
    s.totalTokens += totalTokens;
    s.totalCost += cost ?? 0;
    if (input > s.peakInput) s.peakInput = input;

    if (s.cacheSavingsKnown) {
      const turnSavings = estimateCacheReadSavings(provider, model, normalizedUsage);
      if (turnSavings == null) {
        s.cacheSavingsKnown = false;
        s.cumulativeCacheSavings = 0;
      } else {
        s.cumulativeCacheSavings += turnSavings;
      }
    }
  });

  pi.on("session_shutdown", () => {
    const sessionId = process.env.PIZZAPI_SESSION_ID
      || process.env.SESSION_ID
      || "unknown";
    sessions.delete(sessionId);
  });
}
