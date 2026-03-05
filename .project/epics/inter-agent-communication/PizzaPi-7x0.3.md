---
name: CLI Completion Hooks — Auto-Send Result on agent_end
status: open
created: 2026-03-05T15:02:12Z
updated: 2026-03-05T15:11:13Z
beads_id: PizzaPi-7x0.3
depends_on: [PizzaPi-7x0.2]
parallel: true
conflicts_with: [PizzaPi-7x0.4]
---

# Task: CLI Completion Hooks — Auto-Send Result on agent_end

## Description

Implement automatic completion reporting in the CLI remote extension. When a session completes (`agent_end` event), it automatically emits a `session_completion` event to the relay server containing the final result summary and token usage. This is opt-out by default (AD-4) — sessions with a `parentSessionId` always fire completion hooks unless explicitly disabled.

## Acceptance Criteria

- [ ] `packages/cli/src/extensions/remote.ts` reads `PIZZAPI_PARENT_SESSION_ID` environment variable on startup
- [ ] On `agent_end` event: if `parentSessionId` is set, emit `session_completion` to relay with result summary and token usage
- [ ] Completion payload includes: `sessionId`, `result` (last assistant message or summary), `tokenUsage`, and optional `error` field
- [ ] On unhandled error/crash: emit `session_completion` with `error` field populated
- [ ] `noAutoReply` spawn option suppresses automatic completion (opt-out per AD-4)
- [ ] Rate-limiting: max 5 completion events per minute per session (prevent loops)
- [ ] Completion hook fires within 500ms of `agent_end` (performance criterion from epic)
- [ ] All existing tests pass
- [ ] New unit tests for completion hook emission, rate-limiting, and opt-out behavior

## Technical Details

### Remote Extension Changes (`packages/cli/src/extensions/remote.ts`)

- Read `PIZZAPI_PARENT_SESSION_ID` from `process.env` during extension initialization
- Store as module-level state: `let parentSessionId: string | null = process.env.PIZZAPI_PARENT_SESSION_ID ?? null`
- Hook into the agent lifecycle — listen for `agent_end` events on the pi instance
- On `agent_end`:
  1. Extract the last assistant message content as the result summary
  2. Collect token usage from the session
  3. Emit `session_completion` event to the relay socket:
     ```typescript
     socket.emit('session_completion', {
       sessionId: currentSessionId,
       result: lastAssistantMessage,
       tokenUsage: { promptTokens, completionTokens, totalTokens },
     })
     ```
- On error/crash: same emission but with `error` field
- Implement rate-limiter: track emission timestamps, reject if > 5 in 60 seconds

### Spawn Session Changes (`packages/cli/src/extensions/spawn-session.ts`)

- Add `noAutoReply?: boolean` to the spawn options
- If `noAutoReply` is true, set `PIZZAPI_NO_AUTO_REPLY=1` env var for spawned session
- Remote extension checks this env var and skips completion hook if set

### Files Affected

- `packages/cli/src/extensions/remote.ts` — completion hook logic
- `packages/cli/src/extensions/spawn-session.ts` — `noAutoReply` option
- New/updated test files

## Dependencies

- [ ] Task 001 must be complete (protocol types + server handler for `session_completion`)
- [ ] Requires access to `agent_end` lifecycle event from pi-coding-agent
- [ ] Requires active relay socket connection (already exists in remote.ts)

## Effort Estimate

- Size: M
- Hours: 8-12
- Parallel: true (can be developed alongside Task 003 and 004, though conflicts_with 003 on remote.ts)

## Definition of Done

- [ ] Code implemented
- [ ] Tests written and passing
- [ ] `bun run typecheck` passes
- [ ] `bun run build` succeeds
- [ ] Integration tested: spawn sub-agent → agent completes → parent receives `session_completion`
- [ ] Code reviewed
