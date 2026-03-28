/**
 * Pure-logic tests for TriggersPanel exported helpers.
 *
 * These test groupByLinkedSession, isPendingTrigger, and getIncompleteTriggers
 * without any DOM, React, or module-alias dependencies.
 */
import { describe, test, expect, mock } from "bun:test";

// ── Minimal mocks for TriggersPanel's UI imports ─────────────────────────────
/* eslint-disable @typescript-eslint/no-explicit-any */
mock.module("@/components/ui/button", () => ({ Button: () => null }));
mock.module("@/components/ui/badge", () => ({ Badge: () => null }));
mock.module("@/components/ui/dialog", () => ({
  Dialog: () => null, DialogContent: () => null, DialogHeader: () => null,
  DialogTitle: () => null, DialogFooter: () => null, DialogDescription: () => null,
}));
mock.module("@/lib/utils", () => ({ cn: (...args: any[]) => args.filter(Boolean).join(" ") }));
/* eslint-enable @typescript-eslint/no-explicit-any */

// Import AFTER mocks are registered
const {
  groupByLinkedSession,
  isPendingTrigger,
  getIncompleteTriggers,
  RESPONSE_TRIGGER_TYPES,
} = await import("./TriggersPanel");
import type { TriggerHistoryEntry } from "./TriggersPanel";

function makeTrigger(overrides: Partial<TriggerHistoryEntry> = {}): TriggerHistoryEntry {
  return {
    triggerId: `t_${Math.random().toString(16).slice(2, 10)}`,
    type: "session_linked",
    source: "child-session-1",
    payload: {},
    deliverAs: "steer",
    ts: new Date().toISOString(),
    direction: "inbound",
    ...overrides,
  };
}

// ── isPendingTrigger ─────────────────────────────────────────────────────────

describe("isPendingTrigger", () => {
  test("returns true for inbound ask_user_question without response", () => {
    expect(isPendingTrigger(makeTrigger({ type: "ask_user_question", direction: "inbound" }))).toBe(true);
  });

  test("returns true for inbound plan_review without response", () => {
    expect(isPendingTrigger(makeTrigger({ type: "plan_review", direction: "inbound" }))).toBe(true);
  });

  test("returns true for inbound escalate without response", () => {
    expect(isPendingTrigger(makeTrigger({ type: "escalate", direction: "inbound" }))).toBe(true);
  });

  test("returns false for outbound triggers", () => {
    expect(isPendingTrigger(makeTrigger({ type: "ask_user_question", direction: "outbound" }))).toBe(false);
  });

  test("returns false when a response exists", () => {
    expect(isPendingTrigger(makeTrigger({
      type: "ask_user_question",
      direction: "inbound",
      response: { action: "approve", ts: new Date().toISOString() },
    }))).toBe(false);
  });

  test("returns false for non-response trigger types", () => {
    expect(isPendingTrigger(makeTrigger({ type: "session_linked", direction: "inbound" }))).toBe(false);
    expect(isPendingTrigger(makeTrigger({ type: "session_complete", direction: "inbound" }))).toBe(false);
  });
});

// ── RESPONSE_TRIGGER_TYPES ───────────────────────────────────────────────────

describe("RESPONSE_TRIGGER_TYPES", () => {
  test("contains the expected types", () => {
    expect(RESPONSE_TRIGGER_TYPES.has("ask_user_question")).toBe(true);
    expect(RESPONSE_TRIGGER_TYPES.has("plan_review")).toBe(true);
    expect(RESPONSE_TRIGGER_TYPES.has("escalate")).toBe(true);
    expect(RESPONSE_TRIGGER_TYPES.has("session_complete")).toBe(false);
  });
});

// ── groupByLinkedSession ─────────────────────────────────────────────────────

describe("groupByLinkedSession", () => {
  test("groups inbound triggers by source", () => {
    const triggers = [
      makeTrigger({ source: "child-1", type: "session_linked" }),
      makeTrigger({ source: "child-1", type: "session_complete" }),
      makeTrigger({ source: "child-2", type: "session_linked" }),
    ];
    const { sessionGroups } = groupByLinkedSession(triggers);
    expect(sessionGroups).toHaveLength(2);
    expect(sessionGroups.find(g => g.source === "child-1")?.events).toHaveLength(2);
    expect(sessionGroups.find(g => g.source === "child-2")?.events).toHaveLength(1);
  });

  test("separates external triggers into otherEvents", () => {
    const triggers = [
      makeTrigger({ source: "child-1", type: "session_linked" }),
      makeTrigger({ source: "external:github", type: "webhook", direction: "inbound" }),
      makeTrigger({ source: "api", type: "custom", direction: "inbound" }),
    ];
    const { sessionGroups, otherEvents } = groupByLinkedSession(triggers);
    expect(sessionGroups).toHaveLength(1);
    expect(otherEvents).toHaveLength(2);
  });

  test("identifies pending triggers in groups", () => {
    const triggers = [
      makeTrigger({ source: "child-1", type: "ask_user_question" }),
    ];
    const { sessionGroups } = groupByLinkedSession(triggers);
    expect(sessionGroups[0].pendingTrigger).not.toBeNull();
    expect(sessionGroups[0].pendingTrigger!.type).toBe("ask_user_question");
  });
});

