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
  test("plugin_trust_resolved clears trust prompt", () => {
    expect(metaEventToPatch({ type: "plugin_trust_resolved", promptId: "p1" })).toEqual({ pendingPluginTrust: null });
  });
});
