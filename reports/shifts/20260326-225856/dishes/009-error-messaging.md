# Dish 009: Consistent Error Messaging

- **Cook Type:** sonnet
- **Complexity:** M
- **Godmother ID:** v5v2saRu
- **Pairing:** none
- **Paired:** false
- **Service:** 3
- **Files:** packages/server/src/routes/runners.ts, packages/ui/src/components/RunnerManager.tsx
- **Verification:** bun run typecheck
- **Status:** queued
- **Band:** B

## Task Description
Create centralized error message mapping translating technical errors into user-friendly messages with actionable guidance.

## Health Inspection — 13:03 UTC
- **Inspector Model:** claude-sonnet-4-6
- **Verdict:** VIOLATION
- **Findings:** P1a: "Session not found" server message swallowed by generic fallback (UX regression); P1b: connect_error test uses fabricated string, doesn't match real socket.io format; P2: auth copy over-promises, 500 handler preempts context-specific messages; P3: console.error regression, test coverage gaps
- **Critic Missed:** N/A (no critic ran)
- **Action:** Fixer to be dispatched
