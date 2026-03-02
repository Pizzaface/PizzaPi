---
name: CLI inject delivery and trigger_fired listener
status: open
created: 2026-03-02T15:47:12Z
updated: 2026-03-02T15:53:44Z
beads_id: PizzaPi-huz.8
depends_on: [PizzaPi-huz.7]
parallel: false
conflicts_with: []
---

# Task: CLI inject delivery and trigger_fired listener

## Description

Implement the client-side inject delivery mechanism: listen for `trigger_fired` events from the relay, and for `inject` mode notifications, queue them and drain into the agent's context on the next turn via the existing `BeforeAgentStart` hook system.

For `queue` mode notifications, feed them into the existing `messageBus` so they appear via `check_messages`/`wait_for_message`.

## Acceptance Criteria

- [ ] `remote.ts` listens for `trigger_fired` events from the relay socket
- [ ] `queue` delivery: notifications converted to `SessionMessage` and fed into `messageBus.receive()`
- [ ] `inject` delivery: notifications stored in a `triggerInjectQueue` (FIFO)
- [ ] `BeforeAgentStart` hook integration: before each agent turn, drain `triggerInjectQueue` and format as `additionalContext` prepended to the turn
- [ ] Inject format: `[Trigger: {triggerType}] {message}` — one line per notification, separated by newlines
- [ ] Inject queue holds notifications while agent is mid-turn; drains on next turn start
- [ ] If agent is idle (not in a turn), inject is held until next turn starts
- [ ] Queue delivery messages include `[Trigger]` prefix in the message text for clarity
- [ ] Unit tests for inject queue drain logic and message formatting

## Technical Details

### Files to create/modify

- **Create**: `packages/cli/src/extensions/trigger-inject-queue.ts` — singleton queue for inject-mode notifications
- **Modify**: `packages/cli/src/extensions/remote.ts` — add `trigger_fired` listener, dispatch to inject queue or message bus based on delivery mode
- **Modify**: `packages/cli/src/extensions/hooks.ts` — in `BeforeAgentStart` hook processing, drain the trigger inject queue and prepend as `additionalContext`
- **Create**: `packages/cli/src/extensions/trigger-inject-queue.test.ts`

### Inject queue implementation

```typescript
// trigger-inject-queue.ts
class TriggerInjectQueue {
  private queue: TriggerNotification[] = [];

  enqueue(notification: TriggerNotification): void { ... }
  drain(): TriggerNotification[] { /* returns and clears all */ }
  isEmpty(): boolean { ... }
  size(): number { ... }
}

export const triggerInjectQueue = new TriggerInjectQueue();
```

### Hook integration

In `hooks.ts`, the `BeforeAgentStart` hook already supports returning `additionalContext`. The integration point:

1. Before processing user hooks, check `triggerInjectQueue.isEmpty()`
2. If not empty, drain and format: `[Trigger: session_ended] Sub-agent child-A has finished.\n[Trigger: custom_event] Build completed.`
3. Prepend to any existing `additionalContext` from user hooks
4. Return combined context

### Remote extension integration

In the relay socket setup (after `registered` event):
```typescript
socket.on("trigger_fired", (data) => {
  if (data.delivery.mode === "inject") {
    triggerInjectQueue.enqueue(data);  // held for next turn
  } else {
    messageBus.receive({
      fromSessionId: data.sourceSessionId ?? "trigger",
      message: `[Trigger: ${data.triggerType}] ${data.message}`,
      ts: data.firedAt,
    });
  }
});
```

## Dependencies

- [ ] Task 006 (CLI extension) — trigger bus setup in remote.ts
- [ ] Task 001 (Protocol types) — `TriggerNotification` interface

## Effort Estimate

- Size: M
- Hours: 3
- Parallel: false (depends on 006)

## Definition of Done

- [ ] Code implemented
- [ ] Inject delivery works: trigger fires → notification queued → next agent turn sees it as context
- [ ] Queue delivery works: trigger fires → appears in `check_messages` output
- [ ] Unit tests written and passing
- [ ] `bun run typecheck` passes
