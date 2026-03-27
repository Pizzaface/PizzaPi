# Scout Report: Server & API
**Scout:** 6fc1457f-0abe-41af-a1cd-1fdf4809938b
**Sector:** Server & API
**Completed:** 2026-03-26 03:50 UTC

## Findings (9 bugs)

| # | Severity | Title | File |
|---|----------|-------|------|
| 1 | **P0** | Chat endpoint spawns AI agent with bash/file tools — arbitrary server-side code execution | chat.ts:64 |
| 2 | **P1** | User-uploaded attachments stored in-memory only — lost on restart | attachments/store.ts:95 |
| 3 | **P1** | Terminal cwd bypasses runner workspace-roots sandbox check | runners.ts:243-261 |
| 4 | P2 | File explorer/search/read-file/git endpoints skip roots validation | runners.ts:544-679 |
| 5 | P2 | session_message silently fails in multi-node — no cross-node fallback | messaging.ts:87-95 |
| 6 | P2 | Duplicate session_messages_chunk — premature assembly on reconnect | event-pipeline.ts:139-144 |
| 7 | P2 | Attachment upload permitted to sessions with null userId | attachments.ts:91 |
| 8 | P2 | Spawn timeout records ghost session in Redis before runner confirms | runners.ts:162-167 |
| 9 | P2 | MCP OAuth nonce store cleared globally every 10min — replay window | mcp-oauth.ts:25 |

## Score
**1 P0, 2 P1, 6 P2** — strongest sector for critical findings.
