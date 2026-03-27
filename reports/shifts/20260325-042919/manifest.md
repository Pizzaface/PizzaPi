# Shift Manifest — 20260325-042919

## Sessions
| sessionId | role | dish | model | provider | status | time |
|-----------|------|------|-------|----------|--------|------|
| 78b8cfa0-230a-4c28-b5db-a1041e112ea4 | cook | 001 | claude-sonnet-4-6 | anthropic | cooking | 04:48 |
| 66ff0fd3-a37e-45a7-8f66-64ab51ba2d7c | cook | 002 | claude-sonnet-4-6 | anthropic | cooking | 04:48 |
| 641e937e-6132-4cad-88a6-eb963c9d1313 | cook | 004 | claude-sonnet-4-6 | anthropic | cooking | 04:48 |
| 3884e304-8fc1-4772-a88f-25cf0d79c3d3 | critic | 002 | gpt-5.3-codex | openai-codex | served-LGTM | 05:35 |
| 0dbb4be2-a907-420d-85de-d2e2527de513 | cook | 003 | claude-sonnet-4-6 | anthropic | cooking | 05:35 |
| 841f9bc8-662a-428e-b82a-3e8f0a722b48 | critic | 001 | gpt-5.3-codex | openai-codex | served-LGTM | 06:15 |
| 0bfa3ac9-5175-41d5-961f-398849a9fa27 | critic | 004 | gpt-5.3-codex | openai-codex | served-LGTM | 07:48 |
| 9b0fe4d0-b368-463b-a78c-901e69df22af | critic | 003 | gpt-5.3-codex | openai-codex | served-LGTM | 08:30 |

## Confidence Decisions

```json
{"event":"confidence-score","dish":"001","timestamp":"2026-03-25T04:40:00Z","inputs":{"specCompleteness":5,"verificationSpecificity":4,"dependencyCertainty":5,"complexityRisk":1,"priorFailureRisk":0,"providerFragilityRisk":0},"decision":"clarityScore=86, riskScore=18, confidenceScore=75, band=A","rationale":"Single-line fix, exact location known, no prior failures","rollback":"none"}
```

```json
{"event":"confidence-score","dish":"002","timestamp":"2026-03-25T04:40:00Z","inputs":{"specCompleteness":5,"verificationSpecificity":5,"dependencyCertainty":5,"complexityRisk":1,"priorFailureRisk":0,"providerFragilityRisk":0},"decision":"clarityScore=92, riskScore=14, confidenceScore=83, band=A","rationale":"Remove one line, already have a better assertion below it","rollback":"none"}
```

```json
{"event":"confidence-score","dish":"003","timestamp":"2026-03-25T04:40:00Z","inputs":{"specCompleteness":3,"verificationSpecificity":4,"dependencyCertainty":4,"complexityRisk":2,"priorFailureRisk":1,"providerFragilityRisk":0},"decision":"clarityScore=72, riskScore=36, confidenceScore=50, band=B","rationale":"Type inference from better-auth requires investigation; correct fix approach TBD by cook","rollback":"If cook cannot find proper better-auth type, they should document why and leave a TODO with a type alias rather than removing the cast entirely"}
```

```json
{"event":"confidence-score","dish":"004","timestamp":"2026-03-25T04:40:00Z","inputs":{"specCompleteness":5,"verificationSpecificity":5,"dependencyCertainty":5,"complexityRisk":0,"priorFailureRisk":0,"providerFragilityRisk":0},"decision":"clarityScore=94, riskScore=10, confidenceScore=88, band=A","rationale":"Pure text/comment changes, exact stale strings identified","rollback":"none"}
```

```json
{"event":"unattended-handoff","timestamp":"2026-03-25T04:40:00Z","inputs":{"dishes":4,"bandA":3,"bandB":1,"mode":"unattended"},"decision":"Unattended mode — skipping plan_mode. Proceeding directly to Kitchen with 4 dishes.","rationale":"--unattended flag set by user","rollback":"none"}
```
