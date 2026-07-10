// ============================================================================
// payload-guards.ts — Minimal runtime decoders for critical external payloads
//
// Hand-written, dependency-free guards that validate shape at the first trusted
// boundary (viewer sockets, hub meta sockets, and the runner spawn HTTP API).
// They return typed data on success and a plain-text error on failure.
//
// Scope is intentionally narrow: these guards check the envelope and required
// fields for the three boundaries called out in the security/reliability review.
// They do NOT attempt to validate every internal relay event object.
// ============================================================================

import {
  defaultMetaState,
  META_RELAY_EVENT_TYPES,
  type MetaGoalStatus,
  type MetaMcpReport,
  type MetaModelInfo,
  type MetaPendingPlan,
  type MetaPendingQuestion,
  type MetaPluginTrustPrompt,
  type MetaProviderUsage,
  type MetaRelayEvent,
  type MetaRetryState,
  type MetaTokenUsage,
  type SessionMetaState,
} from "./meta.js";

export type ParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

// ── Helpers ─────────────────────────────────────────────────────────────────

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function optionalBoolean(value: unknown): boolean | undefined {
  return value === true ? true : undefined;
}

function optionalStringOrNull(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value === "string") return value;
  return undefined;
}

function normalizeModel(value: unknown): MetaModelInfo | null {
  if (!isPlainObject(value)) return null;
  const provider = typeof value.provider === "string" ? value.provider.trim() : "";
  const id =
    (typeof value.id === "string" ? value.id.trim() : "") ||
    (typeof value.modelId === "string" ? value.modelId.trim() : "");
  if (!provider || !id) return null;
  return {
    provider,
    id,
    name: typeof value.name === "string" ? value.name : undefined,
    reasoning: typeof value.reasoning === "boolean" ? value.reasoning : undefined,
    contextWindow: typeof value.contextWindow === "number" ? value.contextWindow : undefined,
  };
}

function normalizePendingQuestion(value: unknown): MetaPendingQuestion | null {
  if (!isPlainObject(value)) return null;
  const toolCallId = typeof value.toolCallId === "string" ? value.toolCallId : "";
  if (!toolCallId) return null;
  if (!Array.isArray(value.questions)) return null;
  const questions: MetaPendingQuestion["questions"] = [];
  for (const raw of value.questions) {
    if (!isPlainObject(raw)) continue;
    const q = typeof raw.question === "string" ? raw.question.trim() : "";
    if (!q) continue;
    const opts = Array.isArray(raw.options)
      ? raw.options
          .filter((o): o is string => typeof o === "string" && o.trim().length > 0)
          .map((o) => o.trim())
      : [];
    const type = raw.type === "checkbox" ? "checkbox" : raw.type === "ranked" ? "ranked" : "radio";
    questions.push({ question: q, options: opts, type });
  }
  if (questions.length === 0) return null;
  return {
    toolCallId,
    questions,
    display: typeof value.display === "string" ? value.display : undefined,
  };
}

function normalizePendingPlan(value: unknown): MetaPendingPlan | null {
  if (!isPlainObject(value)) return null;
  const toolCallId = typeof value.toolCallId === "string" ? value.toolCallId : "";
  const title = typeof value.title === "string" ? value.title.trim() : "";
  if (!toolCallId || !title) return null;
  const steps = Array.isArray(value.steps)
    ? value.steps
        .filter((s): s is Record<string, unknown> => isPlainObject(s))
        .map((s) => ({
          title: typeof s.title === "string" ? s.title : "",
          description: typeof s.description === "string" ? s.description : undefined,
        }))
        .filter((s) => s.title.trim().length > 0)
    : undefined;
  return {
    toolCallId,
    title,
    description: value.description === null || typeof value.description === "string" ? value.description : null,
    steps,
  };
}

function normalizeRetryState(value: unknown): MetaRetryState | null {
  if (!isPlainObject(value)) return null;
  const errorMessage = typeof value.errorMessage === "string" ? value.errorMessage : "";
  const detectedAt = typeof value.detectedAt === "number" ? value.detectedAt : NaN;
  if (!errorMessage || !Number.isFinite(detectedAt)) return null;
  return { errorMessage, detectedAt };
}

