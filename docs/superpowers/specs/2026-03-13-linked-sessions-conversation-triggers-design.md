# Linked Sessions & Conversation Triggers

**Date:** 2026-03-13  
**Status:** Draft  
**Scope:** Runner daemon, relay server, CLI extensions, web UI, docs

---

## Problem

Today, spawned sessions are completely independent — there's no parent-child relationship tracked anywhere. Agent-to-agent communication requires manual plumbing: the parent must call `get_session_id`, embed its ID in the spawn prompt, and block on `wait_for_message`. The child must call `send_message` with the parent's ID. This is mechanical, error-prone, and creates a fundamentally different interaction model than the one humans use (Follow-Up / Steer).

Interactive tools like `AskUserQuestion` and `plan_mode` are dead ends in spawned sessions — there's no human watching, and no mechanism to route those interactions back to the parent agent.

## Solution

### 1. Automatic Parent-Child Linking

Every `spawn_session` call automatically records the spawning session as the child's parent. No opt-in, no extra parameters.

### 2. Conversation Trigger System

A generic, extensible event system where child sessions can fire typed "triggers" that inject structured messages into the parent's conversation. The parent responds naturally — its response routes back to the child. This replaces the raw `send_message`/`wait_for_message` messaging tools.

### 3. Steer-by-Default Parent Interaction

The parent interacts with children using the same Follow-Up/Steer model that humans use in the web UI. Steer (immediate interrupt) is the default. An explicit `follow_up` delivery mode is available via the `tell_child` tool.

---

## Architecture: Hybrid Routing

**Same-runner fast path (99% case):** Child worker → Runner daemon → Parent worker. The daemon intercepts child triggers and delivers them directly to the parent's pi instance via the relay socket's `input` event mechanism. No network hop.

**Cross-runner fallback:** Child → Runner → Relay server → Parent's Runner → Parent worker. The relay server detects the `parentSessionId` in Redis and routes the trigger to the correct runner.

**UI visualization:** Redis stores `parentSessionId` so the web UI can render session trees without any runtime routing involvement.

---

## Data Model

### Redis (Server)

Add to `RedisSessionData`:

```typescript
interface RedisSessionData {
  // ... existing fields ...
  parentSessionId: string | null;
}
```

Add a new Redis set for efficient child lookup:

```
pizzapi:sio:children:{parentSessionId} → SET of child session IDs
```

### Runner (Daemon)

Extend `RunnerSession`:

```typescript
interface RunnerSession {
  sessionId: string;
  child: ChildProcess | null;
  startedAt: number;
  adopted?: boolean;
  parentSessionId?: string;  // NEW
}
```

The daemon maintains an in-memory `pendingTriggers` map:

```typescript
Map<triggerId, {
  sourceSessionId: string;
  targetSessionId: string;
  type: string;
  deliveredAt: number;
}>
```

### Spawn Flow Changes

