/**
 * Context reconstruction from JSONL session entries.
 *
 * Walks the active branch leaf→root using pi's buildSessionContext() semantics:
 * - Compaction entries create skip ranges (messages replaced by summaries)
 * - Model changes are tracked per-turn
 * - Context blocks are estimated from full prompt-token deltas
 * - Per-model contextWindows enable utilization calculation
 */
import type {
  ParsedEntry,
  ParsedCompactionEntry,
  ContextBlock,
  CompactionBoundary,
  SessionAnalysis,
  ModelStats,
  Usage,
} from "./types.js";
import { estimateCacheReadSavings } from "./pricing.js";

const CHARS_PER_TOKEN = 3.5;

function estimateTokens(text: string): number {
  return Math.max(1, Math.round(text.length / CHARS_PER_TOKEN));
}

function promptTokenCount(usage: Usage): number {
  return usage.input + usage.cacheRead + usage.cacheWrite;
}

function extractUsage(raw: unknown): Usage | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const u = raw as Record<string, unknown>;
  if (typeof u.input !== "number" || !Number.isFinite(u.input) || u.input < 0) return undefined;

  const numberOrZero = (value: unknown): number =>
    typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
  const optionalNumber = (value: unknown): number | undefined =>
    typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
  const cacheRead = optionalNumber(u.cacheRead);
  const cacheWrite = optionalNumber(u.cacheWrite);
  if (cacheRead == null || cacheWrite == null) return undefined;
  const rawCost = u.cost;
  const cost = rawCost && typeof rawCost === "object"
    ? (() => {
        const c = rawCost as Record<string, unknown>;
        const total = optionalNumber(c.total);
        return total == null
          ? undefined
          : {
              total,
              input: optionalNumber(c.input),
              output: optionalNumber(c.output),
              cacheRead: optionalNumber(c.cacheRead),
              cacheWrite: optionalNumber(c.cacheWrite),
            };
      })()
    : undefined;

  return {
    input: u.input,
    output: numberOrZero(u.output),
    cacheRead,
    cacheWrite,
    cacheWrite1h: optionalNumber(u.cacheWrite1h),
    reasoning: optionalNumber(u.reasoning),
    totalTokens: numberOrZero(u.totalTokens),
    cost,
  };
}

function getMessageRole(msg: unknown): string | undefined {
  if (!msg || typeof msg !== "object") return undefined;
  return (msg as Record<string, unknown>).role as string | undefined;
}

function getMessageProvider(msg: unknown): string | undefined {
  if (!msg || typeof msg !== "object") return undefined;
  return (msg as Record<string, unknown>).provider as string | undefined;
}

function getMessageModel(msg: unknown): string | undefined {
  if (!msg || typeof msg !== "object") return undefined;
  return (msg as Record<string, unknown>).model as string | undefined;
}

function extractCustomTelemetryContent(data: unknown): string {
  if (typeof data === "string") return data;
  if (!data || typeof data !== "object") return "";
  const content = (data as Record<string, unknown>).content;
  if (typeof content === "string") return content;
  return "";
}

/**
 * Reconstruct context blocks, compaction boundaries, and per-model stats
 * from a full set of JSONL entries.
 *
 * @param entries All parsed entries from the session JSONL
 * @param leafId The ID of the current leaf entry
 * @param contextWindows Map of "provider:modelId" → context window size (may be empty)
 */
