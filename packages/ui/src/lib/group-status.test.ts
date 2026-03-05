import { describe, expect, test } from "bun:test";
import {
  resolveChildStatus,
  computeGroupCounts,
  resolveChildSessions,
  formatDuration,
  type GroupSession,
} from "./group-status";

// ── helpers ─────────────────────────────────────────────────────────────────

function session(
  overrides: Partial<GroupSession> & { sessionId: string },
): GroupSession {
  return {
    isActive: false,
    lastHeartbeatAt: null,
    childSessionIds: [],
    parentSessionId: null,
    sessionName: null,
    model: null,
    ...overrides,
  };
}

function toMap(sessions: GroupSession[]): Map<string, GroupSession> {
  const m = new Map<string, GroupSession>();
  for (const s of sessions) m.set(s.sessionId, s);
  return m;
}

// ── resolveChildStatus ──────────────────────────────────────────────────────

describe("resolveChildStatus", () => {
  test("returns 'active' when session isActive", () => {
    const s = session({ sessionId: "a", isActive: true });
    expect(resolveChildStatus(s)).toBe("active");
  });

  test("returns 'idle' when heartbeat is fresh (<60s)", () => {
    const recent = new Date(Date.now() - 10_000).toISOString();
    const s = session({ sessionId: "a", lastHeartbeatAt: recent });
    expect(resolveChildStatus(s)).toBe("idle");
  });

  test("returns 'completed' when heartbeat is stale (60-120s)", () => {
    const stale = new Date(Date.now() - 90_000).toISOString();
    const s = session({ sessionId: "a", lastHeartbeatAt: stale });
    expect(resolveChildStatus(s)).toBe("completed");
  });

  test("returns 'error' when heartbeat is very stale (>120s)", () => {
    const veryStale = new Date(Date.now() - 150_000).toISOString();
    const s = session({ sessionId: "a", lastHeartbeatAt: veryStale });
    expect(resolveChildStatus(s)).toBe("error");
  });

  test("returns 'unknown' when no heartbeat and not active", () => {
    const s = session({ sessionId: "a" });
    expect(resolveChildStatus(s)).toBe("unknown");
  });

  test("active overrides stale heartbeat", () => {
    const stale = new Date(Date.now() - 200_000).toISOString();
    const s = session({ sessionId: "a", isActive: true, lastHeartbeatAt: stale });
    expect(resolveChildStatus(s)).toBe("active");
  });
});

// ── computeGroupCounts ──────────────────────────────────────────────────────

describe("computeGroupCounts", () => {
  test("returns zero counts for empty child list", () => {
    const result = computeGroupCounts([], new Map());
    expect(result).toEqual({ completed: 0, active: 0, error: 0, total: 0 });
  });

  test("counts completed children correctly", () => {
    const stale = new Date(Date.now() - 90_000).toISOString();
    const sessions = [
      session({ sessionId: "c1", lastHeartbeatAt: stale }),
      session({ sessionId: "c2", lastHeartbeatAt: stale }),
      session({ sessionId: "c3", isActive: true }),
    ];
    const result = computeGroupCounts(["c1", "c2", "c3"], toMap(sessions));
    expect(result.completed).toBe(2);
    expect(result.active).toBe(1);
    expect(result.total).toBe(3);
  });

  test("treats missing sessions as completed", () => {
    const result = computeGroupCounts(["missing1", "missing2"], new Map());
    expect(result.completed).toBe(2);
    expect(result.total).toBe(2);
  });

  test("counts errors", () => {
    const veryStale = new Date(Date.now() - 150_000).toISOString();
    const sessions = [
      session({ sessionId: "c1", lastHeartbeatAt: veryStale }),
    ];
    const result = computeGroupCounts(["c1"], toMap(sessions));
    expect(result.error).toBe(1);
    expect(result.total).toBe(1);
  });

  test("handles mix of states", () => {
    const fresh = new Date(Date.now() - 5_000).toISOString();
    const stale = new Date(Date.now() - 90_000).toISOString();
    const veryStale = new Date(Date.now() - 200_000).toISOString();
    const sessions = [
      session({ sessionId: "active", isActive: true }),
      session({ sessionId: "idle", lastHeartbeatAt: fresh }),
      session({ sessionId: "done", lastHeartbeatAt: stale }),
      session({ sessionId: "error", lastHeartbeatAt: veryStale }),
    ];
    const result = computeGroupCounts(
      ["active", "idle", "done", "error", "missing"],
      toMap(sessions),
    );
    expect(result.active).toBe(1);
    expect(result.completed).toBe(2); // done + missing
    expect(result.error).toBe(1);
    expect(result.total).toBe(5);
  });
});

