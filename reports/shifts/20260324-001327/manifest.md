# Session Manifest — Night Shift 20260324-001327

| Session ID | Role | Dish | Model | Provider | Status | Started |
|------------|------|------|-------|----------|--------|---------|
| — | maître-d | — | — | — | unattended-handoff | 2026-03-24T00:13:27Z |
| 046e5910 | cook | 001 | claude-sonnet-4-6 | anthropic | plated | 2026-03-24T00:20:00Z |
| e5866f42 | critic | 001 | gpt-5.3-codex | openai-codex | issues-found | 2026-03-24T00:40:00Z |
| b4db30ec | fixer | 001 | claude-sonnet-4-6 | anthropic | plated | 2026-03-24T00:50:00Z |
| f9239d6d | critic | 001 | gpt-5.3-codex | openai-codex | LGTM | 2026-03-24T00:55:00Z |
| 1378d10a | cook | 002 | claude-sonnet-4-6 | anthropic | plated | 2026-03-24T00:40:00Z |
| c0e85a0a | critic | 002 | gpt-5.3-codex | openai-codex | issues-found | 2026-03-24T01:15:00Z |
| 09699c5a | fixer | 002 | claude-sonnet-4-6 | anthropic | plated | 2026-03-24T01:25:00Z |
| 9a68d412 | critic | 002 | gpt-5.3-codex | openai-codex | served-with-notes | 2026-03-24T01:50:00Z |
| 4216b9fa | cook | 003 | claude-sonnet-4-6 | anthropic | plated | 2026-03-24T00:40:00Z |
| efde63f5 | critic | 003 | gpt-5.3-codex | openai-codex | issues-found | 2026-03-24T01:20:00Z |
| 23f07e8d | fixer | 003 | claude-sonnet-4-6 | anthropic | plated | 2026-03-24T01:30:00Z |
| dd99cba9 | critic | 003 | gpt-5.3-codex | openai-codex | served-with-notes | 2026-03-24T01:45:00Z |
| 92fab8f3 | cook | 004 | claude-sonnet-4-6 | anthropic | plated | 2026-03-24T00:40:00Z |
| e2ca247a | critic | 004 | gpt-5.3-codex | openai-codex | issues-found | 2026-03-24T01:00:00Z |
| 83c73292 | fixer | 004 | claude-sonnet-4-6 | anthropic | plated | 2026-03-24T01:10:00Z |
| 6030493f | critic | 004 | gpt-5.3-codex | openai-codex | served-with-notes | 2026-03-24T01:35:00Z |

Unattended mode — skipping plan_mode. Proceeding directly to Kitchen with 6 dishes.

| ef9db486 | cook | 005 | claude-sonnet-4-6 | anthropic | plated | 2026-03-24T02:00:00Z |
| ffcdf5f7 | critic | 005 | gpt-5.3-codex | openai-codex | issues-found | 2026-03-24T02:15:00Z |
| 3b9a73f8 | fixer | 005 | claude-sonnet-4-6 | anthropic | plated | 2026-03-24T02:25:00Z |
| 8ceec759 | critic | 005 | gpt-5.3-codex | openai-codex | served-with-notes | 2026-03-24T02:35:00Z |
| 2bd483d1 | cook | 006 | claude-sonnet-4-6 | anthropic | served | 2026-03-24T02:40:00Z |

## Confidence Decisions

```json
{"event":"confidence-score","dish":"001","timestamp":"2026-03-24T00:13:27Z","inputs":{"specCompleteness":5,"verificationSpecificity":4,"dependencyCertainty":5,"complexityRisk":3,"priorFailureRisk":0,"providerFragilityRisk":0},"decision":"clarityScore=93, riskScore=27, confidenceScore=77, band=A","rationale":"Concrete spec, existing E2E pattern, no deps","rollback":"none"}
```
```json
{"event":"confidence-score","dish":"002","timestamp":"2026-03-24T00:13:27Z","inputs":{"specCompleteness":4,"verificationSpecificity":4,"dependencyCertainty":5,"complexityRisk":2,"priorFailureRisk":0,"providerFragilityRisk":0},"decision":"clarityScore=85, riskScore=18, confidenceScore=74, band=A","rationale":"Clear spec, single dep","rollback":"none"}
```
```json
{"event":"confidence-score","dish":"003","timestamp":"2026-03-24T00:13:27Z","inputs":{"specCompleteness":5,"verificationSpecificity":4,"dependencyCertainty":5,"complexityRisk":2,"priorFailureRisk":0,"providerFragilityRisk":0},"decision":"clarityScore=93, riskScore=18, confidenceScore=82, band=A","rationale":"Detailed builders, pure functions","rollback":"none"}
```
```json
{"event":"confidence-score","dish":"004","timestamp":"2026-03-24T00:13:27Z","inputs":{"specCompleteness":4,"verificationSpecificity":4,"dependencyCertainty":5,"complexityRisk":2,"priorFailureRisk":0,"providerFragilityRisk":0},"decision":"clarityScore=85, riskScore=18, confidenceScore=74, band=A","rationale":"Clear viewer/hub spec","rollback":"none"}
```
```json
{"event":"confidence-score","dish":"005","timestamp":"2026-03-24T00:13:27Z","inputs":{"specCompleteness":4,"verificationSpecificity":3,"dependencyCertainty":4,"complexityRisk":3,"priorFailureRisk":0,"providerFragilityRisk":0},"decision":"clarityScore=73, riskScore=27, confidenceScore=57, band=B","rationale":"Integration complexity, depends on 4 modules","rollback":"none"}
```
```json
{"event":"confidence-score","dish":"006","timestamp":"2026-03-24T00:13:27Z","inputs":{"specCompleteness":4,"verificationSpecificity":2,"dependencyCertainty":5,"complexityRisk":1,"priorFailureRisk":0,"providerFragilityRisk":0},"decision":"clarityScore=71, riskScore=9, confidenceScore=66, band=A","rationale":"Simple S-sized docs task","rollback":"none"}
```
