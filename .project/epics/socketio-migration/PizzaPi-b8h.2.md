---
name: Create packages/protocol with Typed Event Interfaces
status: open
created: 2026-02-22T20:50:58Z
updated: 2026-02-22T22:45:27Z
beads_id: PizzaPi-b8h.2
depends_on: [PizzaPi-b8h.1]
parallel: false
conflicts_with: []
---

# Task: Create packages/protocol with Typed Event Interfaces

## Description

Create a new `packages/protocol/` package that defines TypeScript interfaces for all Socket.IO events across all 5 namespaces. This package becomes a shared dependency for server, UI, and CLI packages, providing compile-time type safety for all WebSocket communication.

## Acceptance Criteria

- [ ] `packages/protocol/` exists with `package.json`, `tsconfig.json`, ESM output
- [ ] Exports typed event maps per namespace: `/relay`, `/viewer`, `/runner`, `/terminal`, `/hub`
- [ ] Each namespace defines `ServerToClientEvents`, `ClientToServerEvents`, `InterServerEvents`, `SocketData`
- [ ] All existing message types from `relay.ts` are covered (no missing events)
- [ ] `packages/server`, `packages/ui`, and `packages/cli` can import from `@pizzapi/protocol`
- [ ] `bun run typecheck` passes with the new package in the build graph
- [ ] Build order updated in root `package.json`: `protocol` → `tools` → `server` → `ui` → `cli`

## Technical Details

- Audit current message protocol by scanning `relay.ts` for all `type:` string literals and their payloads
- Audit `registry.ts` for `WsData`, `SharedSession`, `RunnerEntry`, and related types
- Map current `{ type: string, ...payload }` messages to Socket.IO event signatures
- Organize by namespace:
  - `/relay` — TUI session events (register, session_event, heartbeat, state, exec commands)
  - `/viewer` — Browser viewer events (session_event, state, viewer_message, exec commands)
  - `/runner` — Runner events (register, new_session, kill_session, skills, usage)
  - `/terminal` — Terminal PTY events (data, resize, spawn, kill)
  - `/hub` — Session list events (session_started, session_ended, session_updated, full list)

### Files to Create
- `packages/protocol/package.json`
- `packages/protocol/tsconfig.json`
- `packages/protocol/src/index.ts` (re-exports)
- `packages/protocol/src/relay.ts`
- `packages/protocol/src/viewer.ts`
- `packages/protocol/src/runner.ts`
- `packages/protocol/src/terminal.ts`
- `packages/protocol/src/hub.ts`
- `packages/protocol/src/shared.ts` (common types like SessionInfo, RunnerInfo)

### Files to Modify
- `package.json` (root) — add `build:protocol` script, update build order
- `tsconfig.base.json` — add protocol to project references if needed

## Dependencies

- [ ] Task 001 (spike must confirm Socket.IO works on Bun)

## Effort Estimate

- Size: S
- Hours: 4
- Parallel: false (unblocks all subsequent tasks)

## Definition of Done

- [ ] Package builds cleanly with `bun run build:protocol`
- [ ] All 5 namespace event maps fully typed
- [ ] Shared types cover session metadata, runner info, terminal info
- [ ] Integration test: import types in server/ui/cli and `tsc` passes
- [ ] No `any` types in event definitions