function normalizePluginTrustPrompt(value: unknown): MetaPluginTrustPrompt | null {
  if (!isPlainObject(value)) return null;
  const promptId = typeof value.promptId === "string" ? value.promptId : "";
  const pluginNames = Array.isArray(value.pluginNames)
    ? value.pluginNames.filter((n): n is string => typeof n === "string" && n.length > 0)
    : [];
  if (!promptId || pluginNames.length === 0) return null;
  const pluginSummaries = Array.isArray(value.pluginSummaries)
    ? value.pluginSummaries.filter((n): n is string => typeof n === "string")
    : pluginNames;
  return { promptId, pluginNames, pluginSummaries };
}

function normalizeMcpReport(value: unknown): MetaMcpReport | null {
  return isPlainObject(value) ? (value as MetaMcpReport) : null;
}

function normalizeTokenUsage(value: unknown): MetaTokenUsage | null {
  if (!isPlainObject(value)) return null;
  const input = typeof value.input === "number" ? value.input : NaN;
  const output = typeof value.output === "number" ? value.output : NaN;
  const cacheRead = typeof value.cacheRead === "number" ? value.cacheRead : NaN;
  const cacheWrite = typeof value.cacheWrite === "number" ? value.cacheWrite : NaN;
  const cost = typeof value.cost === "number" ? value.cost : NaN;
  if (!Number.isFinite(input + output + cacheRead + cacheWrite + cost)) return null;
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    cost,
    contextTokens:
      value.contextTokens === null || typeof value.contextTokens === "number" ? value.contextTokens : null,
  };
}

function normalizeProviderUsage(value: unknown): MetaProviderUsage | null {
  return isPlainObject(value) ? (value as MetaProviderUsage) : null;
}

function normalizeGoal(value: unknown): MetaGoalStatus | null {
  if (!isPlainObject(value)) return null;
  const id = typeof value.id === "string" ? value.id : "";
  const description = typeof value.description === "string" ? value.description : "";
  const status = value.status;
  const turnCount = typeof value.turnCount === "number" ? value.turnCount : NaN;
  const tokenSpend = typeof value.tokenSpend === "number" ? value.tokenSpend : NaN;
  const costSpend = typeof value.costSpend === "number" ? value.costSpend : NaN;
  if (!id || !description || !Number.isFinite(turnCount)) return null;
  if (!Number.isFinite(tokenSpend) || !Number.isFinite(costSpend)) return null;
  if (status !== "active" && status !== "met" && status !== "failed" && status !== "cancelled") return null;
  return {
    id,
    description,
    status,
    turnCount,
    tokenSpend,
    costSpend,
    maxTurns: typeof value.maxTurns === "number" ? value.maxTurns : undefined,
    maxTokens: typeof value.maxTokens === "number" ? value.maxTokens : undefined,
    maxCost: typeof value.maxCost === "number" ? value.maxCost : undefined,
    lastReason: typeof value.lastReason === "string" ? value.lastReason : undefined,
  };
}

// ── Viewer event envelope ───────────────────────────────────────────────────

export interface ViewerEventEnvelope {
  event: unknown;
  seq?: number;
  replay?: boolean;
  deltaReplay?: boolean;
  generation?: number;
}

export function parseViewerEventEnvelope(raw: unknown): ParseResult<ViewerEventEnvelope> {
  if (!isPlainObject(raw)) {
    return { ok: false, error: "viewer event envelope is not an object" };
  }
  if (!("event" in raw)) {
    return { ok: false, error: "viewer event envelope missing required 'event' field" };
  }
  return {
    ok: true,
    value: {
      event: raw.event,
      seq: optionalNumber(raw.seq),
      replay: optionalBoolean(raw.replay),
      deltaReplay: optionalBoolean(raw.deltaReplay),
      generation: optionalNumber(raw.generation),
    },
  };
}

// ── Viewer connected envelope ───────────────────────────────────────────────

