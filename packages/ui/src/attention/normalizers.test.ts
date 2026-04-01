import { describe, expect, test } from "bun:test";
import { normalizeBackgroundSessionMeta, normalizeSessionMeta, normalizeTriggerHistory } from "./normalizers";
import type { TriggerHistoryEntry } from "./trigger-utils";

// ── normalizeSessionMeta ─────────────────────────────────────────────────────

describe("normalizeSessionMeta", () => {
  const SESSION_ID = "session-abc";

  test("returns empty array when no flags are set", () => {
    const items = normalizeSessionMeta(SESSION_ID, {});
    expect(items).toEqual([]);
  });

  test("produces question item for pendingQuestion", () => {
    const items = normalizeSessionMeta(SESSION_ID, {
      pendingQuestion: { toolCallId: "tc-1" },
    });
    expect(items).toHaveLength(1);
    const [item] = items;
    expect(item.id).toBe(`meta:${SESSION_ID}:question:tc-1`);
    expect(item.category).toBe("needs_response");
    expect(item.kind).toBe("question");
    expect(item.sessionId).toBe(SESSION_ID);
    expect(item.priority).toBe(10);
    expect(item.source).toBe("meta");
    expect(item.payload).toEqual({ toolCallId: "tc-1" });
  });

  test("produces plan_review item for pendingPlan", () => {
    const items = normalizeSessionMeta(SESSION_ID, {
      pendingPlan: { toolCallId: "tc-2", title: "My Plan" },
    });
    expect(items).toHaveLength(1);
    const [item] = items;
    expect(item.id).toBe(`meta:${SESSION_ID}:plan:tc-2`);
    expect(item.kind).toBe("plan_review");
    expect(item.category).toBe("needs_response");
    expect(item.priority).toBe(10);
    expect((item.payload as Record<string, unknown>)?.title).toBe("My Plan");
  });

  test("produces plugin_trust item for pluginTrustPrompt", () => {
    const items = normalizeSessionMeta(SESSION_ID, {
      pluginTrustPrompt: { promptId: "prompt-1" },
    });
    expect(items).toHaveLength(1);
    const [item] = items;
    expect(item.kind).toBe("plugin_trust");
    expect(item.priority).toBe(15);
    expect(item.id).toBe(`meta:${SESSION_ID}:plugin_trust:prompt-1`);
  });

  test("produces compacting item when isCompacting is true", () => {
    const items = normalizeSessionMeta(SESSION_ID, { isCompacting: true });
    expect(items).toHaveLength(1);
    const [item] = items;
    expect(item.kind).toBe("compacting");
    expect(item.category).toBe("running");
    expect(item.id).toBe(`meta:${SESSION_ID}:compacting`);
  });

  test("produces agent_active item when agentActive is true", () => {
    const items = normalizeSessionMeta(SESSION_ID, { agentActive: true });
    expect(items).toHaveLength(1);
    const [item] = items;
    expect(item.kind).toBe("agent_active");
    expect(item.category).toBe("running");
    expect(item.id).toBe(`meta:${SESSION_ID}:active`);
  });

  test("can produce multiple items from combined meta state", () => {
    const items = normalizeSessionMeta(SESSION_ID, {
      pendingQuestion: { toolCallId: "tc-1" },
      isCompacting: true,
      agentActive: true,
    });
    expect(items).toHaveLength(3);
    const kinds = items.map((i) => i.kind);
    expect(kinds).toContain("question");
    expect(kinds).toContain("compacting");
    expect(kinds).toContain("agent_active");
  });

  test("uses sessionName from meta when provided", () => {
    const items = normalizeSessionMeta(SESSION_ID, {
      pendingQuestion: { toolCallId: "tc-1" },
      sessionName: "My Session",
    });
    expect(items[0].sessionName).toBe("My Session");
  });

  test("sessionName is undefined when not provided", () => {
    const items = normalizeSessionMeta(SESSION_ID, {
      agentActive: true,
    });
    expect(items[0].sessionName).toBeUndefined();
  });

  test("all items have valid ISO createdAt timestamps", () => {
    const items = normalizeSessionMeta(SESSION_ID, {
      agentActive: true,
      isCompacting: true,
    });
    for (const item of items) {
      expect(new Date(item.createdAt).getTime()).not.toBeNaN();
    }
  });
});

