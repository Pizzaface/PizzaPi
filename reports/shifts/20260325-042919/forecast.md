# Shift Forecast — Bug Bash

- **Total dishes:** 4
- **By cook type:** 4 Sonnet
- **By complexity:** 3 S, 1 M
- **Estimated duration:** ~1.5–2.5 hours
- **Staff available:** Anthropic (available, unlimited), OpenAI-Codex (6%/24%, unlimited), Gemini (excluded)
- **Menu fits budget:** Yes — well within capacity

## Confidence Scores

| Dish | clarity | risk | confidence | Band |
|------|---------|------|------------|------|
| 001 (keyboard fix) | 86 | 18 | 75 | A |
| 002 (search assertion) | 92 | 14 | 83 | A |
| 003 (session type) | 72 | 36 | 50 | B |
| 004 (stale descriptions) | 94 | 10 | 88 | A |

## Dispatch Order
1. 001 (Band A, P1) — fire immediately
2. 002 (Band A, P2) — fire with 001 (parallel)
3. 004 (Band A, P3) — fire with 001/002 (parallel)
4. 003 (Band B, P2) — fire after at least one expo pass

## Tranche
- **Core:** All 4 dishes
- **Stretch:** None

## Skipped Items
- fIUvBDLZ: Design status — no actionable code target. Remains in Godmother as design.
- 2UDzk4SB: Bridge sessions replaced by adopted sessions with disconnect fallback. Marking shipped.
