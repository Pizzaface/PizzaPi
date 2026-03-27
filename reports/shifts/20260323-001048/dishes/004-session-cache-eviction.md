# Dish 004: sessionUiCacheRef LRU Eviction

- **Cook Type:** sonnet
- **Complexity:** M
- **Godmother ID:** Hjsibp2R
- **Dependencies:** none
- **Files:** packages/ui/src/App.tsx
- **Verification:** bun run typecheck
- **Status:** queued

## Task Description

`sessionUiCacheRef` in App.tsx (line 371) is a `Map<string, SessionUiCacheEntry>` that grows unbounded — entries are added every time a session is viewed but never evicted.

**Fix:**
1. Add an LRU eviction policy — when the cache exceeds a max size (e.g., 50 entries), evict the least-recently-accessed entry
2. Add a `lastAccessed` timestamp to `SessionUiCacheEntry` (or track access order via a separate list)
3. On every cache read (line ~377), update `lastAccessed`
4. On every cache write (line ~398), check size and evict if needed
5. Consider adding a `MAX_SESSION_UI_CACHE_SIZE` constant at the top of the file

**Important:** Do NOT change the external API or behavior — this is purely internal memory management. Sessions should still cache correctly while being viewed.
