# Dish 007: React State Hygiene — patchSessionCache

- **Cook Type:** sonnet
- **Complexity:** M
- **Godmother ID:** MyhlJhuS
- **Pairing:** ui-stability-p1
- **Paired:** true
- **Service:** 3
- **Files:** packages/ui/src/App.tsx
- **Verification:** bun test packages/ui, bun run typecheck
- **Status:** ramsey-cleared
- **Band:** A

## Task Description
Lift patchSessionCache calls out of setMessages functional updaters (6+ locations). React concurrent mode can invoke updaters multiple times speculatively. Also fix handleRelayEvent missing 4 deps and optimistic steer message not cached.

## Health Inspection — 13:03 UTC
- **Inspector Model:** claude-sonnet-4-6
- **Verdict:** VIOLATION (joint PR #365 finding)
- **Findings:** See dish 006 — P1 in out-of-order finalization path affects the patchSessionCache lift introduced by this dish
- **Critic Missed:** N/A (no critic ran)
