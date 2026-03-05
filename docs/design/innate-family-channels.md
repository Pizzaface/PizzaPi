# Design: Innate Family Channels

**Status:** In Progress  
**Author:** Agent session  
**Date:** 2026-03-05

## Problem

The current channel system (`channel_join`, `channel_leave`, `channel_broadcast`)
requires agents to manually coordinate channel membership — even between parent
and child sessions whose relationship is already known at spawn time. This leads
to unnecessary tool calls and brittle prompt engineering:

1. Parent calls `get_session_id`
2. Parent calls `channel_join("my-channel")`
3. Parent tells child in spawn prompt: "join channel X"
4. Child calls `channel_join("my-channel")`
5. Child calls `channel_broadcast(...)` to report status

The parent-child topology is already tracked in Redis (`parentSessionId`,
`children:{parentId}` set). Channels should leverage this.

## Design

### Core Concept: Family Channels

When a child session registers with a `parentSessionId`, the **server
automatically joins both parent and child** to a shared channel named
`family:{parentSessionId}`. No tool calls required.

**Channel naming:**
- A parent's family channel is `family:{parentSessionId}`
- All direct children of that parent share the same channel
- A mid-tree agent (both parent and child) belongs to:
  - `family:{itsParentId}` — to talk to its parent and siblings
  - `family:{itsOwnId}` — to talk to its own children (created when its first child registers)

**`emit(message)` broadcasts to ALL family channels you belong to.** This means
a mid-tree supervisor's status updates reach both upward (to its parent) and
downward (to its children).

### Agent-Facing Tool Surface

**Before (9 tools):**
- `send_message`, `wait_for_message`, `check_messages`, `get_session_id`,
  `session_status`, `set_delivery_mode`, `channel_join`, `channel_leave`,
  `channel_broadcast`

**After (7 tools):**
- `send_message` — direct point-to-point (unchanged)
- `wait_for_message` — blocking receive (unchanged, receives both direct + family)
- `check_messages` — non-blocking poll (unchanged, returns both direct + family)
- `get_session_id` — unchanged
- `session_status` — unchanged
- `set_delivery_mode` — unchanged
- **`emit`** *(new)* — broadcast to your family tree (replaces channel_join + channel_broadcast)

**Removed from agent-facing surface:**
- `channel_join` — no longer needed (auto-join)
- `channel_leave` — no longer needed (auto-leave on disconnect)
- `channel_broadcast` — replaced by `emit`

The `ChannelManager` class and channel infrastructure stay as internal
primitives. The channel_* Socket.IO events still exist for the protocol layer.

### Message Flow

```
┌──────────────────┐          ┌──────────────────┐
│   Parent Agent   │          │   Child Agent     │
│   (session: P)   │          │   (session: C)    │
│                  │          │                   │
│  auto-joined to  │          │  auto-joined to   │
│  family:P        │◄────────►│  family:P         │
└──────────────────┘          └──────────────────-┘

Child calls emit("50% done")
  → server broadcasts to family:P (excluding sender)
  → parent receives as agent message: "[Family: C] 50% done"

Parent calls emit("wrap up now")
  → server broadcasts to family:P (excluding sender)
  → child receives as agent message: "[Family: P] wrap up now"
```

Three-level tree:
```
Supervisor (S)
├── Worker A (A)  — in family:S
└── Coordinator (C) — in family:S AND family:C
    ├── Sub-worker X (X) — in family:C
    └── Sub-worker Y (Y) — in family:C

C calls emit("progress update")
  → broadcasts to family:S (S and A see it)
  → broadcasts to family:C (X and Y see it)
```

### Delivery

Family messages are delivered through the existing delivery mode system:
- **Worker sessions** (have a parent) default to `"queued"` mode — messages
  arrive after the current agent turn ends.
- **Root sessions** (no parent) default to `"blocked"` mode — messages only
  arrive via explicit `wait_for_message` / `check_messages`.
- Agents can change their mode with `set_delivery_mode`.

Family messages appear in `check_messages` / `wait_for_message` alongside
direct messages, prefixed with `[Family: {senderId}]` so agents can
distinguish them.

## Implementation Plan

### 1. Server: Auto-join on registration (`relay.ts`)

In the `register` → `registered` flow:

```typescript
// After registerTuiSession() succeeds:
if (parentSessionId) {
  const familyChannelId = `family:${parentSessionId}`;
  
  // Join the child
  channelManager.join(familyChannelId, sessionId);
  
  // Join the parent (idempotent — no-op if already joined)
  channelManager.join(familyChannelId, parentSessionId);
  
  // Notify members of the updated membership
  const members = channelManager.getMembers(familyChannelId);
  for (const memberId of members) {
    const memberSocket = getLocalTuiSocket(memberId);
    if (memberSocket) {
      memberSocket.emit("channel_membership", {
        channelId: familyChannelId,
        members,
        event: "joined",
        sessionId,
      });
    }
  }
}
```

### 2. CLI message-bus: Family channel tracking (`session-message-bus.ts`)

```typescript
// New fields
private familyChannelIds = new Set<string>();

addFamilyChannel(channelId: string): void { ... }
removeFamilyChannel(channelId: string): void { ... }
getFamilyChannels(): ReadonlySet<string> { ... }

/** Emit to all family channels. Returns number of channels emitted to. */
emitToFamily(message: string): number { ... }
```

### 3. CLI remote.ts: Wire up family channel on registration

After `registered` event:
- If `parentSessionId` exists, add `family:{parentSessionId}` as a family channel
- Listen for `channel_membership` events with `family:` prefix to auto-track

### 4. CLI session-messaging.ts: New `emit` tool

```typescript
pi.registerTool({
  name: "emit",
  description: "Broadcast a message to all sessions in your family tree...",
  parameters: {
    type: "object",
    properties: {
      message: { type: "string", description: "The message to broadcast" }
    },
    required: ["message"]
  },
  async execute(_toolCallId, rawParams) {
    const count = messageBus.emitToFamily(params.message);
    if (count === 0) return ok("No family channels to emit to (no parent or children).");
    return ok(`Message emitted to ${count} family channel(s).`);
  }
});
```

### 5. Remove agent-facing channel tools

Remove `channel_join`, `channel_leave`, `channel_broadcast` tool registrations.
Keep `ChannelManager` and socket events as internal infrastructure.

## Migration

- Existing prompts that reference `channel_join`/`channel_broadcast` will get
  tool-not-found errors. This is acceptable since channels are a new feature
  with minimal adoption.
- The `emit` tool is simpler to use, so prompt updates are straightforward.
- `ChannelManager` stays untouched — this is purely a tool-surface change.
