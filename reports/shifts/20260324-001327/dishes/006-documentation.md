# Dish 006: Documentation

- **Cook Type:** sonnet
- **Complexity:** S
- **Godmother ID:** uTWRUjFU
- **Dependencies:** 005
- **Files:** `packages/server/tests/harness/README.md`
- **Verification:** Review README content, `bun run typecheck`
- **Status:** queued
- **dispatchPriority:** normal

## Task Description

Write comprehensive documentation for the test harness.

### Requirements

1. **`packages/server/tests/harness/README.md`** with:
   - **Overview**: what the harness is, why it exists
   - **Prerequisites**: Redis requirement, Bun test runner
   - **Quick Start**: minimal example (create server, connect runner, send events)
   - **API Reference**: 
     - `createTestServer(opts?)` — options, return type, cleanup
     - `createMockRunner(server, opts?)` — builder pattern, methods
     - `createMockRelay(server, opts?)` — methods
     - `createMockViewer(server, sessionId)` — methods
     - `createMockHubClient(server)` — methods
     - `TestScenario` — fluent API
     - Event builders — all factory functions
   - **BDD Patterns**: how to use Given/When/Then with the scenario builder
   - **Common Recipes**:
     - Testing a new REST endpoint
     - Testing WebSocket event flow
     - Testing multi-session scenarios
     - Testing conversation replay
   - **Troubleshooting**: Redis not running, port conflicts, cleanup failures

2. **JSDoc comments** on all exported functions and interfaces (these should already be in the source files from previous dishes — verify and fill gaps).

### Verification

- README exists and is readable
- All exported symbols have JSDoc
- `bun run typecheck` still passes
