# Tonight's Menu — 20260326-054519

## Deferred P1-P2 Bugs from Critic's Choice (6 items, 1 already fixed)

| # | Dish | Cook Type | Complexity | Dependencies | Godmother ID | Pairing | Band | Status |
|---|------|-----------|------------|--------------|--------------|---------|------|--------|
| 001 | React state hygiene — patchSessionCache outside updaters | sonnet | M | none | MyhlJhuS | ui-reliability (prelim) | B | queued |
| 002 | Hub socket deduplication | sonnet | M | 001 (pairing-dep) | wexNsZ1X | ui-reliability (main) | B | queued |
| 003 | Cross-node messaging fallback — session_message + session_trigger | sonnet | S | none | i9uAYsf7 | — | A | queued |
| 004 | User attachment persistence — SQLite + rehydration | sonnet | M | none | cmHfFF7I | — | B | queued |
| 005 | kill_session + exit(43) race — killedSessions Set guard | sonnet | S | none | CVM8j9cS | — | A | queued |

## Reality Check Results
- AY73LYG4 (Tunnel WS orphaned connections) → ✅ Already fixed — HTTP-only tunnel, bug surface never existed. Marked shipped.
- i9uAYsf7 → Partially fixed — reduced scope (2 handlers need fallback, trigger_response already done)
- cmHfFF7I → Partially fixed — reduced scope (user uploads only, system attachments already done)

## Dispatch Order (initial batch size 2)
- Round 1: Dish 003 (Band A, high) + Dish 005 (Band A, high)
- Round 2: Dish 001 (Band B) + Dish 004 (Band B) — dispatch after Round 1 completes expo
- Round 3: Dish 002 (Band B, blocked on 001 plating)

## Pairings
| Pairing | Dishes | Combined PR Title |
|---------|--------|-------------------|
| ui-reliability | 001 (prelim) + 002 (main) | fix(ui): eliminate React updater side effects and deduplicate /hub WebSocket |
