import { describe, expect, test } from "bun:test";
import {
  parseViewerEventEnvelope,
  parseViewerConnectedEnvelope,
  parseHubStateSnapshot,
  parseHubMetaEvent,
  parseMetaRelayEvent,
  parseSpawnResponse,
  normalizeSessionMetaState,
  type ViewerEventEnvelope,
  type ViewerConnectedEnvelope,
  type SpawnResponse,
} from "./payload-guards.js";

// ============================================================================
// Table-driven runtime decoder tests
// ============================================================================

describe("parseViewerEventEnvelope", () => {
  test("accepts valid minimal envelope", () => {
    const result = parseViewerEventEnvelope({ event: { type: "heartbeat" } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.event).toEqual({ type: "heartbeat" });
    expect(result.value.seq).toBeUndefined();
    expect(result.value.generation).toBeUndefined();
  });

  test("accepts full envelope", () => {
    const input: ViewerEventEnvelope = {
      event: { type: "message_update", content: "hi" },
      seq: 42,
      replay: true,
      deltaReplay: true,
      generation: 7,
    };
    const result = parseViewerEventEnvelope(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual(input);
  });

  const malformed = [
    { label: "null", value: null, expectOk: false },
    { label: "string", value: "bad", expectOk: false },
    { label: "missing event", value: { seq: 1 }, expectOk: false },
    { label: "seq is string", value: { event: {}, seq: "42" }, expectOk: true, expectUndefined: "seq" },
    { label: "generation is string", value: { event: {}, generation: "1" }, expectOk: true, expectUndefined: "generation" },
  ];

  for (const { label, value, expectOk, expectUndefined } of malformed) {
    test(`handles ${label}`, () => {
      const result = parseViewerEventEnvelope(value);
      expect(result.ok).toBe(expectOk);
      if (expectOk && result.ok && expectUndefined) {
        expect(result.value[expectUndefined as keyof ViewerEventEnvelope]).toBeUndefined();
      }
      if (!result.ok) expect(result.error).toMatch(/viewer event envelope/);
    });
  }
});

describe("parseViewerConnectedEnvelope", () => {
  test("accepts minimal connected envelope", () => {
    const result = parseViewerConnectedEnvelope({ sessionId: "sess-1" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.sessionId).toBe("sess-1");
    expect(result.value.meta_source).toBeUndefined();
  });

  test("accepts full envelope", () => {
    const input: ViewerConnectedEnvelope = {
      sessionId: "sess-2",
      lastSeq: 10,
      replayOnly: true,
      isActive: false,
      lastHeartbeatAt: null,
      sessionName: "My session",
      meta_source: "hub",
      generation: 3,
    };
    const result = parseViewerConnectedEnvelope(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual(input);
  });

  const malformed = [
    { label: "primitive", value: 123, expectOk: false },
    { label: "missing sessionId", value: { lastSeq: 1 }, expectOk: false },
    { label: "empty sessionId", value: { sessionId: "" }, expectOk: false },
    { label: "meta_source not hub", value: { sessionId: "s", meta_source: "other" }, expectOk: true },
    { label: "generation string", value: { sessionId: "s", generation: "2" }, expectOk: true },
  ];

  for (const { label, value, expectOk } of malformed) {
    test(`handles ${label}`, () => {
      const result = parseViewerConnectedEnvelope(value);
      expect(result.ok).toBe(expectOk);
      if (!result.ok) expect(result.error).toMatch(/viewer connected envelope/);
    });
  }
});

describe("normalizeSessionMetaState", () => {
  test("returns null for non-object", () => {
    expect(normalizeSessionMetaState(null)).toBeNull();
    expect(normalizeSessionMetaState("bad")).toBeNull();
  });

  test("returns null when version is missing", () => {
    expect(normalizeSessionMetaState({})).toBeNull();
  });

  test("normalizes a valid full state", () => {
    const state = {
      version: 5,
      todoList: [{ id: 1, text: "t", status: "pending" }],
      pendingQuestion: {
        toolCallId: "tc1",
        questions: [{ question: "Q?", options: ["a", "b"], type: "radio" }],
      },
      pendingPlan: { toolCallId: "tc2", title: "Plan", steps: [{ title: "Step" }] },
      planModeEnabled: true,
      isCompacting: true,
      retryState: { errorMessage: "e", detectedAt: 1 },
      pendingPluginTrust: { promptId: "p1", pluginNames: ["x"], pluginSummaries: ["s"] },
      mcpStartupReport: { slow: true, ts: 123 },
      tokenUsage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0.1 },
      providerUsage: { anthropic: { tokens: 1 } },
      thinkingLevel: "high",
      authSource: "oauth",
      model: { provider: "a", id: "m", name: "M" },
      goal: { id: "g1", description: "G", status: "active", turnCount: 1, tokenSpend: 0, costSpend: 0 },
    };
    const result = normalizeSessionMetaState(state);
    expect(result).not.toBeNull();
    if (!result) return;
    expect(result.version).toBe(5);
    expect(result.todoList).toHaveLength(1);
    expect(result.pendingQuestion?.toolCallId).toBe("tc1");
    expect(result.pendingPlan?.title).toBe("Plan");
    expect(result.planModeEnabled).toBe(true);
    expect(result.isCompacting).toBe(true);
    expect(result.retryState?.errorMessage).toBe("e");
    expect(result.pendingPluginTrust?.promptId).toBe("p1");
    expect(result.mcpStartupReport).toEqual({ slow: true, ts: 123 });
    expect(result.tokenUsage?.cost).toBe(0.1);
    expect(result.providerUsage).toEqual({ anthropic: { tokens: 1 } });
    expect(result.thinkingLevel).toBe("high");
    expect(result.authSource).toBe("oauth");
    expect(result.model?.id).toBe("m");
    expect(result.goal?.status).toBe("active");
  });

  test("replaces invalid fields with safe defaults instead of crashing", () => {
    const state = {
      version: 1,
      todoList: "not-an-array",
      pendingQuestion: "bad",
      pendingPlan: 123,
      planModeEnabled: "yes",
      isCompacting: "no",
      retryState: "oops",
      pendingPluginTrust: null,
      mcpStartupReport: null,
      tokenUsage: "nope",
      providerUsage: [],
      thinkingLevel: 42,
      authSource: 42,
      model: "none",
      goal: "none",
    };
    const result = normalizeSessionMetaState(state);
    expect(result).not.toBeNull();
    if (!result) return;
    expect(result.todoList).toEqual([]);
    expect(result.pendingQuestion).toBeNull();
    expect(result.pendingPlan).toBeNull();
    expect(result.planModeEnabled).toBe(false);
    expect(result.isCompacting).toBe(false);
    expect(result.retryState).toBeNull();
    expect(result.tokenUsage).toBeNull();
    expect(result.providerUsage).toBeNull();
    expect(result.thinkingLevel).toBeNull();
    expect(result.authSource).toBeNull();
    expect(result.model).toBeNull();
    expect(result.goal).toBeNull();
  });

  test("preserves legacy modelId field", () => {
    const result = normalizeSessionMetaState({
      version: 1,
      model: { provider: "a", modelId: "legacy-model" },
    });
    expect(result).not.toBeNull();
    if (!result) return;
    expect(result.model?.id).toBe("legacy-model");
  });
});

describe("parseHubStateSnapshot", () => {
  test("accepts valid snapshot", () => {
    const result = parseHubStateSnapshot({ sessionId: "s1", state: { version: 1 } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.sessionId).toBe("s1");
    expect(result.value.state.version).toBe(1);
  });

  const malformed = [
    { label: "non-object", value: "bad" },
    { label: "missing sessionId", value: { state: { version: 1 } } },
    { label: "missing state", value: { sessionId: "s1" } },
    { label: "state missing version", value: { sessionId: "s1", state: {} } },
  ];

  for (const { label, value } of malformed) {
    test(`rejects ${label}`, () => {
      const result = parseHubStateSnapshot(value);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/hub state snapshot/);
    });
  }
});

describe("parseMetaRelayEvent", () => {
  test("accepts all known event types with required fields", () => {
    const cases: Array<{ input: Record<string, unknown>; check: (ev: ReturnType<typeof parseMetaRelayEvent>) => void }> = [
      { input: { type: "todo_updated", todoList: [] }, check: (ev) => expect(ev?.type).toBe("todo_updated") },
      { input: { type: "question_pending", question: { toolCallId: "tc", questions: [{ question: "Q", options: [] }] } }, check: (ev) => expect(ev?.type).toBe("question_pending") },
      { input: { type: "question_cleared", toolCallId: "tc" }, check: (ev) => expect(ev?.type).toBe("question_cleared") },
      { input: { type: "plan_pending", plan: { toolCallId: "tc", title: "T" } }, check: (ev) => expect(ev?.type).toBe("plan_pending") },
      { input: { type: "plan_cleared", toolCallId: "tc" }, check: (ev) => expect(ev?.type).toBe("plan_cleared") },
      { input: { type: "plan_mode_toggled", enabled: true }, check: (ev) => expect(ev?.type).toBe("plan_mode_toggled") },
      { input: { type: "compact_started" }, check: (ev) => expect(ev?.type).toBe("compact_started") },
      { input: { type: "retry_state_changed", state: null }, check: (ev) => expect(ev?.type).toBe("retry_state_changed") },
      { input: { type: "retry_state_changed", state: { errorMessage: "e", detectedAt: 1 } }, check: (ev) => expect((ev as any).state?.errorMessage).toBe("e") },
      { input: { type: "plugin_trust_required", prompt: { promptId: "p", pluginNames: ["x"] } }, check: (ev) => expect(ev?.type).toBe("plugin_trust_required") },
      { input: { type: "plugin_trust_resolved", promptId: "p" }, check: (ev) => expect(ev?.type).toBe("plugin_trust_resolved") },
      { input: { type: "mcp_startup_report", report: { slow: true }, ts: 1 }, check: (ev) => expect(ev?.type).toBe("mcp_startup_report") },
      { input: { type: "token_usage_updated", tokenUsage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0 }, providerUsage: {} }, check: (ev) => expect(ev?.type).toBe("token_usage_updated") },
      { input: { type: "thinking_level_changed", level: null }, check: (ev) => expect(ev?.type).toBe("thinking_level_changed") },
      { input: { type: "auth_source_changed", source: null }, check: (ev) => expect(ev?.type).toBe("auth_source_changed") },
      { input: { type: "model_changed", model: null }, check: (ev) => expect(ev?.type).toBe("model_changed") },
      { input: { type: "goal_updated", goal: null }, check: (ev) => expect(ev?.type).toBe("goal_updated") },
    ];

    for (const { input, check } of cases) {
      const ev = parseMetaRelayEvent(input);
      expect(ev).not.toBeNull();
      check(ev);
    }
  });

  test("rejects events with missing required fields", () => {
    const missing = [
      { type: "todo_updated" },
      { type: "question_pending" },
      { type: "question_cleared" },
      { type: "plan_pending", plan: { title: "T" } },
      { type: "plan_mode_toggled" },
      { type: "plugin_trust_resolved" },
      { type: "token_usage_updated", tokenUsage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0 } },
      { type: "mcp_startup_report", report: { slow: true } },
      { type: "model_changed", model: { name: "M" } },
      { type: "goal_updated", goal: { id: "g" } },
    ];

    for (const input of missing) {
      expect(parseMetaRelayEvent(input)).toBeNull();
    }
  });

  test("rejects unknown discriminator", () => {
    expect(parseMetaRelayEvent({ type: "not_real" })).toBeNull();
  });

  test("rejects legacy flat mcp_startup_report on the meta path", () => {
    // Legacy CLI emits slow/errors/ts on the event root. It must still reach
    // relay viewers, but it is intentionally not a valid hub meta event.
    const legacy = { type: "mcp_startup_report", slow: true, ts: 123 };
    expect(parseMetaRelayEvent(legacy)).toBeNull();
  });
});

describe("parseHubMetaEvent", () => {
  test("accepts valid meta event envelope", () => {
    const result = parseHubMetaEvent({
      sessionId: "s1",
      version: 2,
      type: "todo_updated",
      todoList: [],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.sessionId).toBe("s1");
    expect(result.value.version).toBe(2);
    expect(result.value.event.type).toBe("todo_updated");
  });

  const malformed = [
    { label: "non-object", value: "bad" },
    { label: "missing sessionId", value: { version: 1, type: "todo_updated", todoList: [] } },
    { label: "missing version", value: { sessionId: "s1", type: "todo_updated", todoList: [] } },
    { label: "invalid payload", value: { sessionId: "s1", version: 1, type: "todo_updated" } },
  ];

  for (const { label, value } of malformed) {
    test(`rejects ${label}`, () => {
      const result = parseHubMetaEvent(value);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/hub meta event/);
    });
  }
});

describe("parseSpawnResponse", () => {
  test("accepts valid response", () => {
    const input: SpawnResponse & { ok: true } = {
      ok: true,
      runnerId: "r1",
      sessionId: "s1",
      pending: true,
    };
    const result = parseSpawnResponse(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({ runnerId: "r1", sessionId: "s1", pending: true });
  });

  test("accepts response without pending", () => {
    const result = parseSpawnResponse({ ok: true, runnerId: "r1", sessionId: "s1" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.pending).toBeUndefined();
  });

  const malformed = [
    { label: "non-object", value: "bad" },
    { label: "ok false", value: { ok: false, runnerId: "r1", sessionId: "s1" } },
    { label: "missing ok", value: { runnerId: "r1", sessionId: "s1" } },
    { label: "missing runnerId", value: { ok: true, sessionId: "s1" } },
    { label: "missing sessionId", value: { ok: true, runnerId: "r1" } },
    { label: "sessionId not string", value: { ok: true, runnerId: "r1", sessionId: 123 } },
  ];

  for (const { label, value } of malformed) {
    test(`rejects ${label}`, () => {
      const result = parseSpawnResponse(value);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/spawn response/);
    });
  }
});
