# Shift Forecast — 20260325-231756

- **Total dishes:** 5
- **By cook type:** 1 Jules, 4 Sonnet
- **By complexity:** 2S, 2M, 1L
- **By band:** 3 Band A, 2 Band B
- **Pairings:** 2 pairings (tunnel-overhaul, session-viewer-polish)
- **Estimated duration:** ~3–5 hours
- **Staff:** Anthropic (available), OpenAI Codex (3%/49% — available), Google Gemini (0%/0% — junior only), Jules (available)

## Capacity Assessment
- Anthropic budget: healthy; 4 Sonnet cooks + batch critic within budget
- Codex budget: 49% 7-day; critics viable (1 critic per pairing = 2 critics total + individual dish critics)
- Budget fits: Yes — no trimming needed

## Sandbox Requirement (All Dishes)
**MANDATORY**: Every dish must include sandbox verification before Ramsey approval.
- Cook starts sandbox: `screen -dmS sandbox bash -c 'cd packages/server && exec bun tests/harness/sandbox.ts --headless --redis=memory > /tmp/sandbox-out.log 2>&1'`
- Logs in: testuser@pizzapi-harness.test / HarnessPass123
- Takes screenshots with `playwright-cli screenshot`
- Attaches screenshot path to dish file
- Cleans up: `playwright-cli close && screen -S sandbox -X quit`

Cooks that skip sandbox → Ramsey send-back immediately.

## Risk Factors
- Dish 001 (L-complexity): largest risk; browser-side caching may interact with Vite HMR dev server quirks
- Dish 003+004 pairing: both touch SessionViewer.tsx — pairing assembly required to avoid conflict
- Jules (Dish 005): Jules is async; if delayed, solo dish ships independently; no blocking effect on other dishes
