import { describe, expect, test } from "bun:test";
import { createAttentionStore } from "./store";
import {
  needsResponseCount,
  runningCount,
  completedUnreadCount,
  itemsByCategory,
  itemsForSession,
  totalCount,
} from "./selectors";
import type { AttentionItem, AttentionCategory, AttentionStoreState } from "./types";

function makeItem(overrides: Partial<AttentionItem> = {}): AttentionItem {
  return {
    id: `item-${Math.random().toString(36).slice(2)}`,
    category: "needs_response",
    kind: "question",
    sessionId: "session-abc",
    createdAt: new Date().toISOString(),
    priority: 50,
    source: "meta",
    ...overrides,
  };
}

function stateWith(items: AttentionItem[]): AttentionStoreState {
  const map = new Map<string, AttentionItem>();
  for (const item of items) map.set(item.id, item);
  return { items: map, version: 1 };
}

describe("needsResponseCount", () => {
  test("returns 0 for empty state", () => {
    expect(needsResponseCount(stateWith([]))).toBe(0);
  });

  test("counts only needs_response items", () => {
    const state = stateWith([
      makeItem({ id: "a", category: "needs_response" }),
      makeItem({ id: "b", category: "needs_response" }),
      makeItem({ id: "c", category: "running" }),
      makeItem({ id: "d", category: "completed" }),
    ]);
    expect(needsResponseCount(state)).toBe(2);
  });
});

describe("runningCount", () => {
  test("returns 0 for empty state", () => {
    expect(runningCount(stateWith([]))).toBe(0);
  });

  test("counts only running items", () => {
    const state = stateWith([
      makeItem({ id: "a", category: "running" }),
      makeItem({ id: "b", category: "running" }),
      makeItem({ id: "c", category: "needs_response" }),
    ]);
    expect(runningCount(state)).toBe(2);
  });
});

describe("completedUnreadCount", () => {
  test("returns 0 for empty state", () => {
    expect(completedUnreadCount(stateWith([]))).toBe(0);
  });

  test("counts only completed items", () => {
    const state = stateWith([
      makeItem({ id: "a", category: "completed" }),
      makeItem({ id: "b", category: "running" }),
      makeItem({ id: "c", category: "needs_response" }),
    ]);
    expect(completedUnreadCount(state)).toBe(1);
  });
});

describe("totalCount", () => {
  test("returns total number of items", () => {
    const state = stateWith([
      makeItem({ id: "a", category: "needs_response" }),
      makeItem({ id: "b", category: "running" }),
      makeItem({ id: "c", category: "completed" }),
      makeItem({ id: "d", category: "info" }),
    ]);
    expect(totalCount(state)).toBe(4);
  });

  test("returns 0 for empty state", () => {
    expect(totalCount(stateWith([]))).toBe(0);
  });
});

describe("itemsByCategory", () => {
  test("returns empty map for empty state", () => {
    const grouped = itemsByCategory(stateWith([]));
    expect(grouped.size).toBe(0);
  });

  test("groups items by category", () => {
    const state = stateWith([
      makeItem({ id: "a", category: "needs_response" }),
      makeItem({ id: "b", category: "running" }),
      makeItem({ id: "c", category: "running" }),
      makeItem({ id: "d", category: "completed" }),
    ]);
    const grouped = itemsByCategory(state);
    expect(grouped.get("needs_response")?.length).toBe(1);
    expect(grouped.get("running")?.length).toBe(2);
    expect(grouped.get("completed")?.length).toBe(1);
    expect(grouped.has("info")).toBe(false); // empty groups removed
  });

  test("sorts items by priority ascending within each group", () => {
    const state = stateWith([
      makeItem({ id: "low", category: "needs_response", priority: 50, createdAt: "2024-01-01T00:00:00.000Z" }),
      makeItem({ id: "high", category: "needs_response", priority: 5, createdAt: "2024-01-01T00:00:00.000Z" }),
      makeItem({ id: "med", category: "needs_response", priority: 10, createdAt: "2024-01-01T00:00:00.000Z" }),
    ]);
    const grouped = itemsByCategory(state);
    const ids = grouped.get("needs_response")!.map((i) => i.id);
    expect(ids).toEqual(["high", "med", "low"]);
  });

  test("sorts by createdAt descending when priorities are equal", () => {
    const state = stateWith([
      makeItem({ id: "older", category: "running", priority: 50, createdAt: "2024-01-01T00:00:00.000Z" }),
      makeItem({ id: "newer", category: "running", priority: 50, createdAt: "2024-06-01T00:00:00.000Z" }),
    ]);
    const grouped = itemsByCategory(state);
    const ids = grouped.get("running")!.map((i) => i.id);
    expect(ids).toEqual(["newer", "older"]);
  });

  test("puts unknown categories in info bucket", () => {
    const state = stateWith([
      makeItem({ id: "a", category: "unknown-cat" as AttentionCategory }),
    ]);
    const grouped = itemsByCategory(state);
    expect(grouped.get("info")?.length).toBe(1);
  });
});

describe("itemsForSession", () => {
  test("returns only items for the specified session", () => {
    const state = stateWith([
      makeItem({ id: "a", sessionId: "s1" }),
      makeItem({ id: "b", sessionId: "s1" }),
      makeItem({ id: "c", sessionId: "s2" }),
    ]);
    const items = itemsForSession(state, "s1");
    expect(items.length).toBe(2);
    expect(items.every((i) => i.sessionId === "s1")).toBe(true);
  });

  test("returns empty array for unknown session", () => {
    const state = stateWith([makeItem({ sessionId: "s1" })]);
    expect(itemsForSession(state, "nonexistent")).toEqual([]);
  });

  test("sorts by priority then createdAt descending", () => {
    const state = stateWith([
      makeItem({ id: "low-pri", sessionId: "s1", priority: 50, createdAt: "2024-06-01T00:00:00.000Z" }),
      makeItem({ id: "high-pri", sessionId: "s1", priority: 5, createdAt: "2024-01-01T00:00:00.000Z" }),
    ]);
    const items = itemsForSession(state, "s1");
    expect(items[0].id).toBe("high-pri");
    expect(items[1].id).toBe("low-pri");
  });
});

describe("selectors integrate with store", () => {
  test("counts react to store mutations", () => {
    const store = createAttentionStore();
    expect(needsResponseCount(store.getState())).toBe(0);

    store.addItem(makeItem({ id: "q1", category: "needs_response" }));
    expect(needsResponseCount(store.getState())).toBe(1);

    store.addItem(makeItem({ id: "q2", category: "needs_response" }));
    expect(needsResponseCount(store.getState())).toBe(2);

    store.removeItem("q1");
    expect(needsResponseCount(store.getState())).toBe(1);
  });
});
