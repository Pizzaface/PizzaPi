# Dish 006: Service Panel Auto-Focus Bug Fix

- **Cook Type:** sonnet
- **Complexity:** S
- **Godmother ID:** JX5XfOLM
- **Dependencies:** none
- **Pairing:** ui-stability
- **Pairing Role:** related
- **Pairing Partners:** 004, 005
- **Paired:** true
- **Service:** 3 (Web UI Stability)
- **Files:** packages/ui/src/components/service-panels/ServicePanels.tsx, packages/ui/src/hooks/usePanelLayout.ts
- **Verification:** bun test packages/ui, bun run typecheck
- **Status:** ramsey-cleared
- **Band:** A
- **dispatchPriority:** high

## Confidence Scores
- specCompleteness: 3 (bug described but no fix specified)
- verificationSpecificity: 4 (test + typecheck)
- dependencyCertainty: 5 (no deps)
- complexityRisk: 2 (S, UI logic)
- priorFailureRisk: 0 (no prior)
- providerFragilityRisk: 1 (stable)
- clarityScore: 80, riskScore: 20, confidenceScore: 68 → Band A

## Task Description
Adding or moving a service panel automatically focuses the Tunnels Panel instead of the newly added/moved panel. The panel that was just added or repositioned should receive focus.

## Health Inspection — 13:03 UTC
- **Inspector Model:** gemini-3.1-pro-preview
- **Verdict:** CITATION (joint PR #364 finding)
- **Findings:** Panel focus fix is correct. P2s from graceful shutdown (dish 008) apply at PR level.
