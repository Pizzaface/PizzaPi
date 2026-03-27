# Incident Log — Night Shift 20260323-001048

## Reviewer Death — 00:30
- **Dish:** 006 — Replace Bun.sleepSync with async sleep
- **Session:** 5b00f70a-d7c1-45ca-baa4-77946869f400
- **Model:** gemini-3.1-pro-preview
- **Error:** Critic session completed with empty output — no verdict returned
- **Action:** Dish stays plated-unreviewed. Not retrying — budget preservation.

## Reviewer Death — 00:32
- **Dish:** 007 — Replace existsSync with async in static.ts
- **Session:** 5dbf939e-fc0f-465f-a9e6-48ee1209d241
- **Model:** gemini-3.1-pro-preview
- **Error:** Critic session completed with empty output — no verdict returned
- **Action:** Dish stays plated-unreviewed. Pattern: 2/2 Gemini critics died. Will monitor remaining Gemini critics — if pattern continues, may need to switch critic provider.

## Reviewer Death — 00:35 (Gemini 86'd as critic)
- **Dish:** 004 — sessionUiCacheRef LRU eviction
- **Session:** de7d8b36-c292-4b1c-80b6-320f04bf90bf
- **Model:** gemini-3.1-pro-preview
- **Error:** Critic session completed with empty output — 3rd consecutive Gemini critic death
- **Action:** Gemini 86'd as critic provider for this shift. All future critics dispatched to Anthropic Opus. Dishes 004, 006, 007 stay plated-unreviewed.

## Dish 001 Sent Back — 00:37
- **Dish:** 001 — Reduce Socket.IO maxHttpBufferSize
- **Critic:** 772de74d (gemini-3.1-pro-preview) — actually worked this time!
- **Issues:** P1 CLI chunking assumes 100MB (MAX_MESSAGE_SIZE=50MB, CHUNK_THRESHOLD=10MB), P2 stale comments
- **Action:** Fixer dispatched (36d24380, claude-sonnet-4-6). Round 1 of 3.

## Dish 001 Sent Back (Round 2) — 00:48
- **Critic:** 595b4d9d (claude-opus-4-6)
- **Issue:** P1 — CHUNK_BYTE_LIMIT=8MB is 80% of 10MB server limit, no overhead margin
- **Action:** Fixer dispatched (0f3f72c2) — one-line fix: reduce to 6MB. Round 2 of 3.

## Reviewer Slow — 00:50 (resolved)
- **Dish:** 005 — Replace alert/confirm in RunnerManager
- **Session:** 3b2579d4 (gemini-3.1-pro-preview)
- **Error:** Gemini critic was slow but returned LGTM. Reclassified from death to slow.
- **Action:** Dish 005 served. Gemini critic count: 3 dead, 2 functional (dishes 001, 005).
