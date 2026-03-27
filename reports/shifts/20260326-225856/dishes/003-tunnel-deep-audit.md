# Dish 003: Tunnel System Deep Code Audit (Research)

- **Cook Type:** codex-research
- **Complexity:** L
- **Godmother ID:** —
- **Dependencies:** none
- **Pairing:** none
- **Paired:** false
- **Service:** 2 (Tunnel Bug Research & Discovery)
- **Files:** packages/tunnel/src/** (read-only research)
- **Verification:** Godmother ideas captured, no code changes
- **Status:** plated
- **Band:** A
- **dispatchPriority:** high

## Confidence Scores
- specCompleteness: 4 (clear scope — audit tunnel package)
- verificationSpecificity: 4 (output is ideas, not code)
- dependencyCertainty: 5 (no deps)
- complexityRisk: 2 (read-only research)
- priorFailureRisk: 0 (no prior attempts)
- providerFragilityRisk: 1 (Codex reliable for analysis)
- clarityScore: 87, riskScore: 22, confidenceScore: 74 → Band A

## Task Description
Deep audit the tunnel system codebase. Focus areas:
1. Resource leaks (connections, timers, event listeners not cleaned up)
2. Race conditions (concurrent requests, reconnection during active proxying)
3. Security issues (SSRF, header injection, auth bypass)
4. Error handling gaps (missing try/catch, uncaught promise rejections)
5. Memory issues (unbounded maps/arrays, missing cleanup on disconnect)
6. Protocol edge cases (malformed messages, partial reads, encoding issues)

Output: For each bug found, capture a Godmother idea with:
- Title, type (bug), priority, detailed description, file + line numbers, proposed fix
