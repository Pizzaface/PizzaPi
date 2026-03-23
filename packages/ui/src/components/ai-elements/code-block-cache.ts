/**
 * Cache utilities for code-block syntax highlighting.
 *
 * Extracted as a separate module so the FIFO eviction logic and cache-key
 * generation can be unit-tested independently of React / Shiki.
 */

// Cache size limits — prevent unbounded memory growth in long sessions
export const MAX_HIGHLIGHTER_CACHE_SIZE = 50;
export const MAX_TOKENS_CACHE_SIZE = 200;

/**
 * Evict the oldest (first-inserted) entry when the cache has reached its
 * capacity.  JavaScript Maps preserve insertion order, so `keys().next()`
 * always returns the oldest key — this is what gives us FIFO semantics.
 *
 * The eviction happens *before* the new entry is inserted so that the map
 * never exceeds `maxSize` entries.
 */
export function evictOldestIfNeeded<K, V>(map: Map<K, V>, maxSize: number): void {
  if (map.size >= maxSize) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) {
      map.delete(oldest);
    }
  }
}

/**
 * Derive a stable cache key for a (code, language) pair.
 *
 * Using the full code string as a key is wasteful for very large snippets.
 * Instead we capture: language, total length, the first 100 chars, and the
 * last 100 chars.  Two snippets that differ only in the middle (e.g. a
 * growing streamed response) will get different keys once the length changes,
 * which is the normal case during streaming.
 */
export function getTokensCacheKey(code: string, language: string): string {
  const start = code.slice(0, 100);
  const end = code.length > 100 ? code.slice(-100) : "";
  return `${language}:${code.length}:${start}:${end}`;
}
