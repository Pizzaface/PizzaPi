# Shift Forecast

- **Total dishes:** 11
- **By cook type:** 3 Jules, 8 Sonnet
- **By complexity:** 5S, 6M
- **Estimated duration:** ~3-4 hours
- **Staff available:**
  - Anthropic (✅ 16% 5hr / 55% 7d) — Cooks, Fixers, Batch Critic
  - Google Gemini (✅ 0% all windows) — Food Critics (fallback from OpenAI)
  - OpenAI Codex (⚠️ 12% 5hr / 81% 7d) — Near capacity, NOT assigned
  - Jules (✅ available) — Line cooks for S dishes
- **Menu fits budget:** Yes — Anthropic has ~84% 5hr headroom, Gemini is fresh
- **Dependency graph:** Flat — all dishes independent, maximum parallelism
- **Fire strategy:**
  - Wave 1: All 3 Jules dishes + Sonnet dishes 004-007 (4 Sonnet)
  - Wave 2: Sonnet dishes 008-011 (as Wave 1 slots free up)
- **Critic assignment:** Gemini 3.1 Pro (OpenAI near capacity)
- **Protocol 86 threshold:** 10% remaining (Anthropic 5hr hits 90%)
