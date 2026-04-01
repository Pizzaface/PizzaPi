/**
 * AttentionProvider — React context that exposes the attention store and
 * derived selectors as hooks.
 *
 * Wrap your app in <AttentionProvider> and use the hooks below:
 *   useAttentionStore()       — raw store (for mutations)
 *   useAttentionState()       — reactive snapshot of store state
 *   useNeedsResponseCount()   — count of items needing user action
 *   useRunningCount()         — count of running items
 *   useCompletedUnreadCount() — count of completed but unread items
 *   useAttentionItemsByCategory() — grouped + sorted items
 *   useAttentionItemsForSession() — items for a specific session
 */
import * as React from "react";
import { createAttentionStore, type AttentionStore } from "./store";
import type { AttentionCategory, AttentionItem, AttentionStoreState } from "./types";
import {
  needsResponseCount,
  runningCount,
  completedUnreadCount,
  itemsByCategory,
  itemsForSession,
} from "./selectors";

// ── Context ─────────────────────────────────────────────────────────────────

const AttentionStoreContext = React.createContext<AttentionStore | null>(null);

// ── Provider ────────────────────────────────────────────────────────────────

export function AttentionProvider({ children }: { children: React.ReactNode }) {
  // Stable store instance — never changes for the lifetime of the provider.
  const [store] = React.useState(() => createAttentionStore());

  return (
    <AttentionStoreContext.Provider value={store}>
      {children}
    </AttentionStoreContext.Provider>
  );
}

// ── Hooks ───────────────────────────────────────────────────────────────────

/** Get the raw store for mutations (addItem, removeItem, etc.). */
export function useAttentionStore(): AttentionStore {
  const store = React.useContext(AttentionStoreContext);
  if (!store) throw new Error("useAttentionStore must be used within <AttentionProvider>");
  return store;
}

/** Reactive snapshot of the full store state. Re-renders on every mutation. */
export function useAttentionState(): AttentionStoreState {
  const store = useAttentionStore();
  return React.useSyncExternalStore(
    store.subscribe,
    store.getState,
    store.getState,
  );
}

/** Count of items that need user response (questions, plan reviews, etc.). */
export function useNeedsResponseCount(): number {
  const state = useAttentionState();
  return React.useMemo(() => needsResponseCount(state), [state]);
}

/** Count of running items (active agents, child sessions, compacting). */
export function useRunningCount(): number {
  const state = useAttentionState();
  return React.useMemo(() => runningCount(state), [state]);
}

/** Count of completed but unacknowledged items. */
export function useCompletedUnreadCount(): number {
  const state = useAttentionState();
  return React.useMemo(() => completedUnreadCount(state), [state]);
}

/** Items grouped by category, sorted by priority within each group. */
export function useAttentionItemsByCategory(): Map<AttentionCategory, AttentionItem[]> {
  const state = useAttentionState();
  return React.useMemo(() => itemsByCategory(state), [state]);
}

/** Items for a specific session, sorted by priority. */
export function useAttentionItemsForSession(sessionId: string | null): AttentionItem[] {
  const state = useAttentionState();
  return React.useMemo(
    () => (sessionId ? itemsForSession(state, sessionId) : []),
    [state, sessionId],
  );
}
