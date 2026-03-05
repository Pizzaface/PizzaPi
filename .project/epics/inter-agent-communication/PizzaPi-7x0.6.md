---
name: Server Channel Infrastructure — Join/Leave/Broadcast
status: open
created: 2026-03-05T15:02:12Z
updated: 2026-03-05T15:11:13Z
beads_id: PizzaPi-7x0.6
depends_on: [PizzaPi-7x0.2]
parallel: true
conflicts_with: []
---

# Task: Server Channel Infrastructure — Join/Leave/Broadcast

## Description

Implement server-side channel management for multi-agent coordination. Channels are named groups that sessions can join/leave to broadcast messages to all members. Per AD-3, channels use in-memory maps on each server instance with Redis pub/sub for cross-server deployments. Channels are ephemeral — membership is lost on server restart, and agents re-register on reconnect.

## Acceptance Criteria

- [ ] Protocol events added: `channel_join`, `channel_leave`, `channel_message` (client→server and server→client)
- [ ] Server maintains in-memory `Map<channelId, Set<sessionId>>` for channel membership
- [ ] `channel_join`: adds session to channel, broadcasts membership update to other members
- [ ] `channel_leave`: removes session from channel, broadcasts membership update
- [ ] `channel_message`: broadcasts message to all channel members except sender
- [ ] On session `disconnect`: automatically remove from all channels, notify remaining members
- [ ] Redis pub/sub integration: channel operations published to Redis for multi-server sync
- [ ] Channel broadcast to 10 members completes in < 200ms (performance criterion)
- [ ] No persistence — channels exist only while members are connected
- [ ] All existing tests pass
- [ ] New unit tests for join/leave/broadcast, disconnect cleanup, and Redis pub/sub

## Technical Details

### Protocol Changes (`packages/protocol/src/relay.ts`)

- Add to `RelayClientToServerEvents`:
  ```typescript
  channel_join: (data: { channelId: string }) => void
  channel_leave: (data: { channelId: string }) => void
  channel_message: (data: { channelId: string; message: string; metadata?: Record<string, unknown> }) => void
  ```
- Add to `RelayServerToClientEvents`:
  ```typescript
  channel_message: (data: { channelId: string; fromSessionId: string; message: string; metadata?: Record<string, unknown> }) => void
  channel_membership: (data: { channelId: string; members: string[]; event: 'joined' | 'left'; sessionId: string }) => void
  ```

### Server Changes

**New file: `packages/server/src/ws/channels.ts`**
- `ChannelManager` class:
  - `private channels: Map<string, Set<string>>` — channelId → set of sessionIds
  - `join(channelId, sessionId)` → add to set, publish to Redis
  - `leave(channelId, sessionId)` → remove from set, publish to Redis, delete channel if empty
  - `broadcast(channelId, fromSessionId, message, metadata)` → send to all members except sender
  - `getMembers(channelId): string[]`
  - `removeFromAll(sessionId)` → clean up on disconnect
  - `subscribe()` → listen to Redis pub/sub for cross-server channel events

**`packages/server/src/ws/namespaces/relay.ts`**
- Instantiate `ChannelManager` with Redis client
- Add handlers for `channel_join`, `channel_leave`, `channel_message`
- On `disconnect`: call `channelManager.removeFromAll(sessionId)`

### Redis Pub/Sub Pattern

- Channel: `pizzapi:channels:{channelId}`
- Messages published as JSON: `{ type: 'join'|'leave'|'message', sessionId, data }`
- Each server instance subscribes to active channels and applies operations locally

### Files Affected

- `packages/protocol/src/relay.ts` — new event types
- `packages/server/src/ws/channels.ts` — new file
- `packages/server/src/ws/namespaces/relay.ts` — channel event handlers
- New test files for `channels.ts`

## Dependencies

- [ ] Task 001 must be complete (session registration with parent/child data)
- [ ] Requires Redis client access (already available in server)
- [ ] No dependency on Tasks 002-004

## Effort Estimate

- Size: M
- Hours: 10-14
- Parallel: true (independent of Tasks 002-004)

## Definition of Done

- [ ] Code implemented
- [ ] Tests written and passing
- [ ] `bun run typecheck` passes
- [ ] `bun run build` succeeds
- [ ] Load tested: broadcast to 10 members < 200ms
- [ ] Disconnect cleanup verified: leaving session removed from all channels
- [ ] Redis pub/sub tested for cross-server broadcast
- [ ] Code reviewed
