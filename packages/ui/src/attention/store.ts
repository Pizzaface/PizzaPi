/**
 * Attention store — plain object + subscriber pattern.
 *
 * Compatible with React.useSyncExternalStore for tear-free reads.
 * All mutations are synchronous and bump the version counter.
 */
import type { AttentionItem, AttentionStoreState } from "./types";

export type AttentionStoreListener = () => void;

export interface AttentionStore {
  getState(): AttentionStoreState;
  subscribe(listener: AttentionStoreListener): () => void;
  addItem(item: AttentionItem): void;
  removeItem(id: string): void;
  updateItem(id: string, patch: Partial<AttentionItem>): void;
  clear(): void;
  removeBySessionId(sessionId: string): void;
  /** Bulk-replace all items for a session + source. Removes stale items, upserts fresh ones. */
  replaceBySessionSource(sessionId: string, source: AttentionItem["source"], items: AttentionItem[]): void;
}

export function createAttentionStore(): AttentionStore {
  let state: AttentionStoreState = {
    items: new Map(),
    version: 0,
  };

  const listeners = new Set<AttentionStoreListener>();

  function notify() {
    for (const fn of listeners) {
      fn();
    }
  }

  return {
    getState() {
      return state;
    },

    subscribe(listener: AttentionStoreListener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    addItem(item: AttentionItem) {
      const next = new Map(state.items);
      next.set(item.id, item);
      state = { items: next, version: state.version + 1 };
      notify();
    },

    removeItem(id: string) {
      if (!state.items.has(id)) return;
      const next = new Map(state.items);
      next.delete(id);
      state = { items: next, version: state.version + 1 };
      notify();
    },

    updateItem(id: string, patch: Partial<AttentionItem>) {
      const existing = state.items.get(id);
      if (!existing) return;
      const next = new Map(state.items);
      next.set(id, { ...existing, ...patch });
      state = { items: next, version: state.version + 1 };
      notify();
    },

    clear() {
      if (state.items.size === 0) return;
      state = { items: new Map(), version: state.version + 1 };
      notify();
    },

    removeBySessionId(sessionId: string) {
      let changed = false;
      const next = new Map<string, AttentionItem>();
      for (const [id, item] of state.items) {
        if (item.sessionId === sessionId) {
          changed = true;
        } else {
          next.set(id, item);
        }
      }
      if (!changed) return;
      state = { items: next, version: state.version + 1 };
      notify();
    },

    replaceBySessionSource(sessionId: string, source: AttentionItem["source"], items: AttentionItem[]) {
      const next = new Map<string, AttentionItem>();
      // Keep items from other sessions or other sources
      for (const [id, item] of state.items) {
        if (item.sessionId === sessionId && item.source === source) continue;
        next.set(id, item);
      }
      // Insert the fresh items
      for (const item of items) {
        next.set(item.id, item);
      }
      state = { items: next, version: state.version + 1 };
      notify();
    },
  };
}
