# Shift Forecast

- **Total dishes:** 6
- **By cook type:** 6 Sonnet (all Anthropic)
- **By complexity:** 1L, 4M, 1S
- **Estimated duration:** ~2-3 hours
- **Staff available:** Anthropic (available — unlimited per user directive)
- **Menu fits budget:** Yes

## Dispatch Plan

### Wave 1: Foundation
- Dish 001 (Test Server Factory) — L, Band A, depth 0

### Wave 2: Mock Clients (parallel)
- Dish 002 (Mock Runner) — M, Band A, depth 1
- Dish 003 (Mock Session/Conversation) — M, Band A, depth 1
- Dish 004 (Mock Viewer) — M, Band A, depth 1

### Wave 3: Integration
- Dish 005 (BDD + Integration Tests) — M, Band B, depth 2

### Wave 4: Polish
- Dish 006 (Documentation) — S, Band A, depth 3

## Tranches
- **Core:** 001, 002, 003, 004, 005
- **Stretch:** 006

## Critics
- Using claude-opus-4-6 for critics (Codex 86'd at 99% 7-day)
- Critic dispatch after each wave's expo
