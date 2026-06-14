/**
 * Context reconstruction from JSONL session entries.
 *
 * Walks the active branch leaf→root using pi's buildSessionContext() semantics:
 * - Compaction entries create skip ranges (messages replaced by summaries)
 * - Model changes are tracked per-turn
 * - Context blocks are estimated from usage.input deltas
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

function extractUsage(raw: unknown): Usage | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const u = raw as Record<string, unknown>;
  if (typeof u.input !== "number") return undefined;
  return {
    input: u.input as number,
    output: (u.output as number) ?? 0,
    cacheRead: (u.cacheRead as number) ?? 0,
    cacheWrite: (u.cacheWrite as number) ?? 0,
    totalTokens: (u.totalTokens as number) ?? 0,
    cost: u.cost as Usage["cost"],
  };
}

function getMessageRole(msg: unknown): string | undefined {
  if (!msg || typeof msg !== "object") return undefined;
  return (msg as Record<string, unknown>).role as string | undefined;
}

function getMessageContent(msg: unknown): string {
  if (!msg || typeof msg !== "object") return "";
  const m = msg as Record<string, unknown>;
  if (typeof m.content === "string") return m.content;
  if (Array.isArray(m.content)) {
    return m.content
      .filter((c: any) => c?.type === "text")
      .map((c: any) => c.text ?? "")
      .join(" ");
  }
  return "";
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
  let currentModel: { provider: string; id: string } | null = null;
  let turnIndex = 0;
  const assistantEntries: ParsedEntry[] = [];

  for (const entry of activeEntries) {
    if (entry.type === "model_change") {
      const mce = entry as any;
      currentModel = {
        provider: mce.provider ?? "unknown",
        id: mce.modelId ?? "unknown",
      };
    }
    if (entry.type === "message" && getMessageRole((entry as any).message) === "assistant") {
      const msg = (entry as any).message;
      if (!currentModel) {
        currentModel = {
          provider: msg.provider ?? "unknown",
          id: msg.model ?? "unknown",
        };
      }
      modelByTurn.set(turnIndex, { ...currentModel });
      assistantEntries.push(entry);
      turnIndex++;
    }
  }

  // Build blocks from context deltas
  const blocks: ContextBlock[] = [];
  let prevInput = 0;
  let peakUsage = 0;
  let totalCacheRead = 0;
  let totalInput = 0;

  // Per-model aggregation
  const modelAgg = new Map<
    string,
    {
      provider: string;
      id: string;
      turns: number;
      totalCost: number;
      cacheRead: number;
      totalInput: number;
    }
  >();

  const turnBlockByEntryId = new Map<string, ContextBlock>();

  for (let i = 0; i < assistantEntries.length; i++) {
    const entry = assistantEntries[i]! as any;
    const usage = extractUsage(entry.message?.usage);
    const input = usage?.input ?? 0;
    const delta = input - prevInput;
    const clampedDelta = Math.max(0, delta);
    const isSeparator = delta < 0;

    const model = modelByTurn.get(i) ?? currentModel;
    const modelKey = `${model?.provider}:${model?.id}`;
    const stats = modelAgg.get(modelKey) ?? {
      provider: model?.provider ?? "unknown",
      id: model?.id ?? "unknown",
      turns: 0,
      totalCost: 0,
      cacheRead: 0,
      totalInput: 0,
    };
    stats.turns++;
    stats.totalCost += usage?.cost?.total ?? 0;
    stats.cacheRead += usage?.cacheRead ?? 0;
    stats.totalInput += input;
    modelAgg.set(modelKey, stats);

    // Estimate subBlocks from content length ratios within this turn
    let subBlocks: ContextBlock["subBlocks"];
    if (!isSeparator && clampedDelta > 0) {
      subBlocks = computeTurnSubBlocks(activeEntries, entry.id!, clampedDelta);
    }

    const block: ContextBlock = {
      turnIndex: i,
      entryId: entry.id ?? `turn-${i}`,
      role: isSeparator ? "separator" : "turn",
      tokens: clampedDelta,
      rawTokenDelta: delta,
      usage,
      model: model ? { provider: model.provider, id: model.id } : undefined,
      subBlocks,
    };
    blocks.push(block);
    turnBlockByEntryId.set(block.entryId, block);

    totalCacheRead += usage?.cacheRead ?? 0;
    totalInput += input;
    if (input > peakUsage) peakUsage = input;
    prevInput = input;
  }

  // Add special blocks for compaction summaries, branch summaries, custom messages
  for (const entry of activeEntries) {
    if (entry.type === "compaction" && "summary" in entry && typeof entry.summary === "string") {
      blocks.push({
        turnIndex: -1,
        entryId: entry.id ?? "compaction",
        role: "compaction_summary",
        tokens: estimateTokens(entry.summary),
        rawTokenDelta: 0,
      });
    }
    if (entry.type === "branch_summary" && "summary" in entry) {
      blocks.push({
        turnIndex: -1,
        entryId: entry.id ?? "branch-summary",
        role: "branch_summary",
        tokens: estimateTokens(typeof entry.summary === "string" ? entry.summary : ""),
        rawTokenDelta: 0,
      });
    }
    if (entry.type === "custom_message" || entry.type === "custom") {
      const customEntry = entry as any;
      const customType = (customEntry.customType as string) ?? "";
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

  // Fill in compaction estimatedTokensAfter and estimatedTokensFreed.
  // Each compaction must use the first assistant turn after that compaction in
  // the active path. Later compactions cannot reuse the first turn in the whole
  // analysis, and the post-compaction turn may be a separator (negative delta)
  // while still carrying the correct usage.input snapshot.
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
    c.estimatedTokensAfter = nextTurn?.usage?.input ?? null;
    c.estimatedTokensFreed =
      c.estimatedTokensAfter != null
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
    cacheHitRate: m.totalInput + m.cacheRead > 0 ? m.cacheRead / (m.totalInput + m.cacheRead) : 0,
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

  // Summary
  const totalTokens = assistantEntries.reduce((sum, e) => {
    const u = extractUsage((e as any).message?.usage);
    return sum + (u?.totalTokens ?? 0);
  }, 0);

  const totalCost = assistantEntries.reduce((sum, e) => {
    const u = extractUsage((e as any).message?.usage);
    return sum + (u?.cost?.total ?? 0);
  }, 0);

  const cacheHitRate = totalInput + totalCacheRead > 0 ? totalCacheRead / (totalInput + totalCacheRead) : 0;
  const estimatedCacheSavings = computeCacheSavings(assistantEntries);
  const tokensFreedByCompaction = compactions.length > 0 && compactions.every((c) => c.estimatedTokensFreed != null)
    ? compactions.reduce((sum, c) => sum + c.estimatedTokensFreed!, 0)
    : null;

  // Context utilization: use the active model's context window for simplicity
  const activeCtxWindow = activeModel?.contextWindow;
  const contextUtilization =
    activeCtxWindow && activeCtxWindow > 0 ? peakUsage / activeCtxWindow : null;

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

  const originalTurnTokens = firstTurn.tokens;
  firstTurn.tokens = Math.max(0, firstTurn.tokens - accountedContextTokens);
  if (firstTurn.subBlocks?.length && originalTurnTokens > 0) {
    const scale = firstTurn.tokens / originalTurnTokens;
    firstTurn.subBlocks = firstTurn.subBlocks
      .map((subBlock) => ({ ...subBlock, tokens: Math.round(subBlock.tokens * scale) }))
      .filter((subBlock) => subBlock.tokens > 0);
  }
}

function computeTurnSubBlocks(
  activeEntries: ParsedEntry[],
  turnAssistantId: string,
  turnTokens: number,
): ContextBlock["subBlocks"] {
  if (turnTokens <= 0) return undefined;

  // Walk backwards from the assistant to find the turn's messages
  let userTextLen = 0;
  let assistantTextLen = 0;
  let thinkingTextLen = 0;
  const toolCallLens = new Map<string, number>(); // toolCallId → content length
  const toolResultLens = new Map<string, number>(); // toolCallId → content length
  let foundAssistant = false;

  for (let i = activeEntries.length - 1; i >= 0; i--) {
    const entry = activeEntries[i]!;
    if (entry.id === turnAssistantId) {
      foundAssistant = true;
      const msg = (entry as any).message;
      const content = msg?.content;

      if (Array.isArray(content)) {
        for (const block of content) {
          if (block?.type === "text") {
            assistantTextLen += String(block.text ?? "").length;
          } else if (block?.type === "thinking") {
            thinkingTextLen += String(block.thinking ?? "").length;
          } else if (block?.type === "toolCall" || block?.type === "tool_use") {
            const callId = block.id ?? "unknown";
            const args = JSON.stringify(block.arguments ?? block.input ?? {});
            toolCallLens.set(callId, args.length);
          }
        }
      }
      continue;
    }
    if (!foundAssistant) continue;

    // We're now before the assistant, collecting turn messages
    const msg = (entry as any).message;
    if (!msg) break;
    const role = getMessageRole(msg);
    if (role === "assistant") break; // previous turn boundary

    if (role === "user") {
      userTextLen += getMessageContent(msg).length;
    } else if (role === "toolResult") {
      const callId = msg.toolCallId ?? "unknown";
      toolResultLens.set(callId, (toolResultLens.get(callId) ?? 0) + getMessageContent(msg).length);
    }
  }

  const total = userTextLen + assistantTextLen + thinkingTextLen +
    Array.from(toolCallLens.values()).reduce((a, b) => a + b, 0) +
    Array.from(toolResultLens.values()).reduce((a, b) => a + b, 0);

  if (total === 0) return undefined;

  const result: NonNullable<ContextBlock["subBlocks"]> = [];

  if (userTextLen > 0) result.push({ role: "user", tokens: Math.round(turnTokens * (userTextLen / total)) });
  if (thinkingTextLen > 0) result.push({ role: "thinking", tokens: Math.round(turnTokens * (thinkingTextLen / total)) });
  if (assistantTextLen > 0) result.push({ role: "assistant", tokens: Math.round(turnTokens * (assistantTextLen / total)) });

  // Individual tool calls
  for (const [callId, tcLen] of toolCallLens) {
    if (tcLen > 0) {
      result.push({ role: `tool:call`, tokens: Math.round(turnTokens * (tcLen / total)) });
    }
  }
  // Individual tool results
  for (const [callId, trLen] of toolResultLens) {
    if (trLen > 0) {
      result.push({ role: `tool:result`, tokens: Math.round(turnTokens * (trLen / total)) });
    }
  }

  return result.filter(b => b.tokens > 0);
}

function computeCacheSavings(assistantEntries: ParsedEntry[]): number | null {
  if (assistantEntries.length === 0) return null;

  let savings = 0;

  for (const entry of assistantEntries) {
    const e = entry as any;
    const usage = extractUsage(e.message?.usage);
    if (!usage?.cost) return null;

    const turnSavings = estimateCacheReadSavings(e.message?.provider, e.message?.model, usage);
    if (turnSavings == null) return null;
    savings += turnSavings;
  }

  return savings;
}
