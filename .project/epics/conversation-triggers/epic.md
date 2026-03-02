---
name: conversation-triggers
status: backlog
created: 2026-03-02T15:43:52Z
progress: 0%
prd: .project/prds/conversation-triggers.md
beads_id: PizzaPi-huz
---

# Epic: conversation-triggers

## Overview

Add a declarative, event-driven trigger system that lets agent sessions react to lifecycle events, monitoring conditions, and custom pub/sub signals without blocking or polling. Triggers are registered via agent tools, evaluated server-side on the relay, persisted in Redis, and delivered to sessions either through the existing message queue or via a new "inject" mechanism that prepends context to the agent's next turn.

## Architecture Decisions

- **Server-side evaluation**: All trigger logic runs in the relay server — the CLI just registers/receives. This keeps agents thin and enforcement centralized.
- **Redis-backed persistence**: Triggers stored as JSON hash entries with secondary indices by runner, session, and type. Survives server restarts; cleaned up on session disconnect.
- **Reuse existing Socket.IO transport**: New events added to the `/relay` namespace protocol types rather than a new namespace. Keeps the socket count unchanged.
- **Inject via `BeforeAgentStart` hook**: The CLI already has a hooks system (`hooks.ts`) that supports `BeforeAgentStart` with `additionalContext` injection. The inject delivery mode queues trigger notifications client-side and drains them into the hook's `additionalContext` on the next turn — no pi-core changes needed.
- **Runner-locked scope enforced server-side**: The relay already tracks `runnerId` per session via the `/runner` namespace. Trigger registration validates that target session IDs share the same runner.
- **Limit to 10 tasks**: Implementation is decomposed into protocol types, server registry + evaluation, CLI extension + inject delivery, and UI panel — plus integration tests.

## Technical Approach

### Protocol Layer (`packages/protocol`)

Extend `RelayClientToServerEvents` and `RelayServerToClientEvents` in `relay.ts` with new typed events for trigger registration, cancellation, listing, custom event emission, and server-to-client notifications. Add shared type definitions for `TriggerType`, `TriggerRecord`, `TriggerNotification`, and related config interfaces in a new `triggers.ts` module re-exported from `index.ts`.

### Server: Trigger Registry & Evaluation (`packages/server`)

New `TriggerRegistry` class in `packages/server/src/ws/triggers/`:

- **`registry.ts`** — CRUD for trigger records in Redis. Keys: `triggers:{runnerId}:{triggerId}` with indices `triggers:by-runner:{runnerId}`, `triggers:by-session:{sessionId}`, `triggers:by-type:{runnerId}:{type}`.
- **`evaluator.ts`** — Event-driven evaluation. Hooks into the relay event pipeline (`session_end`, `session_error`, heartbeat for `cost_exceeded`/`session_idle`) and the new `emit_custom_event` handler. Looks up matching triggers by `(runnerId, type)`, checks conditions, fires notifications, manages `maxFirings`/expiry.
- **`timers.ts`** — `setTimeout`/`setInterval` scheduler for `timer` triggers. Rehydrated on server restart from Redis scan.

Integration points in `relay.ts`:
- New socket handlers for `register_trigger`, `cancel_trigger`, `list_triggers`, `emit_custom_event`.
- In the existing `event` handler, after `publishSessionEvent`, call evaluator for heartbeat-based triggers.
- In `session_end` / `disconnect`, call evaluator for `session_ended` triggers, then cleanup owned triggers.

### CLI: Extension & Inject Delivery (`packages/cli`)

New `conversation-triggers.ts` extension registering 4 tools:
- `register_trigger` — Sends `register_trigger` event to relay, returns trigger ID from `trigger_registered` ack.
- `cancel_trigger` — Sends `cancel_trigger`, returns confirmation.
- `list_triggers` — Sends `list_triggers`, returns list from `trigger_list` response.
- `emit_event` — Sends `emit_custom_event` to relay.

Inject delivery integration in `remote.ts`:
- Listen for `trigger_fired` events from the relay.
- For `queue` delivery: feed into `messageBus.receive()` (reuses existing message queue).
- For `inject` delivery: store in a `triggerInjectQueue` array. Before each agent turn (in the existing `BeforeAgentStart` hook path in `hooks.ts`), drain the queue and prepend formatted notifications as `additionalContext`.

### Web UI: Trigger Panel (`packages/ui`)

New `TriggerPanel.tsx` component in the session viewer:
- Fetches active triggers and firing history from the session's heartbeat or a dedicated `trigger_update` event.
- Renders a collapsible panel showing trigger type, target, delivery mode, firing count, last fired time.
- Read-only in v1 (no create/cancel from UI).
- Integrated into `SessionViewer.tsx` alongside existing panels.

### Infrastructure

No new infrastructure. Redis is already required. No new databases, queues, or external services.

## Implementation Strategy

