# Scout Report: Real-time & WebSocket
**Scout:** 393a33ab-541b-4eda-ba45-583bbbe62450
**Sector:** Real-time & WebSocket
**Completed:** 2026-03-26 04:00 UTC

## Findings (10 bugs)

| # | Severity | Title | File |
|---|----------|-------|------|
| 1 | **P1** | Runner injects service_message to any session — no ownership check | runner.ts:615 |
| 2 | **P1** | session_message + session_trigger fail cross-node (no relay fallback) | messaging.ts:72 |
| 3 | P2 | Pending skill/agent/file requests not rejected on disconnect (10-15s hang) | runner.ts:680 |
| 4 | P2 | useServiceChannel clears availability on reconnect — breaks panels | useServiceChannel.ts:64 |
| 5 | P2 | Two /hub socket connections per tab — 2x server load | App.tsx:2121 + SessionSidebar.tsx:606 |
| 6 | P2 | Hub reconnect re-subscribes stale meta rooms for previous user | App.tsx:2207 |
| 7 | P2 | Viewer trigger_response allows cross-session injection (same user) | viewer.ts:295 |
| 8 | P2 | session_trigger cross-node fails silently (same root cause as #2) | messaging.ts:161 |
| 9 | P2 | Stale connection watchdog timer leaks after session switch | App.tsx:2384 |
| 10 | P3 | sendSnapshotToViewer emits 2 events at same seq — resync storms | sessions.ts:549 |

## Score
**0 P0, 2 P1, 7 P2, 1 P3** — cross-node delivery is a systemic gap; service_message injection is security-relevant.

## Cross-Scout Overlap
- Bug #5 (double /hub socket) = UI Core Bug #2 — confirmed independently by two scouts
- Bug #2/#8 (cross-node messaging) = Server & API Bug #5 — same root cause, different entry point
