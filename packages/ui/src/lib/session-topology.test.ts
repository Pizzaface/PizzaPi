import { describe, expect, test } from "bun:test";
import { buildSessionTree, type TopologySession } from "./session-topology";

// ── helpers ─────────────────────────────────────────────────────────────────

function session(overrides: Partial<TopologySession> & { sessionId: string }): TopologySession {
  return {
    parentSessionId: null,
    childSessionIds: [],
    ...overrides,
  };
}

// ── buildSessionTree ────────────────────────────────────────────────────────

describe("buildSessionTree", () => {
  test("returns empty array when session has no parent or children", () => {
    const sessions = [session({ sessionId: "a" })];
    const result = buildSessionTree("a", sessions);
    expect(result).toEqual([]);
  });

  test("returns empty array when currentSessionId is not in sessions", () => {
    const sessions = [session({ sessionId: "a" })];
    const result = buildSessionTree("nonexistent", sessions);
    expect(result).toEqual([]);
  });

  test("builds tree with parent and child", () => {
    const sessions = [
      session({
        sessionId: "parent",
        childSessionIds: ["child"],
      }),
      session({
        sessionId: "child",
        parentSessionId: "parent",
      }),
    ];

    const result = buildSessionTree("child", sessions);
    expect(result).toHaveLength(1);
    expect(result[0].session.sessionId).toBe("parent");
    expect(result[0].children).toHaveLength(1);
    expect(result[0].children[0].session.sessionId).toBe("child");
  });

  test("root is found by walking up parentSessionId chain", () => {
    const sessions = [
      session({
        sessionId: "root",
        childSessionIds: ["mid"],
      }),
      session({
        sessionId: "mid",
        parentSessionId: "root",
        childSessionIds: ["leaf"],
      }),
      session({
        sessionId: "leaf",
        parentSessionId: "mid",
      }),
    ];

    const result = buildSessionTree("leaf", sessions);
    expect(result).toHaveLength(1);
    expect(result[0].session.sessionId).toBe("root");
    expect(result[0].children).toHaveLength(1);
    expect(result[0].children[0].session.sessionId).toBe("mid");
    expect(result[0].children[0].children).toHaveLength(1);
    expect(result[0].children[0].children[0].session.sessionId).toBe("leaf");
  });

  test("handles multiple children", () => {
    const sessions = [
      session({
        sessionId: "parent",
        childSessionIds: ["child1", "child2", "child3"],
      }),
      session({ sessionId: "child1", parentSessionId: "parent" }),
      session({ sessionId: "child2", parentSessionId: "parent" }),
      session({ sessionId: "child3", parentSessionId: "parent" }),
    ];

    const result = buildSessionTree("child1", sessions);
    expect(result).toHaveLength(1);
    expect(result[0].children).toHaveLength(3);
  });

  test("returns tree when viewing parent session directly", () => {
    const sessions = [
      session({
        sessionId: "parent",
        childSessionIds: ["child"],
      }),
      session({
        sessionId: "child",
        parentSessionId: "parent",
      }),
    ];

    const result = buildSessionTree("parent", sessions);
    expect(result).toHaveLength(1);
    expect(result[0].session.sessionId).toBe("parent");
    expect(result[0].children).toHaveLength(1);
  });

  test("handles missing child gracefully (child not in sessions list)", () => {
    const sessions = [
      session({
        sessionId: "parent",
        childSessionIds: ["child", "missing-child"],
      }),
      session({
        sessionId: "child",
        parentSessionId: "parent",
      }),
    ];

    const result = buildSessionTree("child", sessions);
    expect(result).toHaveLength(1);
    // Only 1 child rendered (the one in sessions), missing-child is skipped
    expect(result[0].children).toHaveLength(1);
    expect(result[0].children[0].session.sessionId).toBe("child");
  });

  test("handles circular parent references without infinite loop", () => {
    const sessions = [
      session({
        sessionId: "a",
        parentSessionId: "b",
        childSessionIds: ["b"],
      }),
      session({
        sessionId: "b",
        parentSessionId: "a",
        childSessionIds: ["a"],
      }),
    ];

    // Should not hang; returns some result
    const result = buildSessionTree("a", sessions);
    expect(result.length).toBeGreaterThanOrEqual(0);
  });

  test("returns empty for session with undefined parentSessionId and empty childSessionIds", () => {
    const sessions = [
      session({
        sessionId: "solo",
        parentSessionId: undefined as unknown as string | null,
        childSessionIds: undefined as unknown as string[],
      }),
    ];
    const result = buildSessionTree("solo", sessions);
    expect(result).toEqual([]);
  });

  test("handles deep hierarchy (10 levels)", () => {
    const sessions: TopologySession[] = [];
    for (let i = 0; i < 10; i++) {
      sessions.push(
        session({
          sessionId: `s${i}`,
          parentSessionId: i > 0 ? `s${i - 1}` : null,
          childSessionIds: i < 9 ? [`s${i + 1}`] : [],
        }),
      );
    }

    const result = buildSessionTree("s9", sessions);
    expect(result).toHaveLength(1);
    expect(result[0].session.sessionId).toBe("s0");

    // Walk down to verify depth
    let node = result[0];
    for (let i = 1; i <= 9; i++) {
      expect(node.children).toHaveLength(1);
      node = node.children[0];
      expect(node.session.sessionId).toBe(`s${i}`);
    }
    expect(node.children).toHaveLength(0);
  });
});
