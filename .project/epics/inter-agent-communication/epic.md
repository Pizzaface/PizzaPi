---
name: inter-agent-communication
status: backlog
created: 2026-03-05T14:58:23Z
progress: 0%
prd: .project/prds/inter-agent-communication.md
beads_id: [Will be updated when synced to Beads]
---

# Epic: Inter-Agent Communication Redesign

## Overview

Transform PizzaPi's inter-agent communication from a manual poll/block message-passing system into an event-driven collaboration framework. The core insight is that most of the plumbing already exists — `pi.sendUserMessage()` can inject messages, the relay already routes events, and heartbeats already carry session state. The redesign layers three capabilities on top of what exists:

1. **Event-driven delivery** — Messages and completion results automatically flow to parent sessions without blocking
2. **Channels & orchestration** — Multi-agent coordination via groups and convenience tools (`spawn_and_wait`, `fan_out`)
3. **Web UI visibility** — Agent topology, inter-agent message flows, and group management in the browser

The approach minimizes new infrastructure by leveraging existing relay WebSocket events, Redis session state, and the heartbeat system rather than introducing new services.

## Architecture Decisions

### AD-1: Use `pi.sendUserMessage()` for event-driven delivery
**Decision**: Inject inter-agent messages via the existing `pi.sendUserMessage()` API (already used by the remote extension for web input delivery).
**Rationale**: This is the only extension-safe way to trigger a new agent turn. The alternative — modifying pi-coding-agent core — violates our constraints. Messages are formatted with a structured `[AGENT_MESSAGE]` prefix so agents can distinguish them from human input.
**Risk mitigation**: Rate-limit injections (max 5/minute) and default worker sessions to `"queued"` delivery mode to prevent loops.

### AD-2: Server-side parent→child tracking via existing Redis session data
**Decision**: Extend `RedisSessionData` with `parentSessionId` and maintain a `children:<sessionId>` Redis set. No new database tables.
**Rationale**: The relay already stores session state in Redis. Adding a parent field to the registration flow is minimal. The spawn endpoint already creates the session ID before forwarding to the runner — it can set the parent link at that point.
**Tradeoff**: Ephemeral sessions that expire will lose their parent links, but this is acceptable since completed sessions don't need ongoing parent tracking.

### AD-3: Channels are server-side in-memory maps with Redis pub/sub for cross-server
**Decision**: Channel membership is an in-memory `Map<channelId, Set<sessionId>>` on each server instance, synchronized via Redis pub/sub for multi-server deployments.
**Rationale**: Channels are ephemeral (live only while members are connected). In-memory is fastest for single-server (the common case). Redis pub/sub provides cross-server broadcast without persisting channel state.
**Tradeoff**: Channel membership is lost on server restart. Acceptable — agents re-register on reconnect.

### AD-4: Completion hooks are opt-out (always fire by default)
**Decision**: When a session has a `parentSessionId`, completion/error notifications are automatically sent to the parent. Sessions can opt out via a `noAutoReply` spawn option.
**Rationale**: The most common failure mode today is "forgot to instruct the sub-agent to reply." Making it automatic eliminates this class of bugs. The opt-out escape hatch handles edge cases.

### AD-5: Web UI uses existing session list + heartbeat data (no new API endpoints for topology)
**Decision**: The session topology view is derived from existing data — heartbeats already carry `sessionId`, and we add `parentSessionId` + `childSessionIds` to the heartbeat/session state. The UI reconstructs the tree client-side.
**Rationale**: Avoids new REST endpoints. The hub already broadcasts `session_added`/`session_removed` events. Adding parent/child fields to these events is sufficient.

## Technical Approach

### Protocol Layer (`packages/protocol`)

Extend `RelayClientToServerEvents` and `RelayServerToClientEvents` with:

- **Client→Server**: `session_completion`, `channel_join`, `channel_leave`, `channel_message`, `session_status_query`
- **Server→Client**: `session_completion` (forwarded to parent), `session_status_response`, `channel_message` (broadcast)
- **Existing `session_message`**: Add optional `metadata` field for structured message types (backward-compatible — field is optional)

### Server Layer (`packages/server`)

