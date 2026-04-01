/**
 * Attention store selectors — pure functions over AttentionStoreState.
 *
 * These are kept separate from the store so they can be tested in isolation
 * and composed freely in hooks.
 */
import type { AttentionCategory, AttentionItem, AttentionStoreState } from "./types";

/** Priority ordering within categories. Lower index = shown first. */
export const CATEGORY_ORDER: AttentionCategory[] = ["needs_response", "running", "completed", "info"];

/** Count of items where category === "needs_response". */
export function needsResponseCount(state: AttentionStoreState): number {
  let count = 0;
  for (const item of state.items.values()) {
    if (item.category === "needs_response") count++;
  }
  return count;
}

/** Count of items where category === "running". */
export function runningCount(state: AttentionStoreState): number {
  let count = 0;
  for (const item of state.items.values()) {
    if (item.category === "running") count++;
  }
  return count;
}

/** Count of items where category === "completed". */
export function completedUnreadCount(state: AttentionStoreState): number {
  let count = 0;
  for (const item of state.items.values()) {
    if (item.category === "completed") count++;
  }
  return count;
}

/** All items grouped by category, sorted by priority within each group. */
export function itemsByCategory(state: AttentionStoreState): Map<AttentionCategory, AttentionItem[]> {
  const groups = new Map<AttentionCategory, AttentionItem[]>();

  for (const cat of CATEGORY_ORDER) {
    groups.set(cat, []);
  }

  for (const item of state.items.values()) {
    const list = groups.get(item.category);
    if (list) {
      list.push(item);
    } else {
      // Unknown category — put in info
      groups.get("info")!.push(item);
    }
  }

  // Sort each group by priority (lower = more urgent), then by createdAt (newer first)
  for (const list of groups.values()) {
    list.sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority;
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });
  }

  // Remove empty groups
  for (const [cat, list] of groups) {
    if (list.length === 0) groups.delete(cat);
  }

  return groups;
}

/** Items for a specific session, sorted by priority. */
export function itemsForSession(state: AttentionStoreState, sessionId: string): AttentionItem[] {
  const result: AttentionItem[] = [];
  for (const item of state.items.values()) {
    if (item.sessionId === sessionId) result.push(item);
  }
  result.sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  });
  return result;
}

/** Total item count across all categories. */
export function totalCount(state: AttentionStoreState): number {
  return state.items.size;
}
