---
name: Session Status Tool and Query Endpoint
status: open
created: 2026-03-05T15:02:12Z
updated: 2026-03-05T15:11:13Z
beads_id: PizzaPi-7x0.5
depends_on: [PizzaPi-7x0.2]
parallel: true
conflicts_with: []
---

# Task: Session Status Tool and Query Endpoint

## Description

Add the ability for agents to query the status of other sessions via a new `session_status` tool. This uses a relay-based query/response pattern — the CLI emits a `session_status_query` event, the server looks up the session data in Redis, and responds with the session's current state (active, idle, completed, error, model, token usage, etc.).

## Acceptance Criteria

- [ ] New `session_status` tool available to agents via the session messaging extension
- [ ] Tool accepts a `sessionId` parameter and returns structured session state
- [ ] Response includes: `sessionId`, `status` (active/idle/completed/error), `model`, `sessionName`, `parentSessionId`, `childSessionIds`, `tokenUsage`, `lastActivity`
- [ ] Query/response uses relay WebSocket events (`session_status_query` → `session_status_response`)
- [ ] Server handler in relay namespace looks up session data from Redis and responds
- [ ] Timeout handling: if no response within 5 seconds, return error state
- [ ] Tool works for any session the agent knows the ID of (no auth restrictions within same user)
- [ ] New `set_delivery_mode` tool allows agents to configure their message delivery mode
- [ ] All existing tests pass
- [ ] New unit tests for the tool, server handler, and timeout behavior

## Technical Details

### Protocol Changes (`packages/protocol/src/relay.ts`)

- Add to `RelayClientToServerEvents`:
  ```typescript
  session_status_query: (data: { requestId: string; targetSessionId: string }) => void
  ```
- Add to `RelayServerToClientEvents`:
  ```typescript
  session_status_response: (data: { requestId: string; status: SessionStatusPayload | null }) => void
  ```
- Define `SessionStatusPayload` type:
  ```typescript
  interface SessionStatusPayload {
    sessionId: string
    status: 'active' | 'idle' | 'completed' | 'error' | 'unknown'
    model?: string
    sessionName?: string
    parentSessionId?: string | null
    childSessionIds?: string[]
    lastActivity?: string
  }
  ```

### Server Changes (`packages/server/src/ws/namespaces/relay.ts`)

- Add handler for `session_status_query`:
  1. Look up `targetSessionId` in Redis session data
  2. If found, build `SessionStatusPayload` from stored data
  3. If not found, return `null`
  4. Emit `session_status_response` back to requesting socket

### CLI Changes (`packages/cli/src/extensions/session-messaging.ts`)

- Add `session_status` tool definition:
  - Parameter: `sessionId: string`
  - Implementation: emit `session_status_query` to relay, await `session_status_response` with matching `requestId`
  - Timeout after 5 seconds, return `{ status: 'unknown', error: 'timeout' }`
- Add `set_delivery_mode` tool definition:
  - Parameter: `mode: "immediate" | "queued" | "blocked"`
  - Implementation: call `messageBus.setDeliveryMode(mode)`

### Files Affected

- `packages/protocol/src/relay.ts` — new event types
- `packages/server/src/ws/namespaces/relay.ts` — query handler
- `packages/cli/src/extensions/session-messaging.ts` — new tools
- New/updated test files

## Dependencies

- [ ] Task 001 must be complete (parent/child data in Redis for child lookups)
- [ ] `set_delivery_mode` tool depends on delivery mode infrastructure from Task 003 (but the tool definition can be created first)

## Effort Estimate

- Size: S
- Hours: 6-8
- Parallel: true (independent of Tasks 002-003, only depends on 001)

## Definition of Done

- [ ] Code implemented
- [ ] Tests written and passing
- [ ] `bun run typecheck` passes
- [ ] `bun run build` succeeds
- [ ] Tool tested: agent can query status of a running/completed/unknown session
- [ ] Timeout tested: query for non-existent session returns gracefully
- [ ] Code reviewed
