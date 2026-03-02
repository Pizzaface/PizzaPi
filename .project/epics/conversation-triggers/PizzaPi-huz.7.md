---
name: CLI conversation-triggers extension with agent tools
status: open
created: 2026-03-02T15:47:12Z
updated: 2026-03-02T15:53:44Z
beads_id: PizzaPi-huz.7
depends_on: [PizzaPi-huz.2]
parallel: true
conflicts_with: []
---

# Task: CLI conversation-triggers extension with agent tools

## Description

Create a new `conversation-triggers.ts` extension in `packages/cli/src/extensions/` that registers four agent tools: `register_trigger`, `cancel_trigger`, `list_triggers`, and `emit_event`. These tools communicate with the relay server via the existing Socket.IO connection managed by the remote extension.

Follow the exact patterns established by `session-messaging.ts` — tools use the message bus / relay socket for transport and render silently in the TUI.

## Acceptance Criteria

- [ ] New `packages/cli/src/extensions/conversation-triggers.ts` extension file
- [ ] `register_trigger` tool — accepts type, config, delivery (default: "inject"), message template, maxFirings, expiresAt; sends `register_trigger` event to relay; returns trigger ID from ack
- [ ] `cancel_trigger` tool — accepts triggerId; sends `cancel_trigger` event; returns confirmation
- [ ] `list_triggers` tool — sends `list_triggers` event; returns formatted list of active triggers
- [ ] `emit_event` tool — accepts eventName and optional payload; sends `emit_custom_event` event; returns confirmation
- [ ] Extension registered in `factories.ts` alongside existing extensions
- [ ] All tools use the `silent` render pattern (no TUI output)
- [ ] Tool descriptions are clear enough for LLMs to use correctly
- [ ] Tools handle relay disconnection gracefully (return error messages, don't throw)

## Technical Details

### Files to create/modify

- **Create**: `packages/cli/src/extensions/conversation-triggers.ts`
- **Modify**: `packages/cli/src/extensions/factories.ts` — import and add to factory list
- **Modify**: `packages/cli/src/extensions/session-message-bus.ts` — add relay socket send/receive methods for trigger events (or create a separate `trigger-bus.ts`)

### Transport pattern

Follow the same pattern as session messaging:
1. Extension tools call a bus/bridge to send events
2. The remote extension (`remote.ts`) wires up the actual Socket.IO send/receive
3. The bus provides Promise-based request/response (emit event, wait for ack with timeout)

Create a `triggerBus` singleton (similar to `messageBus`) that:
- Has a `setSendFn()` called by `remote.ts` once the relay socket is connected
- Provides `register(params) → Promise<{ triggerId }>`, `cancel(triggerId) → Promise<void>`, `list() → Promise<TriggerRecord[]>`, `emitEvent(name, payload) → Promise<void>`
- Each method emits the Socket.IO event and resolves when the server ack arrives (with a 10s timeout)

### Tool parameter schemas

```typescript
register_trigger: {
  type: { type: "string", enum: [...TriggerType values], description: "..." },
  config: { type: "object", description: "Type-specific config..." },
  delivery: { type: "object", properties: { mode: { enum: ["queue", "inject"] } }, default: { mode: "inject" } },
  message: { type: "string", description: "Template with {sessionId}, {eventName}, etc." },
  maxFirings: { type: "number", description: "..." },
  expiresAt: { type: "string", description: "ISO timestamp..." }
}

cancel_trigger: {
  triggerId: { type: "string" }
}

list_triggers: {} // no params

emit_event: {
  eventName: { type: "string" },
  payload: { type: "object", description: "Optional JSON payload" }
}
```

## Dependencies

- [ ] Task 001 (Protocol types) — `TriggerType`, `TriggerConfig`, `TriggerRecord` interfaces

## Effort Estimate

- Size: M
- Hours: 3
- Parallel: true (can develop alongside server tasks 002-005)

## Definition of Done

- [ ] Code implemented
- [ ] Extension loads without errors in CLI
- [ ] Tools appear in the agent's available tool list
- [ ] `bun run typecheck` passes
- [ ] CLI package builds successfully