// ── resolveChildSessions ────────────────────────────────────────────────────

describe("resolveChildSessions", () => {
  test("returns empty array for empty child list", () => {
    expect(resolveChildSessions([], new Map())).toEqual([]);
  });

  test("resolves child sessions with correct display names", () => {
    const sessions = [
      session({ sessionId: "c1", sessionName: "My Task" }),
      session({ sessionId: "c2", sessionName: null }),
    ];
    const result = resolveChildSessions(["c1", "c2"], toMap(sessions));
    expect(result).toHaveLength(2);
    expect(result[0].displayName).toBe("My Task");
    expect(result[1].displayName).toBe("Session c2…");
  });

  test("handles missing sessions gracefully", () => {
    const result = resolveChildSessions(["missing"], new Map());
    expect(result).toHaveLength(1);
    expect(result[0].status).toBe("completed");
    expect(result[0].displayName).toBe("Session missing…");
    expect(result[0].model).toBeNull();
    expect(result[0].durationMs).toBeNull();
  });

  test("includes model info", () => {
    const sessions = [
      session({
        sessionId: "c1",
        model: { provider: "anthropic", id: "claude-sonnet-4-20250514" },
      }),
    ];
    const result = resolveChildSessions(["c1"], toMap(sessions));
    expect(result[0].model).toEqual({
      provider: "anthropic",
      id: "claude-sonnet-4-20250514",
    });
  });

  test("computes duration from startedAt", () => {
    const tenMinutesAgo = new Date(Date.now() - 600_000).toISOString();
    const sessions = [
      session({ sessionId: "c1", startedAt: tenMinutesAgo }),
    ];
    const result = resolveChildSessions(["c1"], toMap(sessions));
    // Duration should be approximately 600_000ms (10 minutes)
    expect(result[0].durationMs).toBeGreaterThan(590_000);
    expect(result[0].durationMs).toBeLessThan(610_000);
  });

  test("trims whitespace from session names", () => {
    const sessions = [
      session({ sessionId: "c1", sessionName: "  Spaced Name  " }),
    ];
    const result = resolveChildSessions(["c1"], toMap(sessions));
    expect(result[0].displayName).toBe("Spaced Name");
  });
});

// ── formatDuration ──────────────────────────────────────────────────────────

describe("formatDuration", () => {
  test("formats seconds", () => {
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(5_000)).toBe("5s");
    expect(formatDuration(59_000)).toBe("59s");
  });

  test("formats minutes and seconds", () => {
    expect(formatDuration(60_000)).toBe("1m");
    expect(formatDuration(61_000)).toBe("1m 1s");
    expect(formatDuration(125_000)).toBe("2m 5s");
    expect(formatDuration(3_599_000)).toBe("59m 59s");
  });

  test("formats hours and minutes", () => {
    expect(formatDuration(3_600_000)).toBe("1h");
    expect(formatDuration(3_660_000)).toBe("1h 1m");
    expect(formatDuration(7_200_000)).toBe("2h");
    expect(formatDuration(7_380_000)).toBe("2h 3m");
  });

  test("handles negative values", () => {
    expect(formatDuration(-1000)).toBe("0s");
  });
});
