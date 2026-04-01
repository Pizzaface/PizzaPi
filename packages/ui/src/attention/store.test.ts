import { describe, expect, test } from "bun:test";
import { createAttentionStore } from "./store";
import type { AttentionItem } from "./types";

function makeItem(overrides: Partial<AttentionItem> = {}): AttentionItem {
  return {
    id: "item-1",
    category: "needs_response",
    kind: "question",
    sessionId: "session-abc",
    createdAt: new Date().toISOString(),
    priority: 50,
    source: "meta",
    ...overrides,
  };
}

describe("createAttentionStore", () => {
  test("starts with empty state", () => {
    const store = createAttentionStore();
    const state = store.getState();
    expect(state.items.size).toBe(0);
    expect(state.version).toBe(0);
  });

  describe("addItem", () => {
    test("adds an item and increments version", () => {
      const store = createAttentionStore();
      const item = makeItem();
      store.addItem(item);
      const state = store.getState();
      expect(state.items.size).toBe(1);
      expect(state.items.get("item-1")).toEqual(item);
      expect(state.version).toBe(1);
    });

    test("overwrites existing item with same id", () => {
      const store = createAttentionStore();
      store.addItem(makeItem({ sessionName: "Session A" }));
      store.addItem(makeItem({ sessionName: "Session B" }));
      expect(store.getState().items.size).toBe(1);
      expect(store.getState().items.get("item-1")?.sessionName).toBe("Session B");
    });

    test("notifies subscribers", () => {
      const store = createAttentionStore();
      let callCount = 0;
      store.subscribe(() => callCount++);
      store.addItem(makeItem());
      expect(callCount).toBe(1);
    });
  });

  describe("removeItem", () => {
    test("removes existing item", () => {
      const store = createAttentionStore();
      store.addItem(makeItem());
      store.removeItem("item-1");
      expect(store.getState().items.size).toBe(0);
      expect(store.getState().version).toBe(2);
    });

    test("no-ops if item does not exist", () => {
      const store = createAttentionStore();
      const beforeVersion = store.getState().version;
      store.removeItem("nonexistent");
      expect(store.getState().version).toBe(beforeVersion);
    });

    test("notifies subscribers only when item existed", () => {
      const store = createAttentionStore();
      store.addItem(makeItem());
      let callCount = 0;
      store.subscribe(() => callCount++);
      store.removeItem("item-1");
      expect(callCount).toBe(1);
      store.removeItem("item-1"); // no-op
      expect(callCount).toBe(1);
    });
  });

  describe("updateItem", () => {
    test("patches existing item", () => {
      const store = createAttentionStore();
      store.addItem(makeItem({ sessionName: "old name" }));
      store.updateItem("item-1", { sessionName: "new name" });
      expect(store.getState().items.get("item-1")?.sessionName).toBe("new name");
    });

    test("preserves unpatched fields", () => {
      const store = createAttentionStore();
      const item = makeItem({ priority: 10, kind: "plan_review" });
      store.addItem(item);
      store.updateItem("item-1", { sessionName: "patched" });
      const updated = store.getState().items.get("item-1")!;
      expect(updated.priority).toBe(10);
      expect(updated.kind).toBe("plan_review");
      expect(updated.sessionName).toBe("patched");
    });

    test("no-ops if item does not exist", () => {
      const store = createAttentionStore();
      const beforeVersion = store.getState().version;
      store.updateItem("nonexistent", { sessionName: "x" });
      expect(store.getState().version).toBe(beforeVersion);
    });
  });

  describe("clear", () => {
    test("removes all items", () => {
      const store = createAttentionStore();
      store.addItem(makeItem({ id: "a" }));
      store.addItem(makeItem({ id: "b" }));
      store.clear();
      expect(store.getState().items.size).toBe(0);
    });

    test("no-ops if already empty", () => {
      const store = createAttentionStore();
      const beforeVersion = store.getState().version;
      store.clear();
      expect(store.getState().version).toBe(beforeVersion);
    });

    test("notifies subscribers only when items existed", () => {
      const store = createAttentionStore();
      store.addItem(makeItem());
      let callCount = 0;
      store.subscribe(() => callCount++);
      store.clear();
      expect(callCount).toBe(1);
      store.clear(); // no-op
      expect(callCount).toBe(1);
    });
  });

  describe("removeBySessionId", () => {
    test("removes all items for a session", () => {
      const store = createAttentionStore();
      store.addItem(makeItem({ id: "a", sessionId: "session-1" }));
      store.addItem(makeItem({ id: "b", sessionId: "session-1" }));
      store.addItem(makeItem({ id: "c", sessionId: "session-2" }));
      store.removeBySessionId("session-1");
      const state = store.getState();
      expect(state.items.size).toBe(1);
      expect(state.items.has("c")).toBe(true);
    });

    test("no-ops if no items for that session", () => {
      const store = createAttentionStore();
      store.addItem(makeItem({ sessionId: "other" }));
      const beforeVersion = store.getState().version;
      store.removeBySessionId("nonexistent-session");
      expect(store.getState().version).toBe(beforeVersion);
    });
  });

  describe("replaceBySessionSource", () => {
    test("replaces all items for a session+source", () => {
      const store = createAttentionStore();
      store.addItem(makeItem({ id: "old-1", sessionId: "s1", source: "meta" }));
      store.addItem(makeItem({ id: "old-2", sessionId: "s1", source: "meta" }));
      store.addItem(makeItem({ id: "keep-1", sessionId: "s1", source: "trigger" }));
      store.addItem(makeItem({ id: "keep-2", sessionId: "s2", source: "meta" }));

      const fresh = [makeItem({ id: "new-1", sessionId: "s1", source: "meta" })];
      store.replaceBySessionSource("s1", "meta", fresh);

      const state = store.getState();
      expect(state.items.has("old-1")).toBe(false);
      expect(state.items.has("old-2")).toBe(false);
      expect(state.items.has("keep-1")).toBe(true);
      expect(state.items.has("keep-2")).toBe(true);
      expect(state.items.has("new-1")).toBe(true);
    });

    test("can clear by passing empty array", () => {
      const store = createAttentionStore();
      store.addItem(makeItem({ id: "a", sessionId: "s1", source: "meta" }));
      store.replaceBySessionSource("s1", "meta", []);
      expect(store.getState().items.has("a")).toBe(false);
    });

    test("always bumps version", () => {
      const store = createAttentionStore();
      const before = store.getState().version;
      store.replaceBySessionSource("s1", "meta", []);
      expect(store.getState().version).toBeGreaterThan(before);
    });
  });

  describe("subscribe", () => {
    test("returns unsubscribe function", () => {
      const store = createAttentionStore();
      let callCount = 0;
      const unsub = store.subscribe(() => callCount++);
      store.addItem(makeItem());
      expect(callCount).toBe(1);
      unsub();
      store.addItem(makeItem({ id: "item-2" }));
      expect(callCount).toBe(1); // not called after unsub
    });

    test("state returned by getState() is stable until mutation", () => {
      const store = createAttentionStore();
      const s1 = store.getState();
      const s2 = store.getState();
      expect(s1).toBe(s2); // same reference
      store.addItem(makeItem());
      const s3 = store.getState();
      expect(s3).not.toBe(s1); // new reference after mutation
    });
  });
});