// ── normalizeTriggerHistory ──────────────────────────────────────────────────

function makeTrigger(overrides: Partial<TriggerHistoryEntry> = {}): TriggerHistoryEntry {
  return {
    triggerId: `trig-${Math.random().toString(36).slice(2)}`,
    type: "session_connect",
    source: "child-session-xyz",
    payload: {},
    deliverAs: "steer",
    ts: new Date().toISOString(),
    direction: "inbound",
    ...overrides,
  };
}

describe("normalizeBackgroundSessionMeta", () => {
  const SESSION_ID = "background-session";

  test("creates synthesized background needs-response items", () => {
    const items = normalizeBackgroundSessionMeta(SESSION_ID, {
      awaitingInputKind: "question",
      isCompacting: true,
      sessionName: "Background task",
    });

    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      id: `meta:${SESSION_ID}:background:question`,
      category: "needs_response",
      kind: "question",
      sessionId: SESSION_ID,
      sessionName: "Background task",
      source: "meta",
    });
    expect(items[1]).toMatchObject({
      id: `meta:${SESSION_ID}:compacting`,
      category: "running",
      kind: "compacting",
      sessionId: SESSION_ID,
      sessionName: "Background task",
      source: "meta",
    });
  });

  test("returns empty when background session has no attention flags", () => {
    expect(normalizeBackgroundSessionMeta(SESSION_ID, {})).toEqual([]);
  });
});

