import { describe, test, expect } from "bun:test";
import { metaEventToStatePatch } from "./meta-state-apply.js";

describe("metaEventToStatePatch", () => {
  test("todo_updated returns todoList patch", () => {
    const todos = [{ id: 1, text: "task", status: "pending" as const }];
    expect(metaEventToStatePatch({ type: "todo_updated", todoList: todos }).todoList).toEqual(todos);
  });
  test("compact_started sets isCompacting + viewerStatus", () => {
    const patch = metaEventToStatePatch({ type: "compact_started" });
    expect(patch.isCompacting).toBe(true);
    expect(patch.viewerStatusOverride).toBe("Compacting…");
  });
  test("compact_ended clears isCompacting", () => {
    expect(metaEventToStatePatch({ type: "compact_ended" }).isCompacting).toBe(false);
  });
  test("plan_mode_toggled sets planModeEnabled", () => {
    expect(metaEventToStatePatch({ type: "plan_mode_toggled", enabled: true }).planModeEnabled).toBe(true);
    expect(metaEventToStatePatch({ type: "plan_mode_toggled", enabled: false }).planModeEnabled).toBe(false);
  });
  test("question_cleared clears pendingQuestion", () => {
    const patch = metaEventToStatePatch({ type: "question_cleared", toolCallId: "tc1" });
    expect(patch.setPendingQuestion).toBe(true);
    expect(patch.pendingQuestion).toBeNull();
  });
  test("retry_state_changed null clears state", () => {
    expect(metaEventToStatePatch({ type: "retry_state_changed", state: null }).retryState).toBeNull();
  });
  test("plugin_trust_resolved clears trust prompt", () => {
    expect(metaEventToStatePatch({ type: "plugin_trust_resolved", promptId: "p1" }).pluginTrustPrompt).toBeNull();
  });
  test("thinking_level_changed sets level", () => {
    expect(metaEventToStatePatch({ type: "thinking_level_changed", level: "high" }).thinkingLevel).toBe("high");
    expect(metaEventToStatePatch({ type: "thinking_level_changed", level: null }).thinkingLevel).toBeNull();
  });
  test("auth_source_changed sets authSource", () => {
    expect(metaEventToStatePatch({ type: "auth_source_changed", source: "oauth" }).authSource).toBe("oauth");
  });
  test("model_changed sets model", () => {
    const model = { provider: "anthropic", id: "claude-3" };
    expect(metaEventToStatePatch({ type: "model_changed", model }).model).toEqual(model);
  });
  test("model_changed null clears model", () => {
    expect(metaEventToStatePatch({ type: "model_changed", model: null }).model).toBeNull();
  });
});
