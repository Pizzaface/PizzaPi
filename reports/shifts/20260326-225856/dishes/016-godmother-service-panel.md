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

## Health Inspection — 13:03 UTC
- **Inspector Model:** claude-sonnet-4-6
- **Verdict:** VIOLATION
- **Findings:** P1: MCP subprocess orphaned on dispose-during-connect race; P2: list_ideas missing limit, search_ideas drops topic filter; P3: sessionId unused, topicDrafts unbounded, move_status untested, DEFAULT_PROJECT hardcoded
- **Critic Missed:** N/A (no critic ran)
- **Action:** Fixer to be dispatched
