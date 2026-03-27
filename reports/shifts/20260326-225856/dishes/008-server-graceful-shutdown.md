# Dish 008: Server Graceful Shutdown

- **Cook Type:** sonnet
- **Complexity:** S
- **Godmother ID:** VxkPFouT
- **Pairing:** ui-stability-core
- **Paired:** true
- **Service:** 3
- **Files:** packages/server/src/index.ts
- **Verification:** bun test packages/server, bun run typecheck
- **Status:** ramsey-cleared
- **Band:** A

## Task Description
Replace process.exit(1) for all non-EPIPE uncaught exceptions with graceful shutdown: drain connections, finish in-flight requests, then exit. Log recoverable errors without killing the server.

## Health Inspection — 13:03 UTC
- **Inspector Model:** gemini-3.1-pro-preview
- **Verdict:** CITATION (joint PR #364 finding — see dish 004)
- **Findings:** P2: exit code corruption on exception during drain; no test for timeout cancellation
