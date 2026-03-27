# Dish 011: Add Eviction to Code-Block tokensCache

- **Cook Type:** sonnet
- **Complexity:** S
- **Godmother ID:** p02fgrfW
- **Dependencies:** none
- **Files:** packages/ui/src/components/ai-elements/code-block.tsx
- **Verification:** bun run typecheck
- **Status:** queued

## Task Description

The `tokensCache` in code-block.tsx (line 130) is an unbounded `Map<string, TokenizedCode>` that never evicts entries. In long sessions with many code blocks, this grows indefinitely.

**Fix:**
1. Add a max size constant (e.g., `MAX_TOKENS_CACHE_SIZE = 200`)
2. When inserting and the cache exceeds max size, delete the oldest entry (first key via `Map.keys().next()`)
3. Also apply the same pattern to `highlighterCache` (line 123) if it's similarly unbounded — though highlighter instances are keyed by language, so the risk is lower
4. Keep the fix simple — a basic FIFO eviction using Map insertion order is fine

**Do NOT change the tokenization logic or the cache key format** — only add eviction.
