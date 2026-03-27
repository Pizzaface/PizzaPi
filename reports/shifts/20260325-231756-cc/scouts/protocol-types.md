# Scout Report: Protocol & Types
**Scout:** dabb5e66-d97e-40a4-8226-5b5820757e09
**Sector:** Protocol & Types
**Completed:** 2026-03-26 04:08 UTC

## Findings (10 bugs)

| # | Severity | Title | File |
|---|----------|-------|------|
| 1 | **P1** | Unanchored `" asks:"` pattern misclassifies session_complete as ask_user_question | trigger-parsers.ts:30 |
| 2 | **P1** | Unanchored `"submitted a plan for review"` misclassifies session_complete as plan_review | trigger-parsers.ts:33 |
| 3 | P2 | Multi-question answer parser fallback discards all answers except first | ask-user-answer-parser.ts:84 |
| 4 | P2 | Empty-string trigger response silently dropped — no ack, no error | viewer.ts:424 |
| 5 | P2 | session_added stores isEphemeral: undefined — missing nullish fallback | SessionSidebar.tsx:665 |
| 6 | P2 | HubSession marks required SessionInfo fields optional — type guard too weak | hub-sessions.ts + SessionSidebar.tsx:23 |
| 7 | P2 | session_status can't clear runnerId to null — stale data after disconnect | hub.ts:33 |
| 8 | P2 | ProviderUsageData.windows accessed without null-guard after unsafe cast | meta-state-apply.ts:89 |
| 9 | P3 | MetaStatePatch missing mcp_startup_report — latent silent drop risk | meta-state-apply.ts:97 |
| 10 | P3 | parseAnswerResult multi-question JSON key order not guaranteed | ask-user-answer-parser.ts:73 |

## Score
**0 P0, 2 P1, 6 P2, 2 P3** — trigger parser bugs are high-impact, directly affecting Night Shift operations.
