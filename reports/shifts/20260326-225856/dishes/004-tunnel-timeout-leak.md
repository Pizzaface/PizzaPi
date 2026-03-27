# Dish 005: Tunnel Relay Timeout Resource Leak Fix

- **Cook Type:** sonnet
- **Complexity:** S
- **Godmother ID:** 1f5l22Vq
- **Dependencies:** none
- **Pairing:** ui-stability
- **Pairing Role:** related
- **Pairing Partners:** 004, 006
- **Paired:** true
- **Service:** 3 (Web UI Stability)
- **Files:** packages/tunnel/src/server.ts
- **Verification:** bun test packages/tunnel (if tests exist), bun run typecheck
- **Status:** ramsey-cleared
- **Band:** A
- **dispatchPriority:** high

## Confidence Scores
- specCompleteness: 5 (exact fix described)
- verificationSpecificity: 4 (typecheck + manual)
- dependencyCertainty: 5 (no deps)
- complexityRisk: 2 (S, but server-side)
- priorFailureRisk: 1 (tunnel system is new, no prior fixes)
- providerFragilityRisk: 1 (stable)
- clarityScore: 93, riskScore: 25, confidenceScore: 78 → Band A

## Task Description
Tunnel relay timeouts don't cancel runner-side HTTP/WS work. On timeout:
- HTTP: Send `request-end` message to runner before cleanup
- WS: Send `ws-close` message to runner with code 1001

See Godmother idea 1f5l22Vq for exact file locations and fix details.

## Health Inspection — 13:03 UTC
- **Inspector Model:** gemini-3.1-pro-preview
- **Verdict:** CITATION
- **Findings:** P2: exit code corrupted on fatal exception during SIGTERM drain window; no test for timeout cancellation lines; P3: TDZ comment incomplete, ECONNRESET swallowing
- **Critic Missed:** N/A (no critic ran)
- **Note:** All 3 fixes are logically correct. P2s are not blockers but should be addressed.
