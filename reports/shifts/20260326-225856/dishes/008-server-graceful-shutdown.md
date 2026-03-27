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
