---
name: Protocol types for trigger system
status: open
created: 2026-03-02T15:47:12Z
updated: 2026-03-02T15:53:44Z
beads_id: PizzaPi-huz.2
depends_on: []
parallel: true
conflicts_with: []
---

# Task: Protocol types for trigger system

## Description

Define all shared TypeScript types and Socket.IO event interfaces for the conversation triggers system. This is the foundational task — all other tasks depend on these type definitions.

Create a new `triggers.ts` module in `packages/protocol/src/` with trigger types, notification interfaces, and config types. Extend the existing `RelayClientToServerEvents` and `RelayServerToClientEvents` in `relay.ts` with new trigger-related events. Re-export everything from `index.ts`.

## Acceptance Criteria

- [ ] New `packages/protocol/src/triggers.ts` module with all shared trigger types
- [ ] `TriggerType` union type: `"session_ended" | "session_idle" | "session_error" | "cost_exceeded" | "custom_event" | "timer"`
- [ ] `TriggerRecord` interface with: id, type, ownerId (sessionId), runnerId, config, delivery, message template, maxFirings, firingCount, expiresAt, createdAt, lastFiredAt
- [ ] `TriggerNotification` interface with: triggerId, triggerType, message, sourceSessionId, payload, firedAt
- [ ] Config interfaces per trigger type: `SessionTriggerConfig`, `CostTriggerConfig`, `CustomEventTriggerConfig`, `TimerTriggerConfig`
- [ ] `TriggerDelivery` type: `{ mode: "queue" | "inject" }`
- [ ] `RelayClientToServerEvents` extended with: `register_trigger`, `cancel_trigger`, `list_triggers`, `emit_custom_event`
- [ ] `RelayServerToClientEvents` extended with: `trigger_registered`, `trigger_cancelled`, `trigger_list`, `trigger_fired`, `trigger_error`
- [ ] All new types re-exported from `packages/protocol/src/index.ts`
- [ ] `bun run typecheck` passes for all packages

## Technical Details

### Files to create/modify

- **Create**: `packages/protocol/src/triggers.ts`
- **Modify**: `packages/protocol/src/relay.ts` — add new events to both client-to-server and server-to-client interfaces
- **Modify**: `packages/protocol/src/index.ts` — re-export trigger types

### Type definitions

```typescript
// triggers.ts
export type TriggerType = "session_ended" | "session_idle" | "session_error" | "cost_exceeded" | "custom_event" | "timer";

export interface SessionTriggerConfig {
  sessionIds: string[] | "*";
}

export interface CostTriggerConfig {
  sessionIds: string[] | "*";
  threshold: number;
}

export interface CustomEventTriggerConfig {
  eventName: string;
  fromSessionIds: string[] | "*";
}

export interface TimerTriggerConfig {
  delaySec: number;
  recurring?: boolean;
}

export type TriggerConfig = SessionTriggerConfig | CostTriggerConfig | CustomEventTriggerConfig | TimerTriggerConfig;

export interface TriggerDelivery {
  mode: "queue" | "inject";
}

export interface TriggerRecord {
  id: string;
  type: TriggerType;
  ownerSessionId: string;
  runnerId: string;
  config: TriggerConfig;
  delivery: TriggerDelivery;
  message: string;
  maxFirings?: number;
  firingCount: number;
  expiresAt?: string;
  createdAt: string;
  lastFiredAt?: string;
}

export interface TriggerNotification {
  triggerId: string;
  triggerType: TriggerType;
  message: string;
  sourceSessionId?: string;
  payload?: unknown;
  firedAt: string;
}
```

### Socket.IO events to add to relay.ts

Client → Server:
- `register_trigger(data: { token: string; type: TriggerType; config: TriggerConfig; delivery?: TriggerDelivery; message?: string; maxFirings?: number; expiresAt?: string })`
- `cancel_trigger(data: { token: string; triggerId: string })`
- `list_triggers(data: { token: string })`
- `emit_custom_event(data: { token: string; eventName: string; payload?: unknown })`

Server → Client:
- `trigger_registered(data: { triggerId: string; type: TriggerType })`
- `trigger_cancelled(data: { triggerId: string })`
- `trigger_list(data: { triggers: TriggerRecord[] })`
- `trigger_fired(data: TriggerNotification & { delivery: TriggerDelivery })`
- `trigger_error(data: { message: string; triggerId?: string })`

## Dependencies

- [ ] None — this is the foundation task

## Effort Estimate

- Size: S
- Hours: 2
- Parallel: true (no dependencies)

## Definition of Done

- [ ] Code implemented
- [ ] `bun run typecheck` passes
- [ ] Types are importable from `@pizzapi/protocol`
- [ ] Protocol package builds successfully
