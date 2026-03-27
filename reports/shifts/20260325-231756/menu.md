# Tonight's Menu — 20260325-231756

| # | Dish | Cook Type | Complexity | Band | Pairing | Godmother ID | Status |
|---|------|-----------|------------|------|---------|--------------|--------|
| 001 | Tunnel Overhaul: merge MIME/WS branch + cache + accept-encoding + httpProxy refactor | sonnet | L | B | tunnel-overhaul (related) | Ulj4kdTT + 673xYgWN | queued |
| 002 | Stale tunnel state on reconnect | sonnet | S | A | tunnel-overhaul (related) | X85Kp2tX | queued |
| 003 | Mobile SessionViewer header overflow menu | sonnet | M | B | session-viewer-polish (prelim) | 9VOMwKS9 | queued |
| 004 | Markdown copy polish: fences + per-message copy | sonnet | M | A | session-viewer-polish (main) | — | queued |
| 005 | System prompt guidance: parent agents + session_complete | jules | S | A | solo | CTzqSajA | queued |

## Pairings
- **tunnel-overhaul**: Dishes 001 + 002 (related — independent files, same tunnel system story; combined PR)
- **session-viewer-polish**: Dishes 003 + 004 (prelim/main — 003 must plate before 004 dispatches; both touch SessionViewer.tsx)

## Tranche
- **Core**: All 5 dishes
- **Stretch**: None (scope defined; no stretch items tonight)

## Dispatch Order
1. Dispatch 001, 002, 003, 005 simultaneously (all eligible, no deps)
2. After 003 plates: dispatch 004
3. After 001+002 both ramsey-cleared: trigger pairing assembly for tunnel-overhaul
4. After 003+004 both ramsey-cleared: trigger pairing assembly for session-viewer-polish