export interface ViewerConnectedEnvelope {
  sessionId: string;
  lastSeq?: number;
  replayOnly?: boolean;
  isActive?: boolean;
  lastHeartbeatAt?: string | null;
  sessionName?: string | null;
  meta_source?: "hub";
  generation?: number;
}

export function parseViewerConnectedEnvelope(raw: unknown): ParseResult<ViewerConnectedEnvelope> {
  if (!isPlainObject(raw)) {
    return { ok: false, error: "viewer connected envelope is not an object" };
  }
  if (typeof raw.sessionId !== "string" || raw.sessionId.length === 0) {
    return { ok: false, error: "viewer connected envelope missing string sessionId" };
  }
  const meta_source = raw.meta_source === "hub" ? "hub" : undefined;
  const value: ViewerConnectedEnvelope = {
    sessionId: raw.sessionId,
    lastSeq: optionalNumber(raw.lastSeq),
    replayOnly: optionalBoolean(raw.replayOnly),
    isActive: typeof raw.isActive === "boolean" ? raw.isActive : undefined,
    lastHeartbeatAt: optionalStringOrNull(raw.lastHeartbeatAt),
    meta_source,
    generation: optionalNumber(raw.generation),
  };
  if (raw.sessionName !== undefined) {
    value.sessionName = optionalStringOrNull(raw.sessionName);
  }
  return { ok: true, value };
}

// ── Hub state snapshot ────────────────────────────────────────────────────

export function normalizeSessionMetaState(raw: unknown): SessionMetaState | null {
  if (!isPlainObject(raw)) return null;
  if (typeof raw.version !== "number") return null;

  const base = defaultMetaState();
  return {
    version: raw.version,
    todoList: Array.isArray(raw.todoList) ? raw.todoList : base.todoList,
    pendingQuestion: normalizePendingQuestion(raw.pendingQuestion),
    pendingPlan: normalizePendingPlan(raw.pendingPlan),
    planModeEnabled: typeof raw.planModeEnabled === "boolean" ? raw.planModeEnabled : base.planModeEnabled,
    isCompacting: typeof raw.isCompacting === "boolean" ? raw.isCompacting : base.isCompacting,
    retryState: normalizeRetryState(raw.retryState),
    pendingPluginTrust: normalizePluginTrustPrompt(raw.pendingPluginTrust),
    mcpStartupReport: normalizeMcpReport(raw.mcpStartupReport),
    tokenUsage: normalizeTokenUsage(raw.tokenUsage),
    providerUsage: normalizeProviderUsage(raw.providerUsage),
    thinkingLevel: raw.thinkingLevel === null || typeof raw.thinkingLevel === "string" ? raw.thinkingLevel : base.thinkingLevel,
    authSource: raw.authSource === null || typeof raw.authSource === "string" ? raw.authSource : base.authSource,
    model: normalizeModel(raw.model),
    goal: normalizeGoal(raw.goal),
  };
}

export function parseHubStateSnapshot(
  raw: unknown,
): ParseResult<{ sessionId: string; state: SessionMetaState }> {
  if (!isPlainObject(raw)) {
    return { ok: false, error: "hub state snapshot is not an object" };
  }
  if (typeof raw.sessionId !== "string" || raw.sessionId.length === 0) {
    return { ok: false, error: "hub state snapshot missing string sessionId" };
  }
  const state = normalizeSessionMetaState(raw.state);
  if (!state) {
    return { ok: false, error: "hub state snapshot has malformed state" };
  }
  return { ok: true, value: { sessionId: raw.sessionId, state } };
}

// ── Meta relay event ────────────────────────────────────────────────────────

