# Shift Forecast

- **Total dishes:** 9 (8 kitchen + 1 sidework)
- **By service:** 2 Docker versioning, 1 Tunnel research, 4 UI stability, 1 Panel grid, 1 Godmother cleanup
- **By cook type:** 6 Sonnet, 1 Codex (research), 1 Haiku swarm, 1 Opus (brainstorm for 008)
- **By complexity:** 3S, 3M, 2L, 1 sidework
- **By band:** 5 Band A, 3 Band B, 1 unscored (sidework)
- **Pairings:** 2 (docker-versioning: 001+002, ui-stability: 004+005+006)
- **Solo dishes:** 003 (research), 007 (clearSelection), 008 (panel grid)
- **Estimated duration:** ~4-5 hours
- **Staff available:** Anthropic (unlimited), OpenAI Codex (unlimited), Google (available)
- **Menu fits budget:** Yes — p86-limit is unlimited for Codex and Anthropic

## Dispatch Order (by priority)
1. **Band A high-priority (parallel):** 003, 004, 005, 006 (no deps, S/L)
2. **Band A (after 001 plates):** 002 (depends on 001)
3. **Band A prelim:** 001 (pairing prelim for docker-versioning)
4. **Band B (after expo pass):** 007, 008 (needs brainstorm first)
5. **Sidework (haiku swarm):** 009 (Godmother cleanup, runs parallel)

## Core Tranche
Dishes 001-006, 009 (must-attempt)

## Stretch Tranche
Dishes 007, 008 (attempt if capacity allows after core completes)

## Risk Factors
- Dish 008 (Panel Grid) is L-complexity touching App.tsx (3659 lines) — highest regression risk
- Dish 003 (Tunnel Audit) is read-only research — zero regression risk
- Dish 007 touches App.tsx — monitor for conflicts with 008
