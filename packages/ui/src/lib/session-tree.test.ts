import { describe, test, expect } from "bun:test";
import {
  buildSessionTree,
  flattenSessionTree,
  getSessionIndent,
  getDescendantSessionIds,
  getGroupCwd,
  type HubSession,
} from "./session-tree";

describe("session-tree", () => {
  const createSession = (id: string, parentId?: string): HubSession => ({
    sessionId: id,
    shareUrl: `http://localhost/session/${id}`,
    cwd: "/tmp",
    startedAt: new Date().toISOString(),
    parentSessionId: parentId || null,
  });

  describe("buildSessionTree", () => {
    test("builds tree from flat session list with parent-child relationships", () => {
      const now = Date.now();
      const sessions = [
        { ...createSession("parent-1"), startedAt: new Date(now - 2000).toISOString() },
        { ...createSession("child-1a", "parent-1"), startedAt: new Date(now - 1500).toISOString() },
        { ...createSession("child-1b", "parent-1"), startedAt: new Date(now - 1000).toISOString() },
        { ...createSession("parent-2"), startedAt: new Date(now).toISOString() },
      ];

      const tree = buildSessionTree(sessions);

      expect(tree).toHaveLength(2);
      expect(tree[0].session.sessionId).toBe("parent-2"); // Newest first
      expect(tree[1].session.sessionId).toBe("parent-1");
      expect(tree[1].children).toHaveLength(2);
      expect(tree[1].children[0].session.sessionId).toBe("child-1a");
      expect(tree[1].children[1].session.sessionId).toBe("child-1b");
    });

    test("returns empty array for empty session list", () => {
      const tree = buildSessionTree([]);
      expect(tree).toHaveLength(0);
    });

    test("handles sessions with missing parent references gracefully", () => {
      const now = Date.now();
      const sessions = [
        { ...createSession("parent-1"), startedAt: new Date(now).toISOString() },
        { ...createSession("orphan", "non-existent-parent"), startedAt: new Date(now - 1000).toISOString() },
      ];

      const tree = buildSessionTree(sessions);
      // Orphan with missing parent should be treated as a root (not hidden)
      expect(tree).toHaveLength(2);
      expect(tree.map(n => n.session.sessionId)).toContain("parent-1");
      expect(tree.map(n => n.session.sessionId)).toContain("orphan");
    });

    test("sorts roots by creation time (newest first)", () => {
      const now = Date.now();
      const sessions = [
        { ...createSession("old"), startedAt: new Date(now - 10000).toISOString() },
        { ...createSession("new"), startedAt: new Date(now).toISOString() },
        { ...createSession("mid"), startedAt: new Date(now - 5000).toISOString() },
      ];

      const tree = buildSessionTree(sessions);
      expect(tree[0].session.sessionId).toBe("new");
      expect(tree[1].session.sessionId).toBe("mid");
      expect(tree[2].session.sessionId).toBe("old");
    });

    test("sorts children by creation time (oldest first)", () => {
      const now = Date.now();
      const sessions = [
        { ...createSession("parent"), startedAt: new Date(now - 10000).toISOString() },
        { ...createSession("child-new", "parent"), startedAt: new Date(now).toISOString() },
        { ...createSession("child-old", "parent"), startedAt: new Date(now - 5000).toISOString() },
      ];

      const tree = buildSessionTree(sessions);
      expect(tree[0].children[0].session.sessionId).toBe("child-old");
      expect(tree[0].children[1].session.sessionId).toBe("child-new");
    });

    test("handles cyclic parent chains by treating cycle members as roots", () => {
      const now = Date.now();
      // A→B and B→A creates a cycle; both should appear as roots
      const sessions = [
        { ...createSession("a", "b"), startedAt: new Date(now - 2000).toISOString() },
        { ...createSession("b", "a"), startedAt: new Date(now - 1000).toISOString() },
        { ...createSession("c"), startedAt: new Date(now).toISOString() },
      ];

      const tree = buildSessionTree(sessions);
      // All 3 should be roots — a and b because of cycle, c because no parent
      const rootIds = tree.map(n => n.session.sessionId).sort();
      expect(rootIds).toEqual(["a", "b", "c"]);
      // Cycle members should have no children (edges broken)
      const aNode = tree.find(n => n.session.sessionId === "a")!;
      const bNode = tree.find(n => n.session.sessionId === "b")!;
      expect(aNode.children).toHaveLength(0);
      expect(bNode.children).toHaveLength(0);
    });

    test("handles self-referencing parentSessionId in tree building", () => {
      const sessions = [
        { ...createSession("self-ref", "self-ref"), startedAt: new Date().toISOString() },
      ];

      const tree = buildSessionTree(sessions);
      expect(tree).toHaveLength(1);
      expect(tree[0].session.sessionId).toBe("self-ref");
      expect(tree[0].children).toHaveLength(0);
    });
  });

  describe("flattenSessionTree", () => {
    test("flattens tree to list with depth information", () => {
      const tree = [
        {
          session: createSession("parent"),
          children: [
            {
              session: createSession("child", "parent"),
              children: [],
            },
          ],
        },
      ];

      const expanded = new Set(["parent"]);
      const flattened = flattenSessionTree(tree, expanded);

      expect(flattened).toHaveLength(2);
      expect(flattened[0].depth).toBe(0);
      expect(flattened[0].session.sessionId).toBe("parent");
      expect(flattened[0].isExpanded).toBe(true);
      expect(flattened[1].depth).toBe(1);
      expect(flattened[1].session.sessionId).toBe("child");
    });

    test("hides children when parent is collapsed", () => {
      const tree = [
        {
          session: createSession("parent"),
          children: [
            {
              session: createSession("child", "parent"),
              children: [],
            },
          ],
        },
      ];

      const expanded = new Set<string>(); // Parent not expanded
      const flattened = flattenSessionTree(tree, expanded);

      expect(flattened).toHaveLength(1); // Only parent shown
      expect(flattened[0].session.sessionId).toBe("parent");
      expect(flattened[0].isExpanded).toBe(false);
    });

    test("handles deeply nested trees", () => {
      const tree = [
        {
          session: createSession("level0"),
          children: [
            {
              session: createSession("level1", "level0"),
              children: [
                {
                  session: createSession("level2", "level1"),
                  children: [],
                },
              ],
            },
          ],
        },
      ];

      const expanded = new Set(["level0", "level1"]);
      const flattened = flattenSessionTree(tree, expanded);

      expect(flattened).toHaveLength(3);
      expect(flattened[2].depth).toBe(2);
      expect(flattened[2].session.sessionId).toBe("level2");
    });

    test("assigns monotonically increasing depth for arbitrarily deep nesting", () => {
      // Builds a 5-level chain (0 → 1 → 2 → 3 → 4) and verifies depths are
      // exactly [0, 1, 2, 3, 4] when all nodes are expanded.
      // This is the invariant the sidebar's outer-wrapper marginLeft approach relies on:
      // each level should receive its own distinct indent, not be clamped or repeated.
      const now = Date.now();
      const sessions = [
        { ...createSession("d0"),           startedAt: new Date(now - 5000).toISOString() },
        { ...createSession("d1", "d0"),     startedAt: new Date(now - 4000).toISOString() },
        { ...createSession("d2", "d1"),     startedAt: new Date(now - 3000).toISOString() },
        { ...createSession("d3", "d2"),     startedAt: new Date(now - 2000).toISOString() },
        { ...createSession("d4", "d3"),     startedAt: new Date(now - 1000).toISOString() },
      ];

      const tree = buildSessionTree(sessions);
      const allIds = new Set(sessions.map((s) => s.sessionId));
      const flattened = flattenSessionTree(tree, allIds);

      expect(flattened).toHaveLength(5);
      for (let i = 0; i < 5; i++) {
        expect(flattened[i].depth).toBe(i);
        expect(flattened[i].session.sessionId).toBe(`d${i}`);
      }
    });

    test("returns empty array for empty tree", () => {
      const flattened = flattenSessionTree([], new Set());
      expect(flattened).toHaveLength(0);
    });
  });

  describe("getSessionIndent", () => {
    test("returns 0 for root sessions (depth 0)", () => {
      expect(getSessionIndent(0)).toBe(0);
    });

    test("returns 16px per level for child sessions", () => {
      expect(getSessionIndent(1)).toBe(16);
      expect(getSessionIndent(2)).toBe(32);
      expect(getSessionIndent(3)).toBe(48);
    });

    test("handles large depth values", () => {
      expect(getSessionIndent(10)).toBe(160);
    });

    test("indent is always strictly positive for depth > 0 (wrapper must receive nonzero margin)", () => {
      // This directly guards the sidebar layout fix: the outer wrapper <div> receives
      // marginLeft = getSessionIndent(depth) for depth > 0.  If indent were 0 for any
      // depth > 0, child sessions would visually overlap their parents.
      for (let d = 1; d <= 8; d++) {
        expect(getSessionIndent(d)).toBeGreaterThan(0);
        // Also verify it's strictly larger than the previous level
        expect(getSessionIndent(d)).toBeGreaterThan(getSessionIndent(d - 1));
      }
    });
  });

  describe("getGroupCwd", () => {
    const makeSession = (id: string, cwd: string, parentId?: string): HubSession => ({
      sessionId: id,
      shareUrl: `http://localhost/session/${id}`,
      cwd,
      startedAt: new Date().toISOString(),
      parentSessionId: parentId ?? null,
    });

    const makeMap = (...sessions: HubSession[]) =>
      new Map(sessions.map((s) => [s.sessionId, s]));

    test("returns own cwd when no parent and no worktree", () => {
      const s = makeSession("a", "/projects/foo");
      expect(getGroupCwd(s, makeMap(s))).toBe("/projects/foo");
    });

    test("follows parentSessionId and returns parent cwd", () => {
      const parent = makeSession("parent", "/projects/foo");
      const child = makeSession("child", "/projects/bar", "parent");
      const map = makeMap(parent, child);
      expect(getGroupCwd(child, map)).toBe("/projects/foo");
    });

    test("follows multi-level parent chain to root cwd", () => {
      const root = makeSession("root", "/projects/root");
      const mid = makeSession("mid", "/projects/mid", "root");
      const leaf = makeSession("leaf", "/projects/leaf", "mid");
      const map = makeMap(root, mid, leaf);
      expect(getGroupCwd(leaf, map)).toBe("/projects/root");
    });

    test("returns own cwd when parentSessionId not in map", () => {
      const s = makeSession("orphan", "/projects/orphan", "nonexistent");
      expect(getGroupCwd(s, makeMap(s))).toBe("/projects/orphan");
    });

    test("worktree detection: groups child under repo root when root session exists", () => {
      const root = makeSession("root", "/projects/foo");
      const wt = makeSession("wt", "/projects/foo/.worktrees/fix-bar");
      const map = makeMap(root, wt);
      expect(getGroupCwd(wt, map)).toBe("/projects/foo");
    });

    test("worktree detection: no match when root session absent", () => {
      const wt = makeSession("wt", "/projects/foo/.worktrees/fix-bar");
      expect(getGroupCwd(wt, makeMap(wt))).toBe("/projects/foo/.worktrees/fix-bar");
    });

    test("parentSessionId takes priority over worktree detection", () => {
      const explicitParent = makeSession("explicit-parent", "/projects/explicit");
      const root = makeSession("root", "/projects/foo");
      const child = makeSession("child", "/projects/foo/.worktrees/fix-bar", "explicit-parent");
      const map = makeMap(explicitParent, root, child);
      // Should follow parentSessionId, not worktree detection
      expect(getGroupCwd(child, map)).toBe("/projects/explicit");
    });

    test("worktree path with nested subdir still finds root", () => {
      const root = makeSession("root", "/projects/foo");
      const wt = makeSession("wt", "/projects/foo/.worktrees/my-branch/subdir");
      const map = makeMap(root, wt);
      expect(getGroupCwd(wt, map)).toBe("/projects/foo");
    });

    test("handles cycle in parent chain without infinite loop", () => {
      const a = makeSession("a", "/projects/a", "b");
      const b = makeSession("b", "/projects/b", "a");
      const map = makeMap(a, b);
      // Should return something without looping (either a's or b's cwd)
      const result = getGroupCwd(a, map);
      expect(["/projects/a", "/projects/b"]).toContain(result);
    });

    test("multiple worktree sessions all group under the same root", () => {
      const root = makeSession("root", "/projects/foo");
      const wt1 = makeSession("wt1", "/projects/foo/.worktrees/branch-1");
      const wt2 = makeSession("wt2", "/projects/foo/.worktrees/branch-2");
      const map = makeMap(root, wt1, wt2);
      expect(getGroupCwd(wt1, map)).toBe("/projects/foo");
      expect(getGroupCwd(wt2, map)).toBe("/projects/foo");
    });
  });

  describe("getDescendantSessionIds", () => {
    test("returns empty array for session with no children", () => {
      const sessions = [createSession("parent")];
      expect(getDescendantSessionIds("parent", sessions)).toEqual([]);
    });

    test("returns direct children", () => {
      const sessions = [
        createSession("parent"),
        createSession("child-1", "parent"),
        createSession("child-2", "parent"),
      ];
      const ids = getDescendantSessionIds("parent", sessions);
      expect(ids).toHaveLength(2);
      expect(ids).toContain("child-1");
      expect(ids).toContain("child-2");
    });

    test("returns all descendants recursively", () => {
      const sessions = [
        createSession("root"),
        createSession("child", "root"),
        createSession("grandchild", "child"),
        createSession("great-grandchild", "grandchild"),
      ];
      const ids = getDescendantSessionIds("root", sessions);
      expect(ids).toHaveLength(3);
      expect(ids).toContain("child");
      expect(ids).toContain("grandchild");
      expect(ids).toContain("great-grandchild");
    });

    test("does not include unrelated sessions", () => {
      const sessions = [
        createSession("parent-a"),
        createSession("child-a", "parent-a"),
        createSession("parent-b"),
        createSession("child-b", "parent-b"),
      ];
      const ids = getDescendantSessionIds("parent-a", sessions);
      expect(ids).toEqual(["child-a"]);
    });

    test("returns empty array for non-existent session", () => {
      const sessions = [createSession("parent")];
      expect(getDescendantSessionIds("non-existent", sessions)).toEqual([]);
    });

    test("handles cyclic parent chains without infinite loop", () => {
      // Simulate corrupted data: A -> B -> C -> A (cycle)
      const sessions: HubSession[] = [
        { ...createSession("a", "c") },
        { ...createSession("b", "a") },
        { ...createSession("c", "b") },
      ];
      // Should terminate and return reachable descendants without looping forever
      const ids = getDescendantSessionIds("a", sessions);
      expect(ids).toContain("b");
      expect(ids).toContain("c");
      expect(ids).toHaveLength(2);
    });

    test("handles self-referencing parentSessionId", () => {
      const sessions: HubSession[] = [
        { ...createSession("self"), parentSessionId: "self" },
        { ...createSession("child", "self") },
      ];
      const ids = getDescendantSessionIds("self", sessions);
      expect(ids).toContain("child");
      // Should not include "self" itself and should not loop
      expect(ids).not.toContain("self");
    });
  });
});