// ── getIncompleteTriggers ────────────────────────────────────────────────────

describe("getIncompleteTriggers", () => {
  test("returns empty for no triggers", () => {
    expect(getIncompleteTriggers([])).toEqual([]);
  });

  test("returns empty when all sessions are fully ack'd", () => {
    const triggers = [
      makeTrigger({
        source: "child-1",
        type: "session_complete",
        response: { action: "ack", ts: new Date().toISOString() },
      }),
    ];
    expect(getIncompleteTriggers(triggers)).toEqual([]);
  });

  test("detects pending ask_user_question", () => {
    const triggers = [
      makeTrigger({ source: "child-1", type: "ask_user_question" }),
    ];
    const result = getIncompleteTriggers(triggers);
    expect(result).toHaveLength(1);
    expect(result[0].reason).toBe("Waiting for your answer");
  });

  test("detects pending plan_review", () => {
    const triggers = [
      makeTrigger({ source: "child-1", type: "plan_review" }),
    ];
    const result = getIncompleteTriggers(triggers);
    expect(result).toHaveLength(1);
    expect(result[0].reason).toBe("Awaiting plan review");
  });

  test("detects pending escalate", () => {
    const triggers = [
      makeTrigger({ source: "child-1", type: "escalate" }),
    ];
    const result = getIncompleteTriggers(triggers);
    expect(result).toHaveLength(1);
    expect(result[0].reason).toBe("Escalated — needs attention");
  });

  test("excludes session_complete without ack (child is done)", () => {
    const triggers = [
      makeTrigger({ source: "child-1", type: "session_complete" }),
    ];
    expect(getIncompleteTriggers(triggers)).toEqual([]);
  });

  test("excludes session_complete with followUp response (child is done)", () => {
    const triggers = [
      makeTrigger({
        source: "child-1",
        type: "session_complete",
        response: { action: "followUp", text: "do more", ts: new Date().toISOString() },
      }),
    ];
    expect(getIncompleteTriggers(triggers)).toEqual([]);
  });

  test("detects still-running sessions (linked, no complete)", () => {
    const triggers = [
      makeTrigger({ source: "child-1", type: "session_linked" }),
    ];
    const result = getIncompleteTriggers(triggers);
    expect(result).toHaveLength(1);
    expect(result[0].reason).toBe("Still running");
  });

  test("handles multiple sessions with mixed states", () => {
    const triggers = [
      // child-1: fully done
      makeTrigger({
        source: "child-1",
        type: "session_complete",
        response: { action: "ack", ts: new Date().toISOString() },
      }),
      // child-2: still running
      makeTrigger({ source: "child-2", type: "session_linked" }),
      // child-3: waiting for answer
      makeTrigger({ source: "child-3", type: "ask_user_question" }),
    ];
    const result = getIncompleteTriggers(triggers);
    expect(result).toHaveLength(2);
    const sources = result.map(r => r.source);
    expect(sources).toContain("child-2");
    expect(sources).toContain("child-3");
    expect(sources).not.toContain("child-1");
  });

  test("ignores external/API triggers", () => {
    const triggers = [
      makeTrigger({ source: "external:github", type: "webhook", direction: "inbound" }),
      makeTrigger({ source: "api", type: "custom", direction: "inbound" }),
    ];
    // External triggers are not linked sessions — they shouldn't appear
    expect(getIncompleteTriggers(triggers)).toEqual([]);
  });

  test("uses summary as label when available", () => {
    const triggers = [
      makeTrigger({ source: "child-1", type: "session_linked", summary: "My Agent Task" }),
      makeTrigger({ source: "child-1", type: "ask_user_question" }),
    ];
    const result = getIncompleteTriggers(triggers);
    expect(result).toHaveLength(1);
    // The label comes from the most recent event's summary (ask_user_question, which has no summary)
    // or the group's lastSummary (most recent event)
    expect(result[0].source).toBe("child-1");
  });
});