export function reconstructContext(
  entries: ParsedEntry[],
  leafId: string,
  contextWindows?: Map<string, number>,
): SessionAnalysis {
  const sessionEntry = entries.find((e) => e.type === "session");
  const sessionId = (sessionEntry as any)?.id ?? "unknown";

  // Build entry lookup and parent map
  const byId = new Map<string, ParsedEntry>();
  const parentMap = new Map<string, string>();
  for (const e of entries) {
    if (e.id) byId.set(e.id, e);
    if (e.id && "parentId" in e && typeof e.parentId === "string") {
      parentMap.set(e.id, e.parentId);
    }
  }

  // Walk leaf → root to collect the active path
  const path: ParsedEntry[] = [];
  let current = leafId;
  while (current && byId.has(current)) {
    const entry = byId.get(current)!;
    path.unshift(entry);
    current = parentMap.get(current) ?? "";
  }

  // Identify compaction skip ranges
  const compactionSkips = new Set<string>();
  const compactions: CompactionBoundary[] = [];

  for (const entry of path) {
    if (entry.type === "compaction") {
      const ce = entry as ParsedCompactionEntry;
      if (ce.firstKeptEntryId) {
        let skipId = parentMap.get(ce.firstKeptEntryId) ?? "";
        while (skipId && byId.has(skipId)) {
          compactionSkips.add(skipId);
          skipId = parentMap.get(skipId) ?? "";
        }
      }
      const summaryTokens = typeof ce.summary === "string"
        ? estimateTokens(ce.summary)
        : 0;
      compactions.push({
        entryId: ce.id ?? "unknown",
        tokensBeforeCompaction: ce.tokensBefore ?? 0,
        estimatedSummaryTokens: summaryTokens,
        estimatedTokensAfter: null,
        estimatedTokensFreed: null,
        firstKeptId: ce.firstKeptEntryId,
        timestamp: ce.timestamp ?? "",
      });
    }
  }

  // Collect assistant messages from the active path (excluding compacted entries)
  const activeEntries = path.filter((e) => !compactionSkips.has(e.id!));

  // Track model changes and build a model-per-turn map
  const modelByTurn = new Map<
    number,
    { provider: string; id: string }
  >();
  const boundaryBeforeTurn = new Map<number, boolean>();
  let currentModel: { provider: string; id: string } | null = null;
  let turnIndex = 0;
  let hasContextBoundary = false;
  const assistantEntries: ParsedEntry[] = [];

  for (const entry of activeEntries) {
    if (entry.type === "compaction" || entry.type === "branch_summary") {
      hasContextBoundary = true;
    }
    if (entry.type === "model_change") {
      const mce = entry as any;
      currentModel = {
        provider: typeof mce.provider === "string" ? mce.provider : "unknown",
        id: typeof mce.modelId === "string" ? mce.modelId : "unknown",
      };
    }
    if (entry.type === "message" && getMessageRole((entry as any).message) === "assistant") {
      const msg = (entry as any).message;
      const provider = getMessageProvider(msg);
      const modelId = getMessageModel(msg);
      // The assistant message is authoritative. model_change is only a
      // fallback for older/transformed entries that lack this metadata.
      if (provider && modelId) currentModel = { provider, id: modelId };
      currentModel ??= { provider: "unknown", id: "unknown" };
      boundaryBeforeTurn.set(turnIndex, hasContextBoundary);
      hasContextBoundary = false;
      modelByTurn.set(turnIndex, { ...currentModel });
      assistantEntries.push(entry);
      turnIndex++;
    }
  }

  // Build blocks from context deltas
  const blocks: ContextBlock[] = [];
  let previousPromptTokens: number | null = 0;
  let previousModelKey: string | null = null;
  let hasSeenUsage = false;
  let peakUsage = 0;
  let peakContextUtilization = 0;
  let hasContextUtilization = false;
  let totalCacheRead = 0;
  let totalCacheWrite = 0;
  let totalInput = 0;
  let hasUnknownUsage = false;

  // Per-model aggregation
  const modelAgg = new Map<
    string,
    {
      provider: string;
      id: string;
      turns: number;
      totalCost: number;
      cacheRead: number;
      cacheWrite: number;
      totalInput: number;
      unknownUsage: boolean;
    }
  >();

  const turnBlockByEntryId = new Map<string, ContextBlock>();

  for (let i = 0; i < assistantEntries.length; i++) {
    const entry = assistantEntries[i]! as any;
    const usage = extractUsage(entry.message?.usage);
    const model = modelByTurn.get(i) ?? currentModel;
    const modelKey = `${model?.provider ?? "unknown"}:${model?.id ?? "unknown"}`;
    const stats = modelAgg.get(modelKey) ?? {
      provider: model?.provider ?? "unknown",
      id: model?.id ?? "unknown",
      turns: 0,
      totalCost: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalInput: 0,
      unknownUsage: false,
    };
    stats.turns++;
    stats.totalCost += usage?.cost?.total ?? 0;
    if (!usage) {
      stats.unknownUsage = true;
      hasUnknownUsage = true;
      modelAgg.set(modelKey, stats);
      previousPromptTokens = null;
      continue;
    }

    // Pi's `input` excludes cache reads and writes. The prompt snapshot is the
    // sum of all three buckets, which is the only value comparable across turns.
    const promptTokens = promptTokenCount(usage);
    const delta = previousPromptTokens == null
      ? (hasSeenUsage ? null : promptTokens)
      : promptTokens - previousPromptTokens;
    const modelChanged = previousModelKey != null && previousModelKey !== modelKey;
    const hasContextBoundary = boundaryBeforeTurn.get(i) === true;
    const isSeparator = delta == null || delta < 0 || modelChanged || hasContextBoundary;
    const clampedDelta = delta == null || modelChanged || hasContextBoundary ? 0 : Math.max(0, delta);

    stats.cacheRead += usage.cacheRead;
    stats.cacheWrite += usage.cacheWrite;
    stats.totalInput += usage.input;
    modelAgg.set(modelKey, stats);

    const block: ContextBlock = {
      turnIndex: i,
      entryId: entry.id ?? `turn-${i}`,
      role: isSeparator ? "separator" : "turn",
      tokens: clampedDelta,
      rawTokenDelta: delta ?? 0,
      usage,
      model: model ? { provider: model.provider, id: model.id } : undefined,
      // Per-role attribution is intentionally omitted: assistant text and
      // thinking are generated by this request, not part of its prompt.
    };
    blocks.push(block);
    turnBlockByEntryId.set(block.entryId, block);

    totalCacheRead += usage.cacheRead;
    totalCacheWrite += usage.cacheWrite;
    totalInput += usage.input;
    if (promptTokens > peakUsage) peakUsage = promptTokens;
    const contextWindow = contextWindows?.get(modelKey);
    if (contextWindow && contextWindow > 0) {
      peakContextUtilization = Math.max(peakContextUtilization, promptTokens / contextWindow);
      hasContextUtilization = true;
    }
    previousPromptTokens = promptTokens;
    previousModelKey = modelKey;
    hasSeenUsage = true;
  }

  // Context telemetry is independently attributable because the extension
  // records its sections explicitly. Compaction, branch, and custom-message
  // text is already included in the provider's prompt snapshot, so adding it
  // as another sized block would double-count it.
  for (const entry of activeEntries) {
    if (entry.type === "custom_message" || entry.type === "custom") {
      const customEntry = entry as any;
      const customType = (customEntry.customType as string) ?? "";
      if (!customType.startsWith("context:")) continue;
      const content = entry.type === "custom"
        ? extractCustomTelemetryContent(customEntry.data)
        : typeof customEntry.content === "string"
          ? customEntry.content
          : JSON.stringify(customEntry.content ?? "");
      if (!content) continue;

      // Map known customType prefixes to specific roles for coloring/labeling
      let role: string = "custom_message";
      let title: string | undefined;

      if (customType.startsWith("context:")) {
        if (customType === "context:builtin-prompt") {
          role = "context:builtin-prompt";
          title = "Built-in Prompt";
        } else if (customType === "context:global-rules") {
          role = "context:global-rules";
          title = "Global Rules";
        } else if (customType === "context:project-rules") {
          role = "context:project-rules";
          title = "Project Rules";
        } else if (customType === "context:append-prompt") {
          role = "context:append-prompt";
          title = "Custom Prompt";
        } else if (customType.startsWith("context:skill:")) {
          role = "context:skill";
          title = `Skill: ${customType.slice(15)}`;
        } else {
          role = "context:plugin";
          title = customType;
        }
      }

      blocks.push({
        turnIndex: -1,
        entryId: entry.id ?? "custom-msg",
        role,
        tokens: estimateTokens(content),
        rawTokenDelta: 0,
        title,
      });
    }
  }

  subtractContextTelemetryFromFirstTurn(blocks);

  // Fill in compaction estimates from the first assistant turn after each
  // compaction. A freed-token estimate is only shown when no new user/tool
  // context was added before that turn.
  const activeEntryIndexById = new Map<string, number>();
  activeEntries.forEach((entry, index) => {
    if (entry.id) activeEntryIndexById.set(entry.id, index);
  });

  for (const c of compactions) {
    const compactionIndex = activeEntryIndexById.get(c.entryId);
    const nextAssistantEntry = compactionIndex == null
      ? undefined
      : activeEntries.slice(compactionIndex + 1).find(
        (entry) => entry.type === "message" && getMessageRole((entry as any).message) === "assistant",
      );
    const nextTurn = nextAssistantEntry?.id
      ? turnBlockByEntryId.get(nextAssistantEntry.id)
      : undefined;
    c.estimatedTokensAfter = nextTurn?.usage
      ? promptTokenCount(nextTurn.usage)
      : null;

    // Once new user/tool context was added, the later prompt is not a clean
    // post-compaction snapshot, so the amount freed is unknowable.
    const nextAssistantIndex = nextAssistantEntry?.id
      ? activeEntryIndexById.get(nextAssistantEntry.id)
      : undefined;
    const entriesBetweenCompactionAndTurn = compactionIndex != null && nextAssistantIndex != null
      ? activeEntries.slice(compactionIndex + 1, nextAssistantIndex)
      : [];
    const hasNewContext = compactionIndex == null || nextAssistantIndex == null
      ? true
      : entriesBetweenCompactionAndTurn.some((entry) =>
          entry.type === "custom_message" ||
          entry.type === "branch_summary" ||
          entry.type === "compaction" ||
          (entry.type === "custom" && typeof (entry as any).customType === "string" && (entry as any).customType.startsWith("context:")) ||
          (entry.type === "message" && ["user", "toolResult"].includes(getMessageRole((entry as any).message) ?? "")),
        );
    const hasModelChange = entriesBetweenCompactionAndTurn.some((entry) => entry.type === "model_change");
    const previousAssistant = compactionIndex == null
      ? undefined
      : activeEntries.slice(0, compactionIndex).reverse().find(
          (entry) => entry.type === "message" && getMessageRole((entry as any).message) === "assistant",
        );
    const previousProvider = previousAssistant ? getMessageProvider((previousAssistant as any).message) : undefined;
    const previousModel = previousAssistant ? getMessageModel((previousAssistant as any).message) : undefined;
    const nextProvider = nextAssistantEntry ? getMessageProvider((nextAssistantEntry as any).message) : undefined;
    const nextModel = nextAssistantEntry ? getMessageModel((nextAssistantEntry as any).message) : undefined;
    const modelsDiffer = previousAssistant != null &&
      (!previousProvider || !previousModel || !nextProvider || !nextModel ||
        previousProvider !== nextProvider || previousModel !== nextModel);
    c.estimatedTokensFreed =
      !hasNewContext && !hasModelChange && !modelsDiffer &&
      c.tokensBeforeCompaction > 0 && c.estimatedTokensAfter != null
        ? c.tokensBeforeCompaction - c.estimatedTokensAfter
        : null;
  }

  // Per-model stats
  const modelsUsed: ModelStats[] = Array.from(modelAgg.values()).map((m) => ({
    provider: m.provider,
    id: m.id,
    contextWindow: contextWindows?.get(`${m.provider}:${m.id}`),
    turns: m.turns,
    totalCost: m.totalCost,
    cacheHitRate: m.unknownUsage
      ? null
      : m.totalInput + m.cacheRead + m.cacheWrite > 0
        ? m.cacheRead / (m.totalInput + m.cacheRead + m.cacheWrite)
        : null,
  }));

  // Active model at leaf (latest model seen on the active path). This may be a
  // trailing model_change entry after the last assistant turn.
  const activeModelSource = currentModel ?? modelByTurn.get(assistantEntries.length - 1);
  const activeModel = activeModelSource
    ? {
        provider: activeModelSource.provider,
        id: activeModelSource.id,
        contextWindow: contextWindows?.get(`${activeModelSource.provider}:${activeModelSource.id}`),
      }
    : null;

  // Summary. Compaction and branch-summary generation calls also carry usage,
  // but they are not assistant messages and must still count toward totals and
  // cache metrics when their telemetry is complete.
  const auxiliaryEntries = activeEntries.filter(
    (entry) => entry.type === "compaction" || entry.type === "branch_summary",
  );
  const auxiliaryUsage = auxiliaryEntries.map((entry) => extractUsage((entry as any).usage));
  const hasUnknownAuxiliaryUsage = auxiliaryUsage.some((usage) => usage == null);
  const assistantUsage = assistantEntries.map((entry) => extractUsage((entry as any).message?.usage));
  const allUsage = [...assistantUsage, ...auxiliaryUsage]
    .filter((usage): usage is Usage => usage != null);
  for (const usage of auxiliaryUsage) {
    if (!usage) continue;
    totalInput += usage.input;
    totalCacheRead += usage.cacheRead;
    totalCacheWrite += usage.cacheWrite;
  }
  const totalTokens = allUsage.reduce((sum, usage) => sum + usage.totalTokens, 0);
  const totalCost = allUsage.reduce((sum, usage) => sum + (usage.cost?.total ?? 0), 0);

  const cacheHitRate = hasUnknownUsage || hasUnknownAuxiliaryUsage
    ? null
    : totalInput + totalCacheRead + totalCacheWrite > 0
      ? totalCacheRead / (totalInput + totalCacheRead + totalCacheWrite)
      : null;
  const estimatedCacheSavings = hasUnknownUsage || hasUnknownAuxiliaryUsage
    ? null
    : computeCacheSavings(allUsage);
  const tokensFreedByCompaction = compactions.length > 0 && compactions.every((c) => c.estimatedTokensFreed != null)
    ? compactions.reduce((sum, c) => sum + c.estimatedTokensFreed!, 0)
    : null;

  // A session can use multiple context windows. Compare each prompt to the
  // window of the model that received it, then keep the highest ratio.
  const contextUtilization = hasContextUtilization ? peakContextUtilization : null;

  return {
    sessionId,
    activeModel,
    modelsUsed,
    blocks,
    compactions,
    summary: {
      totalTokens,
      totalCost,
      cacheHitRate,
      estimatedCacheSavings,
      compactionCount: compactions.length,
      tokensFreedByCompaction,
      peakContextUsage: peakUsage > 0 ? peakUsage : null,
      contextUtilization,
    },
  };
}

