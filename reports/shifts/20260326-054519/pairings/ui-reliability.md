# Pairing: ui-reliability

## Story
These two dishes ship as a single PR targeting App.tsx React reliability improvements. Dish 001 eliminates concurrent-mode violations (patchSessionCache side effects inside setState updaters). Dish 002 deduplicates the /hub WebSocket connection (two connections per tab → one). Together they form a complete "UI reliability" improvement that reviewers can evaluate as a unit.

Dish 001 must plate first (it's the prelim) since both touch App.tsx — cooking them in parallel risks merge conflicts.

## Dishes
| # | Title | Role | Dependency |
|---|-------|------|------------|
| 001 | React state hygiene — patchSessionCache outside updaters | prelim | none (within pairing) |
| 002 | Hub socket deduplication | main | 001 (must plate first) |

## Combined PR Title
fix(ui): eliminate React updater side effects and deduplicate /hub WebSocket

## Status
queued

## Status History
| Time | Status | Notes |
|------|--------|-------|
| 05:52 | queued | Created in Prep |