describe("normalizeTriggerHistory", () => {
  const SESSION_ID = "parent-session";

  test("returns empty array for empty trigger list", () => {
    expect(normalizeTriggerHistory(SESSION_ID, [])).toEqual([]);
  });

  test("skips outbound triggers", () => {
    const items = normalizeTriggerHistory(SESSION_ID, [
      makeTrigger({ direction: "outbound", type: "steer" }),
    ]);
    expect(items).toEqual([]);
  });

  test("skips 'api' source triggers", () => {
    const items = normalizeTriggerHistory(SESSION_ID, [
      makeTrigger({ source: "api", direction: "inbound" }),
    ]);
    expect(items).toEqual([]);
  });

  test("skips 'external:*' source triggers", () => {
    const items = normalizeTriggerHistory(SESSION_ID, [
      makeTrigger({ source: "external:github", direction: "inbound" }),
    ]);
    expect(items).toEqual([]);
  });

  test("produces child_running item for connected session with no pending or complete", () => {
    const items = normalizeTriggerHistory(SESSION_ID, [
      makeTrigger({ source: "child-s1", type: "session_connect", direction: "inbound" }),
    ]);
    expect(items).toHaveLength(1);
    const [item] = items;
    expect(item.kind).toBe("child_running");
    expect(item.category).toBe("running");
    expect(item.sessionId).toBe(SESSION_ID);
    expect(item.source).toBe("trigger");
  });

  test("produces trigger_response item for pending ask_user_question", () => {
    const triggerId = "trig-123";
    const items = normalizeTriggerHistory(SESSION_ID, [
      makeTrigger({
        triggerId,
        source: "child-s1",
        type: "ask_user_question",
        direction: "inbound",
        response: undefined, // no response = pending
      }),
    ]);
    expect(items).toHaveLength(1);
    const [item] = items;
    expect(item.kind).toBe("trigger_response");
    expect(item.category).toBe("needs_response");
    expect(item.priority).toBe(10);
    expect((item.payload as Record<string, unknown>)?.triggerId).toBe(triggerId);
  });

  test("pending plan_review has priority 10", () => {
    const items = normalizeTriggerHistory(SESSION_ID, [
      makeTrigger({
        source: "child-s1",
        type: "plan_review",
        direction: "inbound",
        response: undefined,
      }),
    ]);
    expect(items[0].priority).toBe(10);
  });

  test("pending escalate trigger has priority 5", () => {
    const items = normalizeTriggerHistory(SESSION_ID, [
      makeTrigger({
        source: "child-s1",
        type: "escalate",
        direction: "inbound",
        response: undefined,
      }),
    ]);
    expect(items[0].priority).toBe(5);
  });

  test("produces session_complete item for completed (un-acked) session", () => {
    const triggerId = "trig-complete";
    const items = normalizeTriggerHistory(SESSION_ID, [
      makeTrigger({ source: "child-s1", type: "session_connect", direction: "inbound" }),
      makeTrigger({
        triggerId,
        source: "child-s1",
        type: "session_complete",
        direction: "inbound",
        response: undefined, // not acked
      }),
    ]);
    expect(items).toHaveLength(1);
    const [item] = items;
    expect(item.kind).toBe("session_complete");
    expect(item.category).toBe("completed");
    expect(item.id).toBe(`trigger:${SESSION_ID}:complete:child-s1`);
  });

  test("produces session_complete item when it was acked", () => {
    const items = normalizeTriggerHistory(SESSION_ID, [
      makeTrigger({ source: "child-s1", type: "session_connect", direction: "inbound" }),
      makeTrigger({
        source: "child-s1",
        type: "session_complete",
        direction: "inbound",
        response: { action: "ack", ts: new Date().toISOString() },
      }),
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: "session_complete",
      category: "completed",
    });
  });

  test("treats followUp after session_complete as still running", () => {
    const responseTs = new Date().toISOString();
    const items = normalizeTriggerHistory(SESSION_ID, [
      makeTrigger({ source: "child-s1", type: "session_connect", direction: "inbound" }),
      makeTrigger({
        triggerId: "trig-follow-up",
        source: "child-s1",
        type: "session_complete",
        direction: "inbound",
        response: { action: "followUp", text: "keep going", ts: responseTs },
      }),
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: `trigger:${SESSION_ID}:running:child-s1`,
      kind: "child_running",
      category: "running",
      createdAt: responseTs,
    });
  });

  test("followUp→ack lifecycle: session clears after ack (not stuck as running)", () => {
    // API returns triggers newest-first: ack (most recent) before followUp, connect last
    const items = normalizeTriggerHistory(SESSION_ID, [
      makeTrigger({
        source: "child-s1",
        type: "session_complete",
        direction: "inbound",
        response: { action: "ack", ts: new Date().toISOString() },
      }),
      makeTrigger({
        source: "child-s1",
        type: "session_complete",
        direction: "inbound",
        response: { action: "followUp", ts: new Date().toISOString() },
      }),
      makeTrigger({ source: "child-s1", type: "session_connect", direction: "inbound" }),
    ]);
    // find() on newest-first data returns the ack (first match), not the older followUp
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: "session_complete",
      category: "completed",
    });
  });

  test("pending trigger takes precedence over completed", () => {
    // If a source has both a pending trigger AND a complete, the pending wins
    const items = normalizeTriggerHistory(SESSION_ID, [
      makeTrigger({ source: "child-s1", type: "session_connect", direction: "inbound" }),
      makeTrigger({
        source: "child-s1",
        type: "session_complete",
        direction: "inbound",
        response: undefined,
      }),
      makeTrigger({
        source: "child-s1",
        type: "ask_user_question",
        direction: "inbound",
        response: undefined,
      }),
    ]);
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe("trigger_response");
  });

  test("handles multiple independent child sessions", () => {
    const items = normalizeTriggerHistory(SESSION_ID, [
      makeTrigger({ source: "child-a", type: "session_connect", direction: "inbound" }),
      makeTrigger({ source: "child-b", type: "session_connect", direction: "inbound" }),
    ]);
    expect(items).toHaveLength(2);
    const sources = items.map((i) => (i.payload as Record<string, unknown>)?.source);
    expect(sources).toContain("child-a");
    expect(sources).toContain("child-b");
  });

  test("all produced items have the parent sessionId", () => {
    const items = normalizeTriggerHistory(SESSION_ID, [
      makeTrigger({ source: "child-s1", direction: "inbound" }),
    ]);
    for (const item of items) {
      expect(item.sessionId).toBe(SESSION_ID);
    }
  });
});
