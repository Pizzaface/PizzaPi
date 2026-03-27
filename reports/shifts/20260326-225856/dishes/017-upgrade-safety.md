# Dish 017: Upgrade Safety — Version Checks & Migration Guards

- **Cook Type:** codex
- **Complexity:** M
- **Godmother ID:** —
- **Dependencies:** none
- **Pairing:** docker-versioning
- **Pairing Role:** related
- **Paired:** true
- **Service:** 1 (Docker Versioning / Upgrade Safety)
- **Files:** packages/server/src/**, packages/cli/src/**, packages/ui/src/**
- **Verification:** bun run typecheck, bun test
- **Status:** queued
- **Band:** B
- **dispatchPriority:** normal

## Task Description
Make it safer to upgrade users to latest frontend/server code:
1. Add version negotiation: server reports its version, UI checks compatibility on connect
2. Show "update available" banner when server version > UI version
3. Add DB migration version check on server start — refuse to start if migrations are pending
4. Add protocol version to WebSocket handshake — graceful degradation for version mismatches
5. Ensure `pizza web` upgrade path is smooth: pull new image, run migrations, restart

## Health Inspection — 13:03 UTC
- **Inspector Model:** gemini-3.1-pro-preview
- **Verdict:** VIOLATION (joint PR #366 finding — see dish 001)
