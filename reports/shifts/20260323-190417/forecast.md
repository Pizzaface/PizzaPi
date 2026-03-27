# Shift Forecast (v2, post-Opus refinement)

- **Total dishes:** 11 (1 served, 10 to cook)
- **By cook type:** 10 Sonnet (code), 1 Opus (served)
- **By complexity:** 2 XS, 4 S, 4 M, 1 L (served)
- **Estimated duration:** ~4-5 hours
  - Wave 1 (8 parallel): ~2-3 hours (004-006 are M, set the pace)
  - Wave 2 (2 parallel, after Wave 1): ~1 hour
- **Staff available:**
  - Anthropic: ✅ Available (claude-sonnet-4-6)
  - Google Gemini CLI: ✅ Available (0-21%) — critics
  - OpenAI Codex: ⚠️ Near capacity (7-day: 85%) — reserve only
- **Menu fits budget:** Yes

## Risk Analysis

| Risk | Impact | Mitigation |
|------|--------|------------|
| Extraction breaks circular imports | Build failure | Each extraction is mechanical — keep import graph clean |
| Multiple PRs conflict on relay.ts | Merge conflicts | Fire extractions sequentially, not truly parallel on same file |
| Heartbeat quick-win (009) changes protocol | Old CLI compat | New event is additive — old CLIs keep sending full SA |

## Important Note on Wave 1 Parallelism

Dishes 001-006 all extract FROM relay.ts. They can't literally all edit relay.ts simultaneously — that creates merge conflicts. 

**Recommended approach:** 
- Fire 001-003 first (small extractions, XS-S)
- Then 004-006 (medium extractions, build on cleaner relay.ts)
- Fire 009 and 010 truly in parallel (different files entirely)