1. **Protocol types first** — Define all shared types so server, CLI, and UI can build in parallel.
2. **Server registry + evaluation** — Core logic, Redis persistence, event pipeline hooks.
3. **CLI extension + inject delivery** — Agent tools and the inject mechanism.
4. **UI panel** — Visual feedback for trigger state.
5. **Integration tests** — Fan-out/fan-in orchestration, cross-runner isolation, server restart rehydration.

Risk mitigation:
- **Inject delivery depends on hooks system**: Already verified — `hooks.ts` supports `BeforeAgentStart` with `additionalContext`. No pi-core changes needed.
- **Redis schema additions**: Purely additive keys. No migration needed for existing data.
- **Performance**: Heartbeat-based evaluation runs at 10s intervals (existing cadence). Event-based evaluation indexed by `(runnerId, type)` for O(matching_triggers) lookup.

## Task Breakdown Preview

- [ ] Task 1: Protocol types — trigger types, events, and notification interfaces
- [ ] Task 2: Server trigger registry — Redis CRUD, indices, cleanup on disconnect
- [ ] Task 3: Server trigger evaluator — event pipeline hooks, condition matching, firing
- [ ] Task 4: Server timer triggers — setTimeout/setInterval scheduler with rehydration
- [ ] Task 5: Server relay handlers — Socket.IO event handlers for trigger registration/cancellation/listing/custom events
- [ ] Task 6: CLI conversation-triggers extension — 4 agent tools (register, cancel, list, emit)
- [ ] Task 7: CLI inject delivery — triggerInjectQueue, BeforeAgentStart hook integration, queue delivery fallback
- [ ] Task 8: Web UI trigger panel — TriggerPanel component, session viewer integration
- [ ] Task 9: Integration tests — fan-out/fan-in, cost monitoring, cross-runner isolation, server restart
- [ ] Task 10: Documentation — update CLI reference, architecture docs, add trigger guide

## Dependencies

- **`packages/protocol`** — New shared type definitions (Task 1, no blockers)
- **`packages/server`** — Redis client already initialized (`sessions/redis.ts`), relay namespace exists (`ws/namespaces/relay.ts`), runner tracking in `sio-registry.ts`
- **`packages/cli`** — Extensions system, `hooks.ts` BeforeAgentStart support, `session-message-bus.ts` for queue delivery, `remote.ts` for relay socket listener
- **`packages/ui`** — Session viewer component structure, existing panel patterns
- **pi agent core** — No changes required; `BeforeAgentStart` hook with `additionalContext` already supported

## Success Criteria (Technical)

- Fan-out/fan-in with 3+ sub-agents completes without any `wait_for_message` blocking calls — verified in integration test
- Event-based trigger evaluation (session_ended, session_error, custom_event) completes in <10ms p99
- Heartbeat-based triggers (cost_exceeded, session_idle) evaluated within one heartbeat cycle (10s)
- Triggers survive server restart — rehydrated from Redis, timer triggers rescheduled
- Zero triggers leak across runners — server-side runner-lock enforcement verified by test
- Web UI shows trigger state within 2s of change
- Agent registers + receives trigger notification in ≤3 tool calls

## Estimated Effort

- **Overall**: ~3-4 days of focused development
- **Critical path**: Protocol types → Server registry/evaluator → CLI extension → Integration tests
- **Parallelizable**: UI panel can be built alongside CLI extension once protocol types are done
- **Risk items**: Inject delivery hook integration (low risk — hooks system already supports it)

| Task | Estimate | Depends On |
|------|----------|------------|
| Protocol types | 2h | — |
| Server registry | 4h | Protocol types |
| Server evaluator | 4h | Registry |
| Server timers | 2h | Registry |
| Server relay handlers | 3h | Registry, evaluator |
| CLI extension | 3h | Protocol types |
| CLI inject delivery | 3h | CLI extension |
| UI trigger panel | 4h | Protocol types |
| Integration tests | 4h | All server + CLI tasks |
| Documentation | 2h | All implementation |

## Tasks Created
- [ ] PizzaPi-huz.10 - Integration tests for trigger system (parallel: false)
- [ ] PizzaPi-huz.11 - Documentation for conversation triggers (parallel: false)
- [ ] PizzaPi-huz.2 - Protocol types for trigger system (parallel: true)
- [ ] PizzaPi-huz.3 - Server trigger registry with Redis persistence (parallel: false)
- [ ] PizzaPi-huz.4 - Server trigger evaluator and event pipeline (parallel: false)
- [ ] PizzaPi-huz.5 - Server timer trigger scheduler (parallel: true)
- [ ] PizzaPi-huz.6 - Server relay Socket.IO handlers for triggers (parallel: false)
- [ ] PizzaPi-huz.7 - CLI conversation-triggers extension with agent tools (parallel: true)
- [ ] PizzaPi-huz.8 - CLI inject delivery and trigger_fired listener (parallel: false)
- [ ] PizzaPi-huz.9 - Web UI trigger panel in session viewer (parallel: true)

Total tasks: 10
Parallel tasks: 4
Sequential tasks: 6
Estimated total effort: 31 hours