**`ws/namespaces/relay.ts`** — Add handlers for:
- `session_completion` → look up parent socket, forward as `session_message` with completion metadata
- `channel_join` / `channel_leave` / `channel_message` → manage in-memory channel maps, broadcast to members
- `session_status_query` → look up session data from Redis, respond with status
- On `disconnect` → fire completion/error to parent if session had a `parentSessionId`

**`ws/sio-registry.ts`** — Extend `RedisSessionData` with:
- `parentSessionId: string | null`
- Store `children:<sessionId>` Redis set for fast child lookup
- Add `parentSessionId` to `registerTuiSession()` opts
- Include parent/child data in hub broadcasts

**`routes/runners.ts`** — Extend spawn endpoint:
- Accept `parentSessionId` in spawn request body
- Pass it through to the session registration flow
- Accept `groupId` for group-based spawning

### CLI Extension Layer (`packages/cli`)

**`extensions/remote.ts`** — Event-driven delivery:
- Store `parentSessionId` from env var `PIZZAPI_PARENT_SESSION_ID` (set by runner daemon during spawn)
- On `agent_end` → emit `session_completion` to relay with final summary + token usage
- On incoming `session_message` → if agent is idle and delivery mode is `"immediate"`, call `pi.sendUserMessage()` with formatted notification; otherwise queue
- After each `agent_end` → drain queued messages and inject them as the next user turn
- Rate-limit injections to prevent loops (max 5/minute, configurable)

**`extensions/session-message-bus.ts`** — Extend with:
- Delivery mode setting: `"immediate"` | `"queued"` | `"blocked"`
- Auto-injection callback (called by remote.ts when a message arrives for an idle session)
- Completion message queue (separate from regular messages, higher priority)

**`extensions/session-messaging.ts`** — New tools:
- `session_status` — Query session state via relay API
- `set_delivery_mode` — Configure how incoming messages are handled

**`extensions/spawn-session.ts`** — Extend `spawn_session` tool:
- Add `awaitCompletion` parameter → blocks until completion hook fires (implemented via message bus wait)
- Add `groupId` parameter → passed to spawn endpoint for group tracking
- New `fan_out` tool → spawns N sessions, waits for all completions
- New `spawn_and_wait` convenience → single spawn + await completion

### Web UI Layer (`packages/ui`)

**Session topology** (embedded in session viewer sidebar):
- Tree view showing parent→children hierarchy
- Each node: session name, model badge, status indicator (dot: green=active, gray=idle, check=completed, red=error)
- Click to navigate to that session
- Data source: existing session list + `parentSessionId` field from heartbeat

**Inter-agent message panel** (collapsible panel in session viewer):
- Chronological message log with direction arrows (↑ sent, ↓ received)
- Messages forwarded as relay events and rendered in the viewer
- Completion messages styled with a badge
- Data source: new `agent_message` event type forwarded from relay to viewers

**Group status** (badge on session card in session list):
- Shows "3/5 completed" for group coordinators
- Data source: aggregated from child session heartbeats

## Implementation Strategy

### Phase 1: Event-Driven Foundation (P0) — Tasks 1-4
Ship the core value: completion hooks + event-driven delivery. After this phase, sub-agents automatically report back and parents receive results without blocking.

### Phase 2: Coordination & Visibility (P1) — Tasks 5-8
Ship channels, orchestration tools, and web UI. After this phase, multi-agent workflows are first-class and visible in the browser.

### Simplifications applied vs. PRD:
- **No separate structured message envelope system (FR-5)** — deferred to P2. Instead, use the existing `message` string field with a JSON metadata sidecar in the protocol events. This avoids a new type system while still enabling typed completion/error payloads.
- **No Redis-backed message persistence (FR-4a)** — deferred to P2. The in-memory queue with event-driven delivery (messages injected immediately) eliminates most queuing needs. Redis persistence is only valuable for long disconnections.
- **No delivery receipts (FR-4c)** — deferred. Completion hooks provide implicit acknowledgment for the most important case.
- **No agent graph dashboard (FR-6c)** — deferred. The session topology tree covers the common hierarchical case. A full graph view is only needed for complex mesh topologies.
- **Channel implementation uses in-memory maps** — no Redis persistence for channels. They're ephemeral by nature.

## Task Breakdown Preview

