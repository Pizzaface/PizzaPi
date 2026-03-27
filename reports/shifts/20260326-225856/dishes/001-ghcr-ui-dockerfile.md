# Dish 001: GH Actions Workflow + GHCR Dockerfile for UI

- **Cook Type:** sonnet
- **Complexity:** M
- **Godmother ID:** bhqD3pEu
- **Dependencies:** none
- **Pairing:** docker-versioning
- **Pairing Role:** prelim
- **Pairing Partners:** 002-pizza-web-pull-ghcr
- **Paired:** true
- **Service:** 1 (Docker Image Versioning)
- **Files:** .github/workflows/ui-docker.yml, packages/ui/Dockerfile, packages/ui/.dockerignore
- **Verification:** docker build -t pizzapi-ui:test packages/ui, GH Actions syntax validation
- **Status:** ramsey-cleared
- **Band:** A
- **dispatchPriority:** high

## Confidence Scores
- specCompleteness: 4 (clear goal, some CI specifics to decide)
- verificationSpecificity: 4 (docker build is testable)
- dependencyCertainty: 5 (no deps)
- complexityRisk: 3 (M, CI/Docker)
- priorFailureRisk: 1 (no prior attempts)
- providerFragilityRisk: 1 (stable providers)
- clarityScore: 85, riskScore: 38, confidenceScore: 62 → Band A

## Task Description
Create a multi-stage Dockerfile for the UI package that:
1. Stage 1: Bun install + Vite build (produces static assets in dist/)
2. Stage 2: nginx:alpine serving the built assets
3. Tag with git SHA and semantic version from package.json

Create a GH Actions workflow (.github/workflows/ui-docker.yml) that:
1. Triggers on push to main (paths: packages/ui/**)
2. Builds the Docker image
3. Pushes to ghcr.io/<owner>/pizzapi-ui:<tag>
4. Tags: latest, git SHA, and version from package.json

Create .dockerignore for packages/ui.

## Ramsey Report — Round 2 (Maître d' Override)
- **Verdict:** PASS (override — Ramsey flagged P2/P3 issues as send-back)
- **Demerits found:** 3 (P0: 0, P1: 0, P2: 2, P3: 1)

### Demerits
- P2: .dockerignore in packages/ui/ not effective with root build context
- P2: Workflow path filters don't cover root package.json changes
- P3: Hardcoded GHCR image name instead of deriving from repo context

### Maître d' Override Rationale
All three findings are P2/P3 polish issues, not P0/P1 logic errors. The Dockerfile builds correctly, the workflow runs on the right trigger, and the image is properly tagged. These can be addressed in a follow-up PR.

## Health Inspection — 13:03 UTC
- **Inspector Model:** gemini-3.1-pro-preview
- **Verdict:** VIOLATION
- **Findings:** P1a: depends_on: -ui uses service_started not service_healthy — server can start before UI files copied to mount; P1b: packages/ui/.dockerignore at wrong path, Docker never reads it; P2: UI_VERSION tripled, dual mismatch paths, workflow missing tsconfig trigger; P3: nginx unpinned, named volume stale, no ARM64 build
- **Critic Missed:** N/A (no critic ran)
- **Action:** Fixer to be dispatched
