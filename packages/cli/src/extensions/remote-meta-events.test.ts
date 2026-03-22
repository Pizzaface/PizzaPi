import { describe, test, expect } from "bun:test";
import {
  emitTodoUpdated, emitQuestionPending, emitQuestionCleared, emitPlanPending,
  emitPlanCleared, emitPlanModeToggled, emitCompactStarted, emitCompactEnded,
  emitRetryStateChanged, emitPluginTrustRequired, emitPluginTrustResolved,
  emitMcpStartupReport, emitTokenUsageUpdated, emitThinkingLevelChanged,
  emitAuthSourceChanged, emitModelChanged,
} from "./remote-meta-events.js";

type ForwardedEvent = Record<string, unknown>;
function makeRctx() {
  const events: ForwardedEvent[] = [];
  return { forwardEvent: (e: unknown) => { events.push(e as ForwardedEvent); }, events };
}

describe("remote-meta-events", () => {
  test("emitTodoUpdated", () => {
    const rctx = makeRctx();
    const todos = [{ id: 1, text: "task", status: "pending" as const }];
    emitTodoUpdated(rctx as any, todos);
    expect(rctx.events[0]).toMatchObject({ type: "todo_updated", todoList: todos });
  });
  test("emitQuestionPending", () => {
    const rctx = makeRctx();
    const q = { toolCallId: "tc1", questions: [{ question: "Q?", options: ["A"] }] };
    emitQuestionPending(rctx as any, q);
    expect(rctx.events[0]).toMatchObject({ type: "question_pending", question: q });
  });
  test("emitQuestionCleared", () => {
    const rctx = makeRctx();
    emitQuestionCleared(rctx as any, "tc1");
    expect(rctx.events[0]).toMatchObject({ type: "question_cleared", toolCallId: "tc1" });
  });
  test("emitPlanPending", () => {
    const rctx = makeRctx();
    const plan = { toolCallId: "tc1", title: "My Plan" };
    emitPlanPending(rctx as any, plan);
    expect(rctx.events[0]).toMatchObject({ type: "plan_pending", plan });
  });
  test("emitPlanCleared", () => {
    const rctx = makeRctx();
    emitPlanCleared(rctx as any, "tc1");
    expect(rctx.events[0]).toMatchObject({ type: "plan_cleared", toolCallId: "tc1" });
  });
  test("emitPlanModeToggled", () => {
    const rctx = makeRctx();
    emitPlanModeToggled(rctx as any, true);
    expect(rctx.events[0]).toMatchObject({ type: "plan_mode_toggled", enabled: true });
  });
  test("emitCompactStarted + emitCompactEnded", () => {
    const rctx = makeRctx();
    emitCompactStarted(rctx as any);
    emitCompactEnded(rctx as any);
    expect(rctx.events[0]?.type).toBe("compact_started");
    expect(rctx.events[1]?.type).toBe("compact_ended");
  });
  test("emitRetryStateChanged null", () => {
    const rctx = makeRctx();
    emitRetryStateChanged(rctx as any, null);
    expect(rctx.events[0]).toMatchObject({ type: "retry_state_changed", state: null });
  });
  test("emitPluginTrustRequired", () => {
    const rctx = makeRctx();
    const prompt = { promptId: "p1", pluginNames: ["plg"], pluginSummaries: ["does x"] };
    emitPluginTrustRequired(rctx as any, prompt);
    expect(rctx.events[0]).toMatchObject({ type: "plugin_trust_required", prompt });
  });
  test("emitPluginTrustResolved", () => {
    const rctx = makeRctx();
    emitPluginTrustResolved(rctx as any, "p1");
    expect(rctx.events[0]).toMatchObject({ type: "plugin_trust_resolved", promptId: "p1" });
  });
  test("emitMcpStartupReport", () => {
    const rctx = makeRctx();
    const report = { slow: true, totalDurationMs: 3000 };
    emitMcpStartupReport(rctx as any, report);
    expect(rctx.events[0]).toMatchObject({ type: "mcp_startup_report", report });
    expect(typeof rctx.events[0].ts).toBe("number");
  });
  test("emitTokenUsageUpdated", () => {
    const rctx = makeRctx();
    const tu = { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: 0.01 };
    const pu = { anthropic: { tokens: 150 } };
    emitTokenUsageUpdated(rctx as any, tu, pu);
    expect(rctx.events[0]).toMatchObject({ type: "token_usage_updated", tokenUsage: tu, providerUsage: pu });
  });
  test("emitThinkingLevelChanged", () => {
    const rctx = makeRctx();
    emitThinkingLevelChanged(rctx as any, "high");
    expect(rctx.events[0]).toMatchObject({ type: "thinking_level_changed", level: "high" });
  });
  test("emitAuthSourceChanged", () => {
    const rctx = makeRctx();
    emitAuthSourceChanged(rctx as any, "oauth");
    expect(rctx.events[0]).toMatchObject({ type: "auth_source_changed", source: "oauth" });
  });
  test("emitModelChanged", () => {
    const rctx = makeRctx();
    const model = { provider: "anthropic", id: "claude-3" };
    emitModelChanged(rctx as any, model);
    expect(rctx.events[0]).toMatchObject({ type: "model_changed", model });
  });
});
