# Tonight's Menu — 20260325-043904 (EXPANDED by Chef)

| # | Dish | Cook Type | Complexity | Band | Dependencies | Godmother ID | Status |
|---|------|-----------|------------|------|--------------|--------------|--------|
| 001 | Phase 1: Daemon Refactor | sonnet | L | A | none | 9mOLVdjU | served ✅ |
| 002 | Phase 2: Relay Generic Service Envelope (server + protocol) | sonnet | L | A | 001 | 9mOLVdjU | plated |
| 003 | Phase 3: UI useServiceChannel Hook + Panel Refactors | sonnet | L | A | 002 | 9mOLVdjU | queued |
| 004 | Phase 4: TunnelService — HTTP proxy over relay (Option C) | sonnet | L | B | 002 | isxRzBqL | queued (stretch) |

**Core tranche:** 001 → 002 → 003
**Stretch tranche:** 004 (parallel with 003 after 002 completes)
**Critical path:** ~5-7 hours

## Scope Expansion Note
Chef requested full pipeline at 04:44 UTC. Maître d' decision:
- Parts 1-3: committed to shipping
- Part 4 (TunnelService): stretch, scoped to Option C (HTTP-only, no WS upgrade, no streaming bodies)
  - isxRzBqL is P3, has unresolved design questions, explicitly "blocked_by" Phase 1
  - Attempt after 002 completes. If expo fails → capture to Godmother, not poisoned.
