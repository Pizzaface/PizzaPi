# Pairing: tunnel-overhaul

## Story
These two dishes ship as a single PR: Dish 001 hardens the server-side tunnel proxy (cache, accept-encoding, httpProxy refactor) built on the existing MIME/WS fix branch. Dish 002 fixes the client-side stale tunnel state. Together they complete the tunnel overhaul — any website should now tunnel smoothly with no stale UI artifacts.

## Dishes
| # | Title | Role | Dependency |
|---|-------|------|------------|
| 001 | Tunnel Overhaul: cache + encoding + httpProxy | related | none (within pairing) |
| 002 | Stale tunnel state on reconnect | related | none (within pairing) |

Both dishes are independent (different files). They cook simultaneously and assemble when both are ramsey-cleared.

## Combined PR Title
feat(tunnel): overhaul — MIME/WS rewriting, response cache, accept-encoding fix, stale state clear

## Status
served

## Critic Review
- **Round 1:** P1 api-key leak (3 locations) + P2 fragmentation + P2 parser leak → fixed
- **Round 2:** P2 orphaned WS on handshake race + P2 continuation frames (documented limitation) → accepted as demerits, no P0/P1

## PR
#338 — https://github.com/Pizzaface/PizzaPi/pull/338
