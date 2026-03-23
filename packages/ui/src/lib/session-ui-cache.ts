/**
 * Utilities for managing the per-session UI state cache (sessionUiCacheRef).
 *
 * Extracted from App.tsx so the eviction logic can be unit-tested in isolation.
 */

import type { SessionUiCacheEntry } from "./types.js";

/** Maximum number of sessions kept in the UI state cache. */
export const MAX_SESSION_UI_CACHE_SIZE = 50;

/**
 * Evict the least-recently-accessed entry from `cache` when a *new* key is
 * about to be inserted and the cache is already at capacity.
 *
 * Rules:
 * - No-op if `newKey` already exists in the map (we're updating, not inserting).
 * - No-op if `cache.size < maxSize` (there is still room).
 * - Otherwise, delete the entry whose `lastAccessed` timestamp is smallest.
 *   The `activeKey`, if provided, is excluded from eviction candidates so the
 *   currently-visible session is never evicted (it may still lose to a fresher
 *   LRU candidate in practice, but callers keep its `lastAccessed` current by
 *   refreshing it on open — see App.tsx:2045).
 *
 * @param cache     The live cache map (mutated in place).
 * @param newKey    The session ID about to be inserted.
 * @param maxSize   Upper bound on cache entries.
 * @param activeKey Optional session ID to protect from eviction.
 */
export function evictLruIfNeeded(
  cache: Map<string, SessionUiCacheEntry>,
  newKey: string,
  maxSize: number = MAX_SESSION_UI_CACHE_SIZE,
  activeKey?: string | null,
): void {
  // Only evict when adding a brand-new key and we're at or above capacity.
  if (cache.has(newKey) || cache.size < maxSize) return;

  let lruKey: string | null = null;
  let lruTime = Infinity;
  for (const [key, entry] of cache) {
    if (key === activeKey) continue; // never evict the active session
    if (entry.lastAccessed < lruTime) {
      lruTime = entry.lastAccessed;
      lruKey = key;
    }
  }
  if (lruKey !== null) {
    cache.delete(lruKey);
  }
}

/**
 * Refresh the `lastAccessed` timestamp for a session already in the cache.
 * Called when the user opens / switches to a session so it won't be selected
 * as the LRU candidate while it is actively being viewed.
 *
 * No-op when the session is not in the cache.
 */
export function touchSessionCache(
  cache: Map<string, SessionUiCacheEntry>,
  sessionId: string,
  now: number = Date.now(),
): void {
  const entry = cache.get(sessionId);
  if (entry) {
    cache.set(sessionId, { ...entry, lastAccessed: now });
  }
}
