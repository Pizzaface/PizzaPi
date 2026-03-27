# Shift Forecast

- **Total dishes:** 5
- **By cook type:** 5 Sonnet
- **By complexity:** 3S, 2M
- **Estimated duration:** ~2-3 hours
- **Staff available:** Anthropic (available), OpenAI Codex (available, 49% 5h / 15% 7d)
- **Gemini:** Available but avoided per chef's instructions
- **Menu fits budget:** Yes — 5 dishes is conservative
- **Protocol 86 threshold:** unlimited for Codex, unlimited for Anthropic (per chef override)

## Confidence Scores

| # | Dish | Clarity | Risk | Confidence | Band | Priority |
|---|------|---------|------|------------|------|----------|
| 001 | PizzaPi Dark Theme | 88 | 12 | 81 | A | high |
| 002 | Custom Header Extension | 80 | 30 | 62 | A | high |
| 003 | Footer Polish | 85 | 15 | 76 | A | high |
| 004 | Terminal Title Override | 90 | 8 | 85 | A | high |
| 005 | CLI Help Refresh | 70 | 28 | 53 | B | normal |

## Dispatch Plan

### Tranche 1 (Core): Dishes 001, 004 (no dependencies, high confidence)
### Tranche 2 (Core): Dishes 002, 003 (depend on 001 theme)
### Tranche 3 (Stretch): Dish 005 (independent, Band B — larger scope)

## Dependency Graph

```
001 (theme) ──→ 002 (header)
           ──→ 003 (footer)
004 (title) ── independent
005 (CLI help) ── independent
```

Fire order: 001 + 004 first → when 001 plates, fire 002 + 003 → 005 when capacity allows.

## Critic Assignment

- **Critics:** gpt-5.3-codex (OpenAI) — different provider from cooks
- **Expected critic rounds:** 2 per dish (based on prior shift pattern)
