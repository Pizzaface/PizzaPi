# Dish 016: Godmother Runner Service Panel Improvements

- **Cook Type:** codex
- **Complexity:** M
- **Godmother ID:** —
- **Dependencies:** none
- **Pairing:** none
- **Paired:** false
- **Service:** 5 (Godmother Service)
- **Files:** packages/cli/src/services/godmother/**, packages/ui/src/components/service-panels/**
- **Verification:** bun run typecheck, visual verification of panel
- **Status:** queued
- **Band:** B
- **dispatchPriority:** normal

## Task Description
Improve the Godmother runner service panel:
1. Audit current panel capabilities — what works, what's missing
2. Improve idea display (better formatting, status badges, topic tags)
3. Add quick actions (move status, add topics) from the panel
4. Improve search/filter UX in the panel
5. Connection efficiency: ensure it uses the service channel pattern efficiently
