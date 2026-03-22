import { describe, test, expect } from "bun:test";
import {
  defaultMetaState, isMetaRelayEvent, metaEventToPatch, META_RELAY_EVENT_TYPES,
} from "./meta.js";

describe("defaultMetaState", () => {
  test("returns zeroed state", () => {
    const s = defaultMetaState();
    expect(s.todoList).toEqual([]);
    expect(s.pendingQuestion).toBeNull();
    expect(s.pendingPlan).toBeNull();
    expect(s.planModeEnabled).toBe(false);
    expect(s.isCompacting).toBe(false);
    expect(s.version).toBe(0);
  });
});

describe("isMetaRelayEvent", () => {
  test("returns true for known meta event types", () => {
    for (const type of META_RELAY_EVENT_TYPES) {
      expect(isMetaRelayEvent({ type })).toBe(true);
    }
  });
  test("returns false for non-meta event types", () => {
    expect(isMetaRelayEvent({ type: "heartbeat" })).toBe(false);
    expect(isMetaRelayEvent({ type: "session_active" })).toBe(false);
    expect(isMetaRelayEvent({})).toBe(false);
    expect(isMetaRelayEvent({ type: 42 })).toBe(false);
  });
});

describe("metaEventToPatch", () => {
  test("todo_updated → todoList", () => {
    const patch = metaEventToPatch({ type: "todo_updated", todoList: [{ id: 1, text: "task", status: "pending" }] });
    expect(patch.todoList).toHaveLength(1);
  });
  test("question_pending → pendingQuestion set", () => {
    const q = { toolCallId: "tc1", questions: [{ question: "Q?", options: ["A", "B"] }] };
    expect(metaEventToPatch({ type: "question_pending", question: q })).toEqual({ pendingQuestion: q });
  });
  test("question_cleared → pendingQuestion null", () => {
    expect(metaEventToPatch({ type: "question_cleared", toolCallId: "tc1" })).toEqual({ pendingQuestion: null });
  });
  test("plan_pending → pendingPlan set", () => {
    const plan = { toolCallId: "tc1", title: "My Plan", steps: [] };
    expect(metaEventToPatch({ type: "plan_pending", plan })).toEqual({ pendingPlan: plan });
  });
  test("plan_cleared → pendingPlan null", () => {
    expect(metaEventToPatch({ type: "plan_cleared", toolCallId: "tc1" })).toEqual({ pendingPlan: null });
  });
  test("compact_started → isCompacting true", () => {
    expect(metaEventToPatch({ type: "compact_started" })).toEqual({ isCompacting: true });
  });
  test("compact_ended → isCompacting false", () => {
    expect(metaEventToPatch({ type: "compact_ended" })).toEqual({ isCompacting: false });
  });
  test("plan_mode_toggled → planModeEnabled", () => {
    expect(metaEventToPatch({ type: "plan_mode_toggled", enabled: true })).toEqual({ planModeEnabled: true });
  });
  test("retry_state_changed null clears state", () => {
    expect(metaEventToPatch({ type: "retry_state_changed", state: null })).toEqual({ retryState: null });
  });
  test("plugin_trust_required → pendingPluginTrust set", () => {
    const prompt = { promptId: "p1", pluginNames: ["myPlugin"], pluginSummaries: ["does things"] };
    expect(metaEventToPatch({ type: "plugin_trust_required", prompt })).toEqual({ pendingPluginTrust: prompt });
  });
  test("plugin_trust_resolved clears trust prompt", () => {
    expect(metaEventToPatch({ type: "plugin_trust_resolved", promptId: "p1" })).toEqual({ pendingPluginTrust: null });
  });
  test("mcp_startup_report → mcpStartupReport set", () => {
    const report = { slow: true, totalDurationMs: 5000, ts: 1234 };
    expect(metaEventToPatch({ type: "mcp_startup_report", report, ts: 1234 })).toEqual({ mcpStartupReport: report });
  });
  test("token_usage_updated → tokenUsage + providerUsage set", () => {
    const tokenUsage = { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: 0.01 };
    const providerUsage = { anthropic: { tokens: 150 } };
    const patch = metaEventToPatch({ type: "token_usage_updated", tokenUsage, providerUsage });
    expect(patch.tokenUsage).toEqual(tokenUsage);
    expect(patch.providerUsage).toEqual(providerUsage);
  });
  test("thinking_level_changed → thinkingLevel set", () => {
    expect(metaEventToPatch({ type: "thinking_level_changed", level: "high" })).toEqual({ thinkingLevel: "high" });
  });
  test("auth_source_changed → authSource set", () => {
    expect(metaEventToPatch({ type: "auth_source_changed", source: "oauth" })).toEqual({ authSource: "oauth" });
  });
  test("model_changed → model set", () => {
    const model = { provider: "anthropic", id: "claude-3", name: "Claude 3" };
    expect(metaEventToPatch({ type: "model_changed", model })).toEqual({ model });
  });
  test("model_changed null → model null", () => {
    expect(metaEventToPatch({ type: "model_changed", model: null })).toEqual({ model: null });
  });
});
