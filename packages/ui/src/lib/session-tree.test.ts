import { describe, test, expect } from "bun:test";
import {
  buildSessionTree,
  flattenSessionTree,
  getSessionIndent,
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
      expect(tree).toHaveLength(1);
      expect(tree[0].session.sessionId).toBe("parent-1");
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
  });
});