1. `spawn_session` tool automatically includes `parentSessionId` (from the calling session's own ID) in the HTTP POST to `/api/runners/spawn`.
2. Server records `parentSessionId` in Redis alongside the child session, adds to `children:{parentId}` set.
3. Server forwards `parentSessionId` in the `new_session` WebSocket event to the runner.
4. Runner stores it in `RunnerSession` and passes it to the child worker via env var `PIZZAPI_WORKER_PARENT_SESSION_ID`.
5. The child's remote extension reads this env var and stores it for trigger routing.

---

## Conversation Trigger System

### Core Interface

```typescript
interface ConversationTrigger {
  /** Unique trigger type identifier */
  type: string;
  /** Source session that fired this trigger */
  sourceSessionId: string;
  /** Source session name (human-readable, for display) */
  sourceSessionName?: string;
  /** Target session ID (defaults to parent) */
  targetSessionId: string;
  /** Structured payload — shape depends on trigger type */
  payload: Record<string, unknown>;
  /** How to deliver to the target session */
  deliverAs: "steer" | "followUp";
  /** Whether the source blocks waiting for a response */
  expectsResponse: boolean;
  /** Unique correlation ID for routing responses back */
  triggerId: string;
  /** ISO timestamp */
  ts: string;
}
```

### Trigger Renderer

Each trigger type registers a renderer that converts the structured payload into text for injection, and optionally parses the response:

```typescript
interface TriggerRenderer {
  type: string;
  /** Convert trigger payload to agent/human-readable message text */
  render(trigger: ConversationTrigger): string;
  /** Convert a response back to the format the source expects */
  parseResponse?(responseText: string, trigger: ConversationTrigger): unknown;
}
```

### Trigger Registry

A `TriggerRegistry` maintains known trigger types and their renderers. Located at the runner daemon level (for local routing) and optionally at the server level (for cross-runner).

Extensions can register custom triggers:

```typescript
pi.registerTrigger({
  type: "budget_threshold",
  render(trigger) {
    const { spent, limit } = trigger.payload as { spent: number; limit: number };
    return `⚠️ Child "${trigger.sourceSessionName}" hit budget threshold: $${spent} of $${limit}. Continue? (yes/no)`;
  },
  parseResponse(text) {
    return text.toLowerCase().includes("yes") || text.toLowerCase().includes("continue");
  },
});
```

### Built-in Trigger Types

| Type | Payload | Expects Response | Default Delivery | Description |
|------|---------|:---:|:---:|-------------|
| `ask_user_question` | `{ question: string, options: string[] }` | ✅ | followUp | Child is asking a multiple-choice question |
| `plan_review` | `{ title: string, steps: object[], description?: string }` | ✅ | followUp | Child submitted a plan for approval |
| `turn_complete` | `{ summary: string }` | ❌ | followUp | Child finished a turn, informational |
| `session_complete` | `{ summary: string, exitCode: number }` | ✅ | followUp | Child finished all work, needs ack |
| `session_error` | `{ error: string, context?: string }` | ❌ | steer | Child errored out |
| `escalate` | `{ reason: string, originalTrigger: ConversationTrigger }` | ✅ | steer | Parent escalates a child's question to the human |

### Routing Flow

**Firing a trigger (child side):**

1. Child session detects an interactive event (AskUserQuestion called, plan submitted, work complete)
2. Child's trigger extension constructs a `ConversationTrigger` with `targetSessionId` defaulting to `parentSessionId`
3. Trigger is emitted via the relay WebSocket as a `session_trigger` event

**Delivering a trigger (daemon/server side):**

1. Runner daemon receives `session_trigger` from child
2. Looks up trigger renderer for `trigger.type`
3. Calls `renderer.render(trigger)` to produce message text
4. Delivers rendered text to target session as an `input` event with appropriate `deliverAs`
5. If `expectsResponse`, stores `triggerId` in `pendingTriggers` map

**Responding to a trigger (parent side):**

1. Parent receives the rendered trigger as a user message in its conversation
2. Parent agent reasons about it and produces a response
3. The daemon identifies that the parent's response correlates to a pending trigger (by conversation position / message ordering)
4. Daemon routes the response text back to the source child as an `input` event
5. If trigger type has `parseResponse`, the response is parsed before delivery
6. `pendingTriggers` entry is cleaned up

**Escalation flow:**

1. Parent responds to a child trigger with "escalate" (or equivalent)
2. Daemon fires a new `escalate` trigger targeting the human viewer
3. The `escalate` trigger includes the original trigger's payload for context
4. Human viewer sees the question in the web UI and can respond directly
5. Response routes back through the daemon to the original child

---

## Parent → Child Interaction

### Default: Steer

When the parent responds to a trigger-injected message, the response routes back to the child as a **steer** (immediate delivery). This is the supervisor model — the parent's input takes priority.

### Explicit Follow-Up

For queuing a message until the child finishes its current turn:

```typescript
// tell_child tool
{
  name: "tell_child",
  description: "Send a message to a linked child session.",
  parameters: {
    sessionId: { type: "string", description: "Child session ID" },
    message: { type: "string", description: "Message to send" },
    deliverAs: {
      type: "string",
      enum: ["steer", "followUp"],
      default: "steer",
      description: "Steer interrupts immediately (default). Follow-up waits until child's turn ends."
    },
  },
  required: ["sessionId", "message"],
}
```

### Automatic Response Routing

When the parent has outstanding triggers from children, responses to trigger-injected messages automatically route back. The daemon tracks which injected messages came from which child using conversation position and trigger IDs embedded as metadata in the injected message.

For **unprompted** messages to children (no pending trigger), the parent uses the `tell_child` tool explicitly.

---

## Completion & Acknowledgment

### Flow

1. Child finishes work → fires `session_complete` trigger
2. Parent receives: *"🔗 Child 'Fix the tests' completed: All 12 tests passing. 3 files modified. Acknowledge or follow up."*
3. Child enters **linked-pending** state (done working, link alive)
4. Parent options:
   - **Acknowledge:** ("looks good", "done", "ack") → link closes, child can expire
   - **Follow up:** ("also fix the linting") → delivered as steer, child resumes work
5. `session_complete` trigger's `parseResponse` determines which path

### Parent Death / Disconnect

- Children continue running independently (no hard dependency on parent)
- Pending `expectsResponse` triggers time out after a configurable period (default: 5 minutes)
- Orphaned triggers can escalate to the human viewer if one is connected
- `parentSessionId` stays in Redis for UI display; live link is gone

### Multiple Children

Each child's triggers are tagged with `sourceSessionId` and `sourceSessionName`. The parent sees clearly which child is asking/completing:

```
🔗 Child "Fix tests" (abc-1234) asks: ...
🔗 Child "Update docs" (def-5678) completed: ...
```

---

## Tool Changes

### New Tools

| Tool | Description |
|------|-------------|
| `tell_child` | Send a message to a linked child session. Default: steer. Optional `deliverAs: "followUp"`. |

### Modified Tools

| Tool | Change |
|------|--------|
| `spawn_session` | Automatically sets `parentSessionId` from calling session's own ID. No new agent-facing parameters. |

### Deprecated Tools

| Tool | Replacement |
|------|-------------|
| `send_message` | Trigger responses (auto-routed) + `tell_child` |
| `wait_for_message` | Triggers injected as user messages — no blocking |
| `check_messages` | Triggers arrive as conversation flow |
| `get_session_id` | Parent-child link is automatic |

### Extension Changes

| File | Change |
|------|--------|
| `spawn-session.ts` | Include `parentSessionId` in spawn request |
| `session-messaging.ts` | Deprecated — trigger system replaces |
| **New: `triggers.ts`** | `TriggerRegistry`, built-in triggers, `tell_child` tool, trigger routing |
| `remote.ts` | Handle `session_trigger` events, convert to `sendUserMessage`, route responses |
| `session-message-bus.ts` | Deprecated — triggers replace the bus |

---

## Web UI Changes

### Session Tree

- **Sidebar:** Child sessions indented under parent. Collapsible tree structure.
- **Session header:** Breadcrumb showing parent → child chain with clickable links.
- **Parent view:** "Children" section listing active children with status badges (running, pending-ack, completed).

### Trigger Cards

Trigger-injected messages render as distinct cards in the parent's conversation:

- Trigger type icon + child session name
- Structured payload display (question + options, plan steps, completion summary)
- Response area for `expectsResponse` triggers
- Human can respond directly (bypassing the parent agent)

### Child Session View

- Shows when triggers were fired and what responses came back
- "⏳ Waiting for parent response..." indicator while pending
- "✅ Parent responded: [response]" when answered

### Human Override

The human viewer on a parent session can:

- See all pending child triggers
- Respond directly (bypassing the parent agent's reasoning)
- Steer any child via existing input mechanism

---

## Documentation Updates

The following docs pages need updates:

| Page | Changes |
|------|---------|
| `guides/cli-reference.mdx` | Document `tell_child` tool, deprecation of messaging tools |
| `guides/runner-daemon.mdx` | Describe trigger routing, parent-child link management |
| `reference/architecture.mdx` | Add trigger system to architecture diagram, parent-child data flow |
| `reference/environment-variables.mdx` | Add `PIZZAPI_WORKER_PARENT_SESSION_ID` |

### System Prompt Updates

Update `BUILTIN_SYSTEM_PROMPT` in `packages/cli/src/config.ts`:

- Describe the linked session model: "When you spawn a session, it's automatically linked. Child events (questions, plans, completion) appear in your conversation."
- Explain response expectations: "Respond naturally to child triggers. Say 'escalate' to pass to the human."
- Document `tell_child`: "Use `tell_child` to proactively steer a child session."
- Remove all references to `send_message`, `wait_for_message`, `check_messages`, `get_session_id`.

### Agent Guide Updates

Update `AGENTS.md` spawning sub-agents section:

- Remove the "include your session ID" pattern
- Document trigger-based interaction model
- Update the "always expect a response" guidance to "triggers arrive automatically"

---

## Implementation Order

1. **Data model** — Add `parentSessionId` to Redis schema, `RunnerSession`, spawn flow
2. **Trigger system core** — `ConversationTrigger` interface, `TriggerRegistry`, built-in renderers
3. **Daemon routing** — Same-runner trigger delivery and response correlation
4. **CLI extension: `triggers.ts`** — `tell_child` tool, trigger emission from child-side
5. **Wire up built-in triggers** — AskUserQuestion, plan_mode, session_complete interception
6. **Server routing** — Cross-runner trigger delivery via relay
7. **Web UI: session tree** — Parent-child visualization in sidebar and headers
8. **Web UI: trigger cards** — Render triggers in parent conversation
9. **Deprecate old tools** — Mark `send_message`/`wait_for_message`/`check_messages`/`get_session_id` as deprecated
10. **Documentation** — Update all affected docs pages, system prompt, agent guide
11. **Testing** — Unit tests for trigger routing, integration tests for parent-child flows

---

## Out of Scope

- **`subagent` tool changes** — stays as-is for in-process lightweight tasks
- **Multi-level nesting** — grandparent chains work implicitly (child's parent is just another session that may itself have a parent), but we don't optimize for deep chains in V1
- **Cross-user session linking** — parent and child must belong to the same user
- **Trigger persistence** — triggers are ephemeral (in-memory at daemon level). Redis stores relationships, not trigger history

---

## Open Questions

1. **Response correlation accuracy:** How reliably can the daemon determine which of the parent's responses corresponds to which pending trigger, especially when multiple children fire triggers simultaneously? May need explicit trigger ID tagging in the injected message and a structured response format.

2. **Trigger timeout defaults:** What's the right timeout for `expectsResponse` triggers before auto-escalating to the human? Proposed: 5 minutes, configurable per trigger type.

3. **Backwards compatibility window:** How long to keep deprecated messaging tools before removal? Proposed: 2 minor versions with deprecation warnings.
