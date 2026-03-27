# Shift Forecast — Night Shift 2

- **Total dishes:** 4
- **By cook type:** 4 Sonnet
- **By complexity:** 3S, 1M
- **By band:** 2 Band A, 2 Band B
- **Estimated duration:** ~2-3 hours
- **Staff available:** Anthropic (available), OpenAI (available for critics)
- **Menu fits budget:** Yes — no trimming needed

## Dispatch Order (DAG)

```
001 (Band A, M) ──┐
002 (Band A, S) ──┤ → Fire 001+002 simultaneously (batch=2)
003 (Band B, S) ──┘ → Fire 003 after first cycle completes
004 (Band B, S, soft-dep 001) → Fire 004 after 001 plates
```

Dish 004 has a soft dependency on 001 (needs the theme file to evaluate plum tokens). If 001 is delayed, 004 can still proceed using the NS1 PR branch theme values as reference.

## Tranche Plan

- **Core:** 001, 002, 003, 004 — all four
- **Stretch:** None — clean focused menu

## Protocol 86 Threshold

P86 fires at 90% utilization. User said "unlimited" for Anthropic and Codex — but we monitor responsibly.
