---
name: CLI Orchestration Tools — spawn_and_wait, fan_out, Channel Tools
status: open
created: 2026-03-05T15:02:12Z
updated: 2026-03-05T15:11:13Z
beads_id: PizzaPi-7x0.7
depends_on: [PizzaPi-7x0.3, PizzaPi-7x0.4, PizzaPi-7x0.6]
parallel: false
conflicts_with: []
---

# Task: CLI Orchestration Tools — spawn_and_wait, fan_out, Channel Tools

## Description

Add high-level orchestration tools that make multi-agent workflows easy to express. `spawn_and_wait` spawns a single sub-agent and blocks until its completion hook fires (no manual polling). `fan_out` spawns N sub-agents and collects all results. Channel tools (`channel_join`, `channel_leave`, `channel_broadcast`) let agents coordinate via named groups. These tools build on the completion hooks (Task 002), event-driven delivery (Task 003), and channel infrastructure (Task 005).

## Acceptance Criteria

- [ ] `spawn_and_wait` tool: spawns a session and blocks until `session_completion` event is received for that session
- [ ] `spawn_and_wait` returns: `{ sessionId, result, tokenUsage, error? }`
- [ ] `spawn_and_wait` accepts same parameters as `spawn_session` plus `timeout` (default: 600 seconds)
- [ ] `spawn_and_wait` times out gracefully with error message, does not leave orphaned sessions
- [ ] `fan_out` tool: spawns N sessions with individual prompts, waits for all completions
- [ ] `fan_out` returns: array of `{ sessionId, result, tokenUsage, error? }` (ordered by completion)
- [ ] `fan_out` supports partial failure: returns completed results + errors for failed sessions
- [ ] `fan_out` accepts `maxConcurrent` parameter (default: 5, per epic guidance)
- [ ] `channel_join` tool: joins the current session to a named channel
- [ ] `channel_leave` tool: leaves a channel
- [ ] `channel_broadcast` tool: sends a message to all members of a channel
- [ ] All tools have proper TypeScript types and parameter validation
- [ ] All existing tests pass
- [ ] New unit tests for each tool, including timeout and partial failure scenarios

## Technical Details

### Spawn Session Extension Changes (`packages/cli/src/extensions/spawn-session.ts`)

**`spawn_and_wait` tool:**
```typescript
{
  name: 'spawn_and_wait',
  description: 'Spawn a sub-agent and wait for its completion result',
  parameters: {
    prompt: string,       // Initial instructions for the sub-agent
    model?: { provider: string, id: string },
    cwd?: string,
    timeout?: number,     // Seconds to wait (default: 600)
  }
}
```
- Implementation:
  1. Call existing `spawn_session` internally
  2. Register a one-time listener for `session_completion` from the spawned `sessionId`
  3. Return when completion received or timeout expires
  4. On timeout: return `{ sessionId, error: 'Timed out after Ns' }`

**`fan_out` tool:**
```typescript
{
  name: 'fan_out',
  description: 'Spawn multiple sub-agents and wait for all to complete',
  parameters: {
    tasks: Array<{ prompt: string, model?: object, cwd?: string }>,
    maxConcurrent?: number,  // Default: 5
    timeout?: number,        // Per-task timeout, default: 600
  }
}
```
- Implementation:
  1. Spawn up to `maxConcurrent` sessions
  2. As each completes, spawn next in queue (if any)
  3. Collect all results into array
  4. Return when all complete or timed out

### Session Messaging Extension Changes (`packages/cli/src/extensions/session-messaging.ts`)

**`channel_join` tool:**
- Emits `channel_join` event to relay
- Stores joined channels locally for cleanup

**`channel_leave` tool:**
- Emits `channel_leave` event to relay
- Removes from local channel list

**`channel_broadcast` tool:**
- Emits `channel_message` event to relay
- Parameter: `{ channelId: string, message: string }`

**Incoming `channel_message` handling:**
- On `channel_message` from relay: format and inject via message bus (same delivery mode logic as Task 003)

### Files Affected

- `packages/cli/src/extensions/spawn-session.ts` — `spawn_and_wait`, `fan_out`
- `packages/cli/src/extensions/session-messaging.ts` — channel tools
- `packages/cli/src/extensions/session-message-bus.ts` — channel message queuing
- New/updated test files

## Dependencies

- [ ] Task 002 (completion hooks) — `spawn_and_wait` relies on completion events being emitted
- [ ] Task 003 (event-driven delivery) — channel messages and completion results need injection
- [ ] Task 005 (channel infrastructure) — server-side channel support needed for channel tools

## Effort Estimate

- Size: L
- Hours: 16-20
- Parallel: false (depends on three prior tasks)

## Definition of Done

- [ ] Code implemented
- [ ] Tests written and passing
- [ ] `bun run typecheck` passes
- [ ] `bun run build` succeeds
- [ ] Integration tested: `spawn_and_wait` completes round-trip
- [ ] Integration tested: `fan_out` with 3 tasks, all results collected
- [ ] Integration tested: 3 agents in a channel can broadcast to each other
- [ ] Timeout behavior tested for both tools
- [ ] Code reviewed
