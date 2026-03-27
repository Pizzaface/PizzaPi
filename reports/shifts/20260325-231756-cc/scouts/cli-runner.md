# Scout Report: CLI & Runner
**Scout:** 9c63d760-c01c-48f6-aa4a-03e45d8ba7c8
**Sector:** CLI & Runner
**Completed:** 2026-03-26 03:58 UTC

## Findings (11 bugs)

| # | Severity | Title | File |
|---|----------|-------|------|
| 1 | **P1** | Socket event listeners stack on every reconnect — N+1 duplicate handlers | terminal/file-explorer/git/tunnel-service |
| 2 | **P1** | Panel tunnel ports cleared on reconnect — 404 for panel HTTP after reconnect | daemon.ts:373 + tunnel-service.ts:78 |
| 3 | **P1** | tunnel_request forwarded N+1 times after N reconnects | tunnel-service.ts:87 |
| 4 | P2 | kill_session + exit(43) race — killed session re-spawns | daemon.ts:505 + session-spawner.ts:155 |
| 5 | P2 | runner_registered async handler has no try/catch — service init errors swallowed | daemon.ts:362 |
| 6 | P2 | search_files silently returns empty for git timeouts/ENOENT | file-explorer-service.ts:125 |
| 7 | P2 | PIZZAPI_RUNNER_TOKEN-only config: passes startup but relay rejects (token unused) | daemon.ts:157-168 |
| 8 | P2 | Worker exit 43 before IPC pre_restart — race drops attachment cleanup | session-spawner.ts:128-164 |
| 9 | P2 | isCwdAllowed checks undefined requestedCwd instead of effectiveCwd | session-spawner.ts:68-73 |
| 10 | P3 | Supervisor writes PID only when state file exists — orphaned on fresh install | supervisor.ts:61-70 |
| 11 | P3 | Usage cache writeFileSync not atomic — concurrent restarts corrupt cache | runner-usage-cache.ts:233 |

## Score
**0 P0, 3 P1, 6 P2, 2 P3** — reconnection bugs are systemic and high-impact.
