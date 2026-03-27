# Tonight's Menu — Night Shift 20260326-225856

**Theme:** Stability, Infrastructure & Connection Efficiency

## Dishes (17 total)

| # | Dish | Service | Cook | Cplx | Band | Status |
|---|------|---------|------|------|------|--------|
| 001 | GH Actions + GHCR Dockerfile for UI | Docker | codex | M | A | queued |
| 002 | Update `pizza web` to pull GHCR images | Docker | codex | M | B | queued |
| 003 | Tunnel system deep code audit (research) | Tunnel | codex | L | A | queued |
| 004 | Tunnel relay timeout resource leak fix | Stability | sonnet | S | A | queued |
| 005 | Service panel auto-focus bug fix | Stability | sonnet | S | A | queued |
| 006 | Chunk retransmit idempotency fix (P1) | Stability | codex | M | A | queued |
| 007 | React state hygiene — patchSessionCache (P1) | Stability | codex | M | A | queued |
| 008 | Server graceful shutdown | Stability | sonnet | S | A | queued |
| 009 | Consistent error messaging across UI | Stability | codex | M | B | queued |
| 010 | clearSelection state management refactor | Stability | sonnet | M | B | queued |
| 011 | Investigate & fix 2-min UI load time | Stability | codex | M | A | queued |
| 012 | Panel Position Grid System (9-zone) | Panel | codex | L | B | queued |
| 013 | Godmother backlog triage & cleanup | Sidework | haiku | M | — | queued |
| 014 | Fix double /hub WebSocket connection (P1) | Connections | sonnet | S | A | queued |
| 015 | Frontend-backend connection audit | Connections | codex | M | A | queued |
| 016 | Godmother service panel improvements | Godmother | codex | M | B | queued |
| 017 | Upgrade safety — version checks & migrations | Docker | codex | M | B | queued |

## Cook Distribution
- **Codex 5.3:** 001,002,003,006,007,009,011,012,015,016,017 (11 dishes)
- **Sonnet 4.6:** 004,005,008,010,014 (5 dishes)
- **Haiku swarm:** 013

## Pairings
- **docker-versioning:** 001(prelim) → 002 + 017(related)
- **ui-stability-core:** 004 + 005 + 008
- **ui-stability-p1:** 006 + 007
- **connection-efficiency:** 014 + 015

## Critics' Choice Competition: ACTIVE

## Core Tranche: 001,003,004,005,006,007,008,011,013,014,015
## Stretch Tranche: 002,009,010,012,016,017