- [ ] Task 1: Protocol + server — parent/child tracking and completion forwarding
- [ ] Task 2: CLI — completion hooks (auto-send result on agent_end)
- [ ] Task 3: CLI — event-driven message delivery (auto-inject via sendUserMessage)
- [ ] Task 4: CLI + server — `session_status` tool and query endpoint
- [ ] Task 5: Server — channel infrastructure (join/leave/broadcast)
- [ ] Task 6: CLI — orchestration tools (`spawn_and_wait`, `fan_out`, channel tools)
- [ ] Task 7: Web UI — session topology tree + inter-agent message panel
- [ ] Task 8: Web UI — group status badges + group management controls

## Dependencies

### External (no new dependencies)
- **Redis** — already required for server
- **Socket.IO** — already in use for relay
- **`pi.sendUserMessage()`** — existing API in `@mariozechner/pi-coding-agent`

### Internal prerequisite ordering
- Task 1 (protocol/server) must complete before Tasks 2-4
- Tasks 2-3 (CLI completion hooks + delivery) can be developed in parallel
- Task 4 (session_status) depends on Task 1 only
- Task 5 (channels) depends on Task 1
- Task 6 (orchestration tools) depends on Tasks 2, 3, and 5
- Task 7 (UI topology) depends on Task 1 (needs parent/child data in session state)
- Task 8 (UI groups) depends on Tasks 5 and 7

### Critical path
Task 1 → Task 2 → Task 3 → Task 6 (core agent-side value)
Task 1 → Task 7 (UI visibility)

## Success Criteria (Technical)

### Performance
- Completion hook fires within 500ms of `agent_end` event
- Message injection via `sendUserMessage()` adds < 50ms to turn start
- Channel broadcast to 10 members completes in < 200ms
- No measurable latency regression for single-agent sessions (no inter-agent activity)

### Quality gates
- All existing tests pass (`bun run test`) — zero regressions
- New tools have unit tests: `session_status`, `spawn_and_wait`, `fan_out`, channel tools
- Integration test: spawn → complete → parent receives result automatically
- Integration test: fan_out 3 tasks → all results collected
- Protocol types pass `bun run typecheck`
- Rate-limiting prevents infinite message injection loops

### Acceptance criteria
- A parent agent can spawn a sub-agent and receive the result **without** calling `wait_for_message` or `check_messages`
- 3 agents in a group can broadcast messages to each other via a shared channel
- Web UI shows the parent→child tree and inter-agent messages in real-time
- Existing `send_message` / `wait_for_message` / `check_messages` continue to work unchanged

## Estimated Effort

| Phase | Tasks | Estimate |
|-------|-------|----------|
| Phase 1 (P0): Event-driven foundation | 1-4 | 2 sprints |
| Phase 2 (P1): Coordination + UI | 5-8 | 2-3 sprints |
| **Total** | **8 tasks** | **4-5 sprints** |

### Critical path items
- Task 1 (protocol + server parent/child tracking) blocks everything else
- Task 3 (event-driven delivery) is the highest-value single task — unlocks the core user experience improvement
- Task 7 (UI topology) has the most unknowns — may require iteration on the tree component

## Tasks Created

- [ ] 001.md - Protocol + Server Parent/Child Tracking and Completion Forwarding (parallel: false)
- [ ] 002.md - CLI Completion Hooks — Auto-Send Result on agent_end (parallel: true)
- [ ] 003.md - CLI Event-Driven Message Delivery via sendUserMessage (parallel: true)
- [ ] 004.md - Session Status Tool and Query Endpoint (parallel: true)
- [ ] 005.md - Server Channel Infrastructure — Join/Leave/Broadcast (parallel: true)
- [ ] 006.md - CLI Orchestration Tools — spawn_and_wait, fan_out, Channel Tools (parallel: false)
- [ ] 007.md - Web UI Session Topology Tree + Inter-Agent Message Panel (parallel: true)
- [ ] 008.md - Web UI Group Status Badges + Group Management Controls (parallel: false)

Total tasks: 8
Parallel tasks: 5 (002, 003, 004, 005, 007 — all depend only on 001)
Sequential tasks: 3 (001 — foundation; 006 — depends on 002+003+005; 008 — depends on 005+007)
Estimated total effort: 98-122 hours
