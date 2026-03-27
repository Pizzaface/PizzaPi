# Incidents — 20260325-231756

## Critic Finding — PR #338 tunnel-overhaul — 04:17 UTC
- **PR:** #338
- **Critic:** gpt-5.3-codex (d5901827)
- **Issues:**
  - P1: x-api-key credential leakage to tunneled localhost services (WS + HTTP paths)
  - P2: Fragmented WS frames not reassembled (documented as limitation)
  - P2: frameParsers state not cleaned up on runner disconnect
- **Action:** Fixer dispatched (6d0c8a6c)

## Ramsey Demerit — Dish 001 Round 1 — 03:46 UTC
- P1: WS forwardHeaders dropped (browser-compat constructor)
- Fixed in round 2

## Ramsey Demerits — Dish 002 — 03:49 UTC
- P2: JSDoc placement on const vs interface
- P3 × 2: rapid toggle test, iframeLoading reset

## Ramsey Demerits — Dish 003 — 03:54 UTC
- P2: Timer cleanup missing in HeaderOverflowMenu
- P3 × 3: dead hasItems guard, duplicate icon, separator edge case

## Ramsey Demerits — Dish 004 — 04:15 UTC
- P3 × 2: backtick-in-code edge case, trailing newline on empty