function subtractContextTelemetryFromFirstTurn(blocks: ContextBlock[]): void {
  const contextBlocks = blocks.filter((block) => block.role.startsWith("context:"));
  if (contextBlocks.length === 0) return;

  const firstTurn = blocks.find((block) => block.turnIndex === 0 && block.role === "turn");
  if (!firstTurn || firstTurn.tokens <= 0) return;

  const contextTotal = contextBlocks.reduce((sum, block) => sum + (block.tokens ?? 0), 0);
  if (contextTotal <= 0) return;

  let accountedContextTokens = contextTotal;
  if (contextTotal > firstTurn.tokens) {
    const scale = firstTurn.tokens / contextTotal;
    accountedContextTokens = 0;
    for (const block of contextBlocks) {
      block.tokens = Math.max(0, Math.round((block.tokens ?? 0) * scale));
      accountedContextTokens += block.tokens;
    }
  }

  firstTurn.tokens = Math.max(0, firstTurn.tokens - accountedContextTokens);
}

function computeCacheSavings(usages: Usage[]): number | null {
  if (usages.length === 0) return null;

  let savings = 0;

  for (const usage of usages) {
    const turnSavings = estimateCacheReadSavings(undefined, undefined, usage);
    if (turnSavings == null) return null;
    savings += turnSavings;
  }

  return savings;
}
