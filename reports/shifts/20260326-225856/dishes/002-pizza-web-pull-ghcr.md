# Dish 002: Update `pizza web` to Pull GHCR Images

- **Cook Type:** sonnet
- **Complexity:** M
- **Godmother ID:** bhqD3pEu
- **Dependencies:** 001 (pairing-dependency)
- **Pairing:** docker-versioning
- **Pairing Role:** main
- **Pairing Partners:** 001-ghcr-ui-dockerfile
- **Paired:** true
- **Service:** 1 (Docker Image Versioning)
- **Files:** packages/cli/src/commands/web.ts, docker/compose.yml
- **Verification:** bun run typecheck, pizza web --help
- **Status:** ramsey-cleared
- **Band:** B
- **dispatchPriority:** normal

## Confidence Scores
- specCompleteness: 3 (needs investigation of current pizza web)
- verificationSpecificity: 3 (typecheck + manual)
- dependencyCertainty: 4 (depends on 001's image name)
- complexityRisk: 3 (M, CLI changes)
- priorFailureRisk: 1 (no prior attempts)
- providerFragilityRisk: 1 (stable)
- clarityScore: 67, riskScore: 38, confidenceScore: 44 → Band B

## Task Description
Update the `pizza web` command and docker/compose.yml to:
1. Pull the UI image from GHCR instead of building locally
2. Add a --tag flag to specify which UI image tag to use (default: latest)
3. Keep the ability to build locally via --build flag as fallback
4. Update compose.yml to reference the GHCR image

## Health Inspection — 13:03 UTC
- **Inspector Model:** gemini-3.1-pro-preview
- **Verdict:** VIOLATION (joint PR #366 finding — see dish 001)