export function parseMetaRelayEvent(raw: unknown): MetaRelayEvent | null {
  if (!isPlainObject(raw)) return null;
  const type = raw.type;
  if (typeof type !== "string" || !META_RELAY_EVENT_TYPES.has(type)) return null;

  switch (type) {
    case "todo_updated":
      return Array.isArray(raw.todoList) ? { type, todoList: raw.todoList } : null;

    case "question_pending": {
      const question = normalizePendingQuestion(raw.question);
      return question ? { type, question } : null;
    }

    case "question_cleared":
    case "plan_cleared":
      return typeof raw.toolCallId === "string" ? { type, toolCallId: raw.toolCallId } : null;

    case "plan_pending": {
      const plan = normalizePendingPlan(raw.plan);
      return plan ? { type, plan } : null;
    }

    case "plan_mode_toggled":
      return typeof raw.enabled === "boolean" ? { type, enabled: raw.enabled } : null;

    case "compact_started":
    case "compact_ended":
      return { type };

    case "retry_state_changed": {
      if (raw.state === null) return { type, state: null };
      const state = normalizeRetryState(raw.state);
      return state ? { type, state } : null;
    }

    case "plugin_trust_required": {
      const prompt = normalizePluginTrustPrompt(raw.prompt);
      return prompt ? { type, prompt } : null;
    }

    case "plugin_trust_resolved":
      return typeof raw.promptId === "string" ? { type, promptId: raw.promptId } : null;

    case "mcp_startup_report": {
      // New (nested) format only. The legacy flat format (slow/errors/ts on the
      // event root) is explicitly preserved on the relay viewer path, not the
      // hub meta path, so this decoder intentionally rejects it here.
      const report = normalizeMcpReport(raw.report);
      return report && typeof raw.ts === "number" ? { type, report, ts: raw.ts } : null;
    }

    case "token_usage_updated": {
      const tokenUsage = normalizeTokenUsage(raw.tokenUsage);
      const providerUsage = normalizeProviderUsage(raw.providerUsage);
      return tokenUsage && providerUsage ? { type, tokenUsage, providerUsage } : null;
    }

    case "thinking_level_changed":
      return raw.level === null || typeof raw.level === "string"
        ? { type, level: raw.level }
        : null;

    case "auth_source_changed":
      return raw.source === null || typeof raw.source === "string"
        ? { type, source: raw.source }
        : null;

    case "model_changed": {
      if (raw.model === null) return { type, model: null };
      const model = normalizeModel(raw.model);
      return model ? { type, model } : null;
    }

    case "goal_updated": {
      if (raw.goal === null) return { type, goal: null };
      const goal = normalizeGoal(raw.goal);
      return goal ? { type, goal } : null;
    }
  }

  return null;
}

// ── Hub meta event envelope ─────────────────────────────────────────────────

export function parseHubMetaEvent(
  raw: unknown,
): ParseResult<{ sessionId: string; version: number; event: MetaRelayEvent }> {
  if (!isPlainObject(raw)) {
    return { ok: false, error: "hub meta event is not an object" };
  }
  if (typeof raw.sessionId !== "string" || raw.sessionId.length === 0) {
    return { ok: false, error: "hub meta event missing string sessionId" };
  }
  if (typeof raw.version !== "number") {
    return { ok: false, error: "hub meta event missing numeric version" };
  }

  const { sessionId, version, ...eventRaw } = raw;
  const event = parseMetaRelayEvent(eventRaw);
  if (!event) {
    return { ok: false, error: "hub meta event payload is not a recognized meta relay event" };
  }

  return { ok: true, value: { sessionId, version, event } };
}

// ── Runner spawn API response ───────────────────────────────────────────────

export interface SpawnResponse {
  runnerId: string;
  sessionId: string;
  pending?: boolean;
}

export function parseSpawnResponse(raw: unknown): ParseResult<SpawnResponse> {
  if (!isPlainObject(raw)) {
    return { ok: false, error: "spawn response is not an object" };
  }
  if (raw.ok !== true) {
    return { ok: false, error: "spawn response ok is not true" };
  }
  if (typeof raw.runnerId !== "string" || raw.runnerId.length === 0) {
    return { ok: false, error: "spawn response missing string runnerId" };
  }
  if (typeof raw.sessionId !== "string" || raw.sessionId.length === 0) {
    return { ok: false, error: "spawn response missing string sessionId" };
  }
  return {
    ok: true,
    value: {
      runnerId: raw.runnerId,
      sessionId: raw.sessionId,
      pending: raw.pending === true ? true : undefined,
    },
  };
}
