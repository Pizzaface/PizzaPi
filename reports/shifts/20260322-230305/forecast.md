# Shift Forecast — Opening Night

- **Total dishes:** 6
- **By cook type:** 3 Sonnet, 3 Jules
- **By complexity:** 4S, 2M, 0L
- **Estimated duration:** ~2-3 hours (light menu for opening night)
- **Staff available:** Anthropic (47% 5h), OpenAI (0% 5h), Google (0%), Jules (available)
- **Menu fits budget:** ✅ Yes — conservative menu well within capacity

## Dispatch Plan

### Wave 1 (parallel — all independent)
| Dish | Cook | Provider | Est. Time |
|------|------|----------|-----------|
| 001 Error Boundaries | Sonnet | Anthropic | 15-20 min |
| 002 Redis Health + Banner | Sonnet | Anthropic | 15-20 min |
| 003 STDIO MCP Sandbox | Jules | Google | 10-15 min |
| 004 Security Headers | Sonnet | Anthropic | 10-15 min |
| 005 Accessible Buttons | Jules | Google | 10-15 min |
| 006 .gitignore Cleanup | Jules | Google | 5-10 min |

### Critic Queue (as dishes plate)
- Critics: `gpt-5.3-codex` (OpenAI) — fresh 5-hour window
- Batch Critic: `claude-opus-4-6` at closing

## Budget Estimate
- **Anthropic:** 3 Sonnet cooks + brainstorming done + my orchestration ≈ +15-20% on 5-hour
- **OpenAI:** 6 critic reviews ≈ +5-10% on 7-day
- **Google/Jules:** 3 tasks, well within limits
- **Risk:** Low. Even with critic rounds, we stay well under Protocol 86 threshold.

## Notes
- Opening night — conservative menu to prove the process
- Chef's Specials keep things interesting without overcommitting
- All dishes are independent — maximum parallelism
