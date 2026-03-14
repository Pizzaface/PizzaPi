# Linked Sessions & Conversation Triggers — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add parent-child session linking and a conversation trigger system so child session events (questions, plans, completion) automatically surface in the parent's conversation, replacing manual messaging plumbing.

**Architecture:** The runner daemon acts as the routing hub. Child workers emit typed `session_trigger` events over the relay socket. The daemon renders triggers into text, injects them into the parent as `input` events, tracks pending responses, and routes replies back. Redis stores `parentSessionId` for UI display.

**Tech Stack:** TypeScript, Bun, Socket.IO (relay protocol), Redis, React 19

**Spec:** `docs/superpowers/specs/2026-03-13-linked-sessions-conversation-triggers-design.md`

---

## Chunk 1: Data Model & Spawn Flow

### Task 1: Add `parentSessionId` to Redis session data

**Files:**
- Modify: `packages/server/src/ws/sio-state.ts`

- [ ] **Step 1: Add `parentSessionId` to `RedisSessionData` interface**

In `RedisSessionData`, add after `seq`:

```typescript
/** ID of the parent session that spawned this one, or null for top-level. */
parentSessionId: string | null;
```

- [ ] **Step 2: Update `parseSessionFromHash` to read the new field**

Add to the return object:

```typescript
parentSessionId: hash.parentSessionId || null,
```

- [ ] **Step 3: Add a `childrenKey` helper and child index functions**

Add below the existing key helpers:

```typescript
/** Set of child session IDs for a parent session. */
function childrenKey(parentSessionId: string): string {
    return `${KEY_PREFIX}:children:${parentSessionId}`;
}

/** Record a child session under its parent. */
export async function addChildSession(parentSessionId: string, childSessionId: string): Promise<void> {
    const r = requireRedis();
    const multi = r.multi();
    multi.sAdd(childrenKey(parentSessionId), childSessionId);
    multi.expire(childrenKey(parentSessionId), SESSION_TTL_SECONDS);
    await multi.exec();
}

/** Get all child session IDs for a parent. */
export async function getChildSessions(parentSessionId: string): Promise<string[]> {
    const r = requireRedis();
    return r.sMembers(childrenKey(parentSessionId));
}

/** Remove a child from its parent's children set. */
export async function removeChildSession(parentSessionId: string, childSessionId: string): Promise<void> {
    const r = requireRedis();
    await r.sRem(childrenKey(parentSessionId), childSessionId);
}
```

- [ ] **Step 4: Commit**

```bash
git add packages/server/src/ws/sio-state.ts
git commit -m "feat: add parentSessionId to RedisSessionData and child index helpers"
```

---

### Task 2: Add `parentSessionId` to relay protocol types

**Files:**
- Modify: `packages/protocol/src/relay.ts`

- [ ] **Step 1: Add `session_trigger` to `RelayClientToServerEvents`**

Add after `session_message`:

```typescript
/** Child session fires a trigger destined for its parent */
session_trigger: (data: {
    token: string;
    trigger: {
        type: string;
        sourceSessionId: string;
        sourceSessionName?: string;
        targetSessionId: string;
        payload: Record<string, unknown>;
        deliverAs: "steer" | "followUp";
        expectsResponse: boolean;
        triggerId: string;
        timeoutMs?: number;
        ts: string;
    };
}) => void;
```

- [ ] **Step 2: Add `trigger_response` to `RelayClientToServerEvents`**

Add after `session_trigger` (which was just added in Step 1):

```typescript
/** Parent sends a trigger response back to the child */
trigger_response: (data: {
    token: string;
    triggerId: string;
    response: string;
    targetSessionId: string;
}) => void;
```

- [ ] **Step 3: Add `session_trigger` and `trigger_response` to `RelayServerToClientEvents`**

Add after `session_message_error`:

```typescript
/** Delivers a trigger from a child to the target session */
session_trigger: (data: {
    trigger: {
        type: string;
        sourceSessionId: string;
        sourceSessionName?: string;
        targetSessionId: string;
        payload: Record<string, unknown>;
        deliverAs: "steer" | "followUp";
        expectsResponse: boolean;
        triggerId: string;
        timeoutMs?: number;
        ts: string;
    };
}) => void;

/** Delivers a trigger response back to the source child */
trigger_response: (data: {
    triggerId: string;
    response: string;
}) => void;
```

- [ ] **Step 4: Commit**

```bash
git add packages/protocol/src/relay.ts
git commit -m "feat: add session_trigger and trigger_response to relay protocol"
```

---

### Task 3: Add `parentSessionId` to `RunnerSession` and `new_session` handler

**Files:**
- Modify: `packages/protocol/src/runner.ts`
- Modify: `packages/cli/src/runner/daemon.ts`

- [ ] **Step 1: Add `parentSessionId` to the runner protocol's `new_session` event**

In `packages/protocol/src/runner.ts`, find the `new_session` event type and add `parentSessionId?: string` to its data shape.

- [ ] **Step 2: Add `parentSessionId` to `RunnerSession` interface in `daemon.ts`**

```typescript
interface RunnerSession {
    sessionId: string;
    child: ChildProcess | null;
    startedAt: number;
    adopted?: boolean;
    parentSessionId?: string;
}
```

- [ ] **Step 3: Read `parentSessionId` from `new_session` event data in daemon**

In the `socket.on("new_session", ...)` handler (~line 590), destructure `parentSessionId`:

```typescript
const { sessionId, cwd: requestedCwd, prompt: requestedPrompt, model: requestedModel, hiddenModels: requestedHiddenModels, agent: requestedAgent, parentSessionId } = data;
```

Pass it through to `spawnSession`:

```typescript
spawnSession(sessionId, apiKey!, requestedCwd, runningSessions, doSpawn, { ...spawnOpts, parentSessionId });
```

- [ ] **Step 4: Update `spawnSession` function to accept and pass `parentSessionId`**

Add `parentSessionId?: string` to the `options` type. Pass it as an env var:

```typescript
...(options?.parentSessionId ? { PIZZAPI_WORKER_PARENT_SESSION_ID: options.parentSessionId } : {}),
```

Store it in `RunnerSession`:

```typescript
runningSessions.set(sessionId, { sessionId, child, startedAt: Date.now(), parentSessionId: options?.parentSessionId });
```

- [ ] **Step 5: Commit**

```bash
git add packages/protocol/src/runner.ts packages/cli/src/runner/daemon.ts
git commit -m "feat: plumb parentSessionId through daemon spawn flow"
```

---

### Task 4: Send `parentSessionId` from `spawn_session` tool and server

**Files:**
- Modify: `packages/cli/src/extensions/spawn-session.ts`
- Modify: `packages/server/src/routes/runners.ts`

- [ ] **Step 1: Include `parentSessionId` in spawn HTTP request body**

In `spawn-session.ts`, in the `execute` function, get the current session ID from env:

```typescript
const ownSessionId = process.env.PIZZAPI_SESSION_ID;
```

Add to the `body` object:

```typescript
if (ownSessionId) {
    body.parentSessionId = ownSessionId;
}
```

- [ ] **Step 2: Parse and forward `parentSessionId` in server spawn endpoint**

In `packages/server/src/routes/runners.ts`, in the `/api/runners/spawn` handler, parse:

```typescript
const requestedParentSessionId = typeof body.parentSessionId === "string" ? body.parentSessionId : undefined;
```

Include in the `new_session` emit:

```typescript
...(requestedParentSessionId ? { parentSessionId: requestedParentSessionId } : {}),
```

After `recordRunnerSession`, store in Redis:

```typescript
if (requestedParentSessionId) {
    await updateSessionFields(sessionId, { parentSessionId: requestedParentSessionId } as any);
    await addChildSession(requestedParentSessionId, sessionId);
}
```

Add the imports at the top:

```typescript
import { updateSessionFields, addChildSession } from "../ws/sio-state.js";
```

- [ ] **Step 3: Commit**

```bash
git add packages/cli/src/extensions/spawn-session.ts packages/server/src/routes/runners.ts
git commit -m "feat: spawn_session automatically links parent-child sessions"
```

---

### Task 5: Write tests for Task 1-4

**Files:**
- Create: `packages/server/src/ws/sio-state-children.test.ts`

- [ ] **Step 1: Write unit tests for child session Redis helpers**

```typescript
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
// Test the addChildSession/getChildSessions/removeChildSession functions
// using a mock or real Redis instance (follow existing test patterns in packages/server)
```

Test cases:
- `addChildSession` adds a child to the parent's set
- `getChildSessions` returns all children
- `removeChildSession` removes a specific child
- `getChildSessions` returns empty array for parentless sessions
- `parseSessionFromHash` includes `parentSessionId`

- [ ] **Step 2: Run tests**

```bash
bun test packages/server/src/ws/sio-state-children.test.ts
```

- [ ] **Step 3: Commit**

```bash
git add packages/server/src/ws/sio-state-children.test.ts
git commit -m "test: add unit tests for child session Redis helpers"
```

---

## Chunk 2: Trigger System Core

### Task 6: Create trigger types and registry

**Files:**
- Create: `packages/cli/src/extensions/triggers/types.ts`
- Create: `packages/cli/src/extensions/triggers/registry.ts`

- [ ] **Step 1: Create `types.ts` with core interfaces**

```typescript
/** A conversation trigger fired by a child session. */
export interface ConversationTrigger {
    type: string;
    sourceSessionId: string;
    sourceSessionName?: string;
    targetSessionId: string;
    payload: Record<string, unknown>;
    deliverAs: "steer" | "followUp";
    expectsResponse: boolean;
    triggerId: string;
    timeoutMs?: number;
    ts: string;
}

/** Renders a trigger into text for injection and optionally parses responses. */
export interface TriggerRenderer {
    type: string;
    render(trigger: ConversationTrigger): string;
    parseResponse?(responseText: string, trigger: ConversationTrigger): unknown;
}

/** Pending trigger awaiting a response from the target session. */
export interface PendingTrigger {
    trigger: ConversationTrigger;
    deliveredAt: number;
    timeoutTimer?: ReturnType<typeof setTimeout>;
}
```

- [ ] **Step 2: Create `registry.ts` with hardcoded trigger renderers**

```typescript
import type { ConversationTrigger, TriggerRenderer } from "./types.js";

// ── Built-in renderers ──────────────────────────────────────────────

const askUserQuestionRenderer: TriggerRenderer = { ... };
const planReviewRenderer: TriggerRenderer = { ... };
const sessionCompleteRenderer: TriggerRenderer = { ... };
const sessionErrorRenderer: TriggerRenderer = { ... };
const escalateRenderer: TriggerRenderer = { ... };

export const TRIGGER_RENDERERS: ReadonlyMap<string, TriggerRenderer> = new Map([
    ["ask_user_question", askUserQuestionRenderer],
    ["plan_review", planReviewRenderer],
    ["session_complete", sessionCompleteRenderer],
    ["session_error", sessionErrorRenderer],
    ["escalate", escalateRenderer],
]);

/** Render a trigger to text, with trigger ID metadata prefix. */
export function renderTrigger(trigger: ConversationTrigger): string {
    const renderer = TRIGGER_RENDERERS.get(trigger.type);
    const body = renderer
        ? renderer.render(trigger)
        : `🔗 Child "${trigger.sourceSessionName ?? trigger.sourceSessionId}" sent unknown trigger "${trigger.type}". Payload: ${JSON.stringify(trigger.payload)}`;
    return `<!-- trigger:${trigger.triggerId} -->\n${body}`;
}

/** Parse a response using the trigger type's parser, if available. */
export function parseTriggerResponse(trigger: ConversationTrigger, responseText: string): unknown {
    const renderer = TRIGGER_RENDERERS.get(trigger.type);
    return renderer?.parseResponse?.(responseText, trigger) ?? responseText;
}
```

Each renderer produces text like:
- `ask_user_question`: "🔗 Child 'name' asks: {question}\nOptions: 1. {opt1} 2. {opt2}\n\nRespond with `respond_to_trigger` using trigger ID `{id}`."
- `session_complete`: "🔗 Child 'name' completed: {summary}\n\nAcknowledge or follow up using `respond_to_trigger` with trigger ID `{id}`."
- etc.

- [ ] **Step 3: Commit**

```bash
git add packages/cli/src/extensions/triggers/
git commit -m "feat: add ConversationTrigger types and hardcoded renderer registry"
```

---

### Task 7: Write tests for trigger renderers

**Files:**
- Create: `packages/cli/src/extensions/triggers/registry.test.ts`

- [ ] **Step 1: Write unit tests for each renderer**

Test cases:
- `renderTrigger` for `ask_user_question` includes question, options, and trigger ID metadata
- `renderTrigger` for `session_complete` includes summary and ack instruction
- `renderTrigger` for `session_error` includes error message
- `renderTrigger` for unknown type produces fallback with raw payload
- `parseTriggerResponse` for `session_complete` distinguishes ack phrases from follow-up
- `parseTriggerResponse` for unknown type returns raw text

- [ ] **Step 2: Run tests**

```bash
bun test packages/cli/src/extensions/triggers/registry.test.ts
```

- [ ] **Step 3: Commit**

```bash
git add packages/cli/src/extensions/triggers/registry.test.ts
git commit -m "test: add unit tests for trigger renderers and response parsing"
```

---

### Checkpoint: Typecheck after Chunk 2

- [ ] **Run typecheck to catch type errors early**

```bash
bun run typecheck
```

Fix any errors before proceeding.

---

## Chunk 3: Trigger Routing (Relay Server)

**Architecture note:** In V1, all trigger routing goes through the relay server. Each worker has its own relay socket connection. A child worker emits `session_trigger` to the relay server, which looks up the target session's socket and forwards it. Responses flow back the same way via `trigger_response`. This is simpler than daemon-level IPC and reuses the existing relay infrastructure. The spec's "daemon fast-path" optimization is deferred — relay routing has negligible latency for same-machine sessions since it's localhost WebSocket.

### Task 8: Add trigger routing to relay server

**Files:**
- Modify: `packages/server/src/ws/namespaces/relay.ts`

- [ ] **Step 1: Add `session_trigger` handler in relay namespace**

In `packages/server/src/ws/namespaces/relay.ts`, after the existing `socket.on("session_message", ...)` handler (around line 333), add a new handler:

```typescript
// ── session_trigger — child-to-parent trigger routing ──────────────
socket.on("session_trigger", async (data) => {
    const trigger = data?.trigger;
    if (!trigger?.targetSessionId || !trigger?.triggerId) {
        socket.emit("error", { message: "session_trigger requires trigger with targetSessionId and triggerId" });
        return;
    }

    const targetSessionId = trigger.targetSessionId;

    // Find the target session's relay socket (same pattern as session_message)
    const targetSockets = await sio.in(targetSessionId).fetchSockets();
    if (targetSockets.length === 0) {
        socket.emit("session_message_error", {
            targetSessionId,
            error: `Target session ${targetSessionId} is not connected`,
        });
        return;
    }

    // Forward trigger to all sockets in the target session's room
    for (const targetSocket of targetSockets) {
        targetSocket.emit("session_trigger" as any, { trigger });
    }
});
```

- [ ] **Step 2: Add `trigger_response` handler in relay namespace**

Immediately after the `session_trigger` handler, add the response routing handler. This must also add `trigger_response` to the protocol types (done in Task 2):

```typescript
// ── trigger_response — parent-to-child response routing ────────────
socket.on("trigger_response" as any, async (data: {
    token: string;
    triggerId: string;
    response: string;
    targetSessionId: string;
}) => {
    const { triggerId, response, targetSessionId } = data ?? {};
    if (!triggerId || !response || !targetSessionId) {
        socket.emit("error", { message: "trigger_response requires triggerId, response, and targetSessionId" });
        return;
    }

    // Validate the sender is authenticated (has a token matching a registered session)
    if (!socketData.token) {
        socket.emit("error", { message: "Not authenticated" });
        return;
    }

    const targetSockets = await sio.in(targetSessionId).fetchSockets();
    if (targetSockets.length === 0) {
        socket.emit("session_message_error", {
            targetSessionId,
            error: `Target session ${targetSessionId} is not connected`,
        });
        return;
    }

    for (const targetSocket of targetSockets) {
        targetSocket.emit("trigger_response" as any, { triggerId, response });
    }
});
```

- [ ] **Step 3: Commit**

```bash
git add packages/server/src/ws/namespaces/relay.ts
git commit -m "feat: add session_trigger and trigger_response routing to relay server"
```

---

## Chunk 4: CLI Extension — Tools & Child-Side Emission

### Task 10: Create the triggers extension with tools

**Files:**
- Create: `packages/cli/src/extensions/triggers/extension.ts`

- [ ] **Step 1: Create the extension factory with stub tool implementations**

Register three tools as **stubs** — they validate params and return success messages but don't actually emit to the relay socket yet. Task 12 wires them up to `getRelaySocket()`.

```typescript
import type { ExtensionFactory } from "@mariozechner/pi-coding-agent";
import type { ConversationTrigger, PendingTrigger } from "./types.js";
import { getRelaySocket } from "../remote.js";  // Available after Task 10b

const silent = { render: (_w: number): string[] => [], invalidate: () => {} };

export const triggersExtension: ExtensionFactory = (pi) => {
    const parentSessionId = process.env.PIZZAPI_WORKER_PARENT_SESSION_ID ?? null;
    const ownSessionId = process.env.PIZZAPI_SESSION_ID ?? null;

    // ── tell_child (STUB — wired in Task 12) ─────────────────────────
    pi.registerTool({
        name: "tell_child",
        label: "Tell Child",
        description: "Send a message to a linked child session.",
        parameters: {
            type: "object",
            properties: {
                sessionId: { type: "string", description: "Child session ID" },
                message: { type: "string", description: "Message to send" },
                deliverAs: {
                    type: "string",
                    enum: ["steer", "followUp"],
                    description: "Steer interrupts immediately (default). Follow-up waits until child's turn ends.",
                },
            },
            required: ["sessionId", "message"],
        } as any,
        async execute(_toolCallId, rawParams) {
            const params = rawParams as { sessionId: string; message: string; deliverAs?: string };
            // TODO(Task 12): Wire to relay socket
            return { content: [{ type: "text" as const, text: `[STUB] Message sent to child ${params.sessionId}` }] };
        },
        renderCall: () => silent,
        renderResult: () => silent,
    });

    // ── respond_to_trigger (STUB — wired in Task 12) ─────────────────
    pi.registerTool({
        name: "respond_to_trigger",
        label: "Respond to Trigger",
        description: "Respond to a pending trigger from a child session.",
        parameters: {
            type: "object",
            properties: {
                triggerId: { type: "string", description: "The trigger ID from the child's request" },
                response: { type: "string", description: "Response text to send back to the child" },
            },
            required: ["triggerId", "response"],
        } as any,
        async execute(_toolCallId, rawParams) {
            const params = rawParams as { triggerId: string; response: string };
            // TODO(Task 12): Wire to relay trigger_response event
            return { content: [{ type: "text" as const, text: `[STUB] Response sent for trigger ${params.triggerId}` }] };
        },
        renderCall: () => silent,
        renderResult: () => silent,
    });

    // ── escalate_trigger (STUB — wired in Task 12) ───────────────────
    pi.registerTool({
        name: "escalate_trigger",
        label: "Escalate Trigger",
        description: "Escalate a child's trigger to the human viewer.",
        parameters: {
            type: "object",
            properties: {
                triggerId: { type: "string", description: "The trigger ID to escalate" },
                context: { type: "string", description: "Additional context for the human" },
            },
            required: ["triggerId"],
        } as any,
        async execute(_toolCallId, rawParams) {
            const params = rawParams as { triggerId: string; context?: string };
            // TODO(Task 12): Wire to relay escalate trigger
            return { content: [{ type: "text" as const, text: `[STUB] Trigger ${params.triggerId} escalated to human` }] };
        },
        renderCall: () => silent,
        renderResult: () => silent,
    });
};
```

- [ ] **Step 2: Register the extension in `packages/cli/src/extensions/factories.ts`**

Add the import at the top of the file:

```typescript
import { triggersExtension } from "./triggers/extension.js";
```

Add `triggersExtension` to the `factories.push(...)` call, after `planModeToggleExtension`:

```typescript
    factories.push(
        restartExtension,
        setSessionNameExtension,
        updateTodoExtension,
        spawnSessionExtension,
        sessionMessagingExtension,
        subagentExtension,
        planModeToggleExtension,
        triggersExtension,  // NEW
    );
```

- [ ] **Step 3: Commit**

```bash
git add packages/cli/src/extensions/triggers/
git commit -m "feat: add triggers extension with tell_child, respond_to_trigger, escalate_trigger tools"
```

---

### Task 10b: Export relay socket getter from remote.ts

**Files:**
- Modify: `packages/cli/src/extensions/remote.ts`

This must happen before Task 12 (which needs relay socket access from `triggers/extension.ts`).

- [ ] **Step 1: Add relay socket export**

Near the top of `remote.ts`, after the `_cliErrorForwarder` section (~line 114), add module-level exports:

```typescript
// ── Relay socket access for trigger system ────────────────────────────────────
let _relaySocket: Socket<RelayServerToClientEvents, RelayClientToServerEvents> | null = null;
let _relayToken: string | null = null;

/** Get the active relay socket and token, or null if not connected. */
export function getRelaySocket(): { socket: Socket<RelayServerToClientEvents, RelayClientToServerEvents>; token: string } | null {
    return _relaySocket?.connected ? { socket: _relaySocket, token: _relayToken ?? "" } : null;
}
```

Inside the `registered` handler (~line 1845), after `relay = { ... }`, set:

```typescript
_relaySocket = sioSocket;
_relayToken = data.token;
```

- [ ] **Step 2: Commit**

```bash
git add packages/cli/src/extensions/remote.ts
git commit -m "feat: export getRelaySocket from remote.ts for trigger system"
```

---

### Task 11: Wire up trigger reception in remote.ts

**Files:**
- Modify: `packages/cli/src/extensions/remote.ts`

- [ ] **Step 1: Add trigger types import**

At the top of `remote.ts`:

```typescript
import { renderTrigger } from "./triggers/registry.js";
import type { ConversationTrigger } from "./triggers/types.js";
```

- [ ] **Step 2: Add `session_trigger` listener for receiving triggers as a parent**

In `remote.ts`, inside the `connectToRelay` function, in the "Incoming events from server" section (after the existing `sock.on("session_message", ...)` handler at ~line 1914), add using the local `sock` variable (which is the `sioSocket`):

```typescript
sock.on("session_trigger" as any, (data: { trigger: ConversationTrigger }) => {
    const trigger = data?.trigger;
    if (!trigger) return;
    // Render trigger to text with trigger ID metadata prefix
    const rendered = renderTrigger(trigger);
    const deliverAs = trigger.deliverAs === "followUp" ? "followUp" as const : "steer" as const;
    void (async () => {
        pi.sendUserMessage(rendered, { deliverAs });
    })();
});
```

Note: Inside `connectToRelay`, the local variable is `sock` (the raw Socket.IO socket). This is the same variable used for `sock.on("session_message", ...)` at line 1914. The module-level `sioSocket` is assigned from `sock` earlier.

- [ ] **Step 3: `trigger_response` listener is NOT needed here**

`trigger_response` events are handled directly inside the AskUserQuestion/plan_mode interceptors (Task 13) using per-trigger one-shot listeners. No global handler needed — each trigger sets up its own response listener with the matching `triggerId`.

- [ ] **Step 4: Commit**

```bash
git add packages/cli/src/extensions/remote.ts
git commit -m "feat: wire up trigger emission and reception in remote extension"
```

---

### Task 12: Wire trigger tool stubs to relay socket

**Files:**
- Modify: `packages/cli/src/extensions/triggers/extension.ts`

**Prerequisite:** Task 10b (`getRelaySocket` export) must be complete.

- [ ] **Step 1: Wire `tell_child` to emit `session_message` via relay**

Replace the stub in `tell_child`'s `execute` with:

```typescript
async execute(_toolCallId, rawParams) {
    const params = rawParams as { sessionId: string; message: string; deliverAs?: string };
    const conn = getRelaySocket();
    if (!conn) {
        return { content: [{ type: "text" as const, text: "Error: Not connected to relay. Cannot send message to child." }] };
    }
    // Reuse existing session_message mechanism to send input to the child
    conn.socket.emit("session_message", {
        token: conn.token,
        targetSessionId: params.sessionId,
        message: params.message,
    });
    return { content: [{ type: "text" as const, text: `Message sent to child ${params.sessionId} (deliverAs: ${params.deliverAs ?? "steer"})` }] };
},
```

Note: `session_message` delivers to the child's relay connection. The child receives it via `sock.on("session_message", ...)` in remote.ts and it's handled by the message bus. For `tell_child`, we may want to route via the relay's `input` event instead so it acts like a user message with `deliverAs`. This requires a new relay event or extending `session_message` with a `deliverAs` field. **For V1, use `session_message` and document the limitation.**

- [ ] **Step 2: Wire `respond_to_trigger` to emit `trigger_response` via relay**

Replace the stub with:

```typescript
async execute(_toolCallId, rawParams) {
    const params = rawParams as { triggerId: string; response: string };
    const conn = getRelaySocket();
    if (!conn) {
        return { content: [{ type: "text" as const, text: "Error: Not connected to relay." }] };
    }
    // The triggerId maps to a pending trigger — we need to know the target child session ID.
    // The parent tracks received triggers in a local map populated by the session_trigger listener.
    const pending = receivedTriggers.get(params.triggerId);
    if (!pending) {
        return { content: [{ type: "text" as const, text: `Error: No pending trigger with ID ${params.triggerId}. It may have already been responded to or timed out.` }] };
    }
    conn.socket.emit("trigger_response" as any, {
        token: conn.token,
        triggerId: params.triggerId,
        response: params.response,
        targetSessionId: pending.sourceSessionId,
    });
    receivedTriggers.delete(params.triggerId);
    return { content: [{ type: "text" as const, text: `Response sent for trigger ${params.triggerId}` }] };
},
```

Add a `receivedTriggers` map at the top of the extension:

```typescript
// Tracks triggers this session has received (as parent) for response routing
const receivedTriggers = new Map<string, { sourceSessionId: string; type: string }>();
```

This map is populated by the `session_trigger` listener added in Task 11 — the listener should call a setter exported from this extension or the triggers module.

- [ ] **Step 3: Wire `escalate_trigger` to fire an escalate trigger**

```typescript
async execute(_toolCallId, rawParams) {
    const params = rawParams as { triggerId: string; context?: string };
    const conn = getRelaySocket();
    if (!conn) {
        return { content: [{ type: "text" as const, text: "Error: Not connected to relay." }] };
    }
    const pending = receivedTriggers.get(params.triggerId);
    if (!pending) {
        return { content: [{ type: "text" as const, text: `Error: No pending trigger with ID ${params.triggerId}.` }] };
    }
    // Fire an escalate trigger to the human viewer (no specific target — the web UI handles it)
    conn.socket.emit("session_trigger" as any, {
        token: conn.token,
        trigger: {
            type: "escalate",
            sourceSessionId: ownSessionId ?? "",
            targetSessionId: pending.sourceSessionId,  // Uses inherited triggerId per spec
            payload: { reason: params.context ?? "Parent escalated", originalTriggerId: params.triggerId },
            deliverAs: "steer" as const,
            expectsResponse: true,
            triggerId: params.triggerId,  // Inherit original triggerId per spec
            ts: new Date().toISOString(),
        },
    });
    receivedTriggers.delete(params.triggerId);
    return { content: [{ type: "text" as const, text: `Trigger ${params.triggerId} escalated to human` }] };
},
```

- [ ] **Step 4: Commit**

```bash
git add packages/cli/src/extensions/triggers/extension.ts
git commit -m "feat: wire trigger tools to relay socket via getRelaySocket"
```

---

## Chunk 5: Wire Up Built-in Triggers

### Task 13: Intercept AskUserQuestion in child sessions

**Files:**
- Modify: `packages/cli/src/extensions/remote.ts`

**Mechanism:** The `AskUserQuestion` tool is registered in `remote.ts` at ~line 2060. Its `execute` function calls `askUserQuestion()` which sets `pendingAskUserQuestion` and blocks until a web viewer responds. For child sessions (where `process.env.PIZZAPI_WORKER_PARENT_SESSION_ID` is set), we modify the `execute` function to instead fire a trigger to the parent and wait for the `trigger_response` event.

- [ ] **Step 1: Add child-session detection at top of `remoteExtension`**

After the existing `relaySessionId` declaration (~line 146), add:

```typescript
const parentSessionId = process.env.PIZZAPI_WORKER_PARENT_SESSION_ID ?? null;
const isChildSession = parentSessionId !== null;
```

- [ ] **Step 2: Import trigger types and emission function**

At the top of `remote.ts`, add:

```typescript
import { renderTrigger } from "./triggers/registry.js";
import type { ConversationTrigger } from "./triggers/types.js";
```

- [ ] **Step 3: Add early return in AskUserQuestion execute for child sessions**

In the `AskUserQuestion` tool's `execute` function (~line 2110, after param validation and sanitization), add before the `askUserQuestion()` call. Note: `signal` is already available as the 3rd parameter of `execute(toolCallId, rawParams, signal, onUpdate, ctx)`:

```typescript
// ── Child session: fire trigger to parent instead of waiting for web UI ──
if (isChildSession && parentSessionId && sioSocket?.connected) {
    const triggerId = crypto.randomUUID();
    const trigger: ConversationTrigger = {
        type: "ask_user_question",
        sourceSessionId: relaySessionId,
        sourceSessionName: pi.getSessionName?.() ?? relaySessionId.slice(0, 8),
        targetSessionId: parentSessionId,
        payload: {
            question: questions.map(q => q.question).join("; "),
            options: questions.flatMap(q => q.options),
            questions,  // full structured data
        },
        deliverAs: "followUp",
        expectsResponse: true,
        triggerId,
        timeoutMs: 300_000,
        ts: new Date().toISOString(),
    };

    sioSocket.emit("session_trigger", { token: relay!.token, trigger });

    // Wait for trigger_response with matching triggerId
    const response = await new Promise<string>((resolve, reject) => {
        const timeout = setTimeout(() => {
            cleanup();
            resolve("Trigger timed out — no response from parent within 5 minutes.");
        }, trigger.timeoutMs ?? 300_000);

        const handler = (data: { triggerId: string; response: string }) => {
            if (data.triggerId === triggerId) {
                cleanup();
                resolve(data.response);
            }
        };

        const cleanup = () => {
            clearTimeout(timeout);
            sioSocket?.off("trigger_response" as any, handler);
        };

        sioSocket!.on("trigger_response" as any, handler);
        signal?.addEventListener("abort", () => { cleanup(); reject(new Error("Aborted")); });
    });

    return {
        content: [{ type: "text", text: response }],
        details: {
            questions,
            display,
            answers: null,
            answer: response,
            source: "parent_trigger",
            cancelled: false,
        } satisfies AskUserQuestionDetails,
    };
}
```

- [ ] **Step 4: Commit**

```bash
git add packages/cli/src/extensions/remote.ts
git commit -m "feat: AskUserQuestion fires trigger to parent in child sessions"
```

---

### Task 13b: Intercept plan_mode in child sessions

**Files:**
- Modify: `packages/cli/src/extensions/plan-mode-toggle.ts`

**Mechanism:** The `plan_mode` tool is registered in `packages/cli/src/extensions/plan-mode-toggle.ts`. The tool's `execute` function stores a pending plan in module state and waits for web UI approval (via an exec handler). For child sessions, we add an early return that fires a `plan_review` trigger and waits for the parent's response.

- [ ] **Step 1: Read `plan-mode-toggle.ts` to understand the approval flow**

Before modifying, read the full file to understand:
- How the tool stores pending plan state
- How `consumePendingPlanModeFromWeb` works
- What response format the tool expects

```bash
cat packages/cli/src/extensions/plan-mode-toggle.ts
```

- [ ] **Step 2: Add imports and child-session detection**

At the top of `plan-mode-toggle.ts`:

```typescript
import { getRelaySocket } from "./remote.js";
import type { ConversationTrigger } from "./triggers/types.js";
```

Inside the extension factory, add:

```typescript
const parentSessionId = process.env.PIZZAPI_WORKER_PARENT_SESSION_ID ?? null;
const isChildSession = parentSessionId !== null;
const ownSessionId = process.env.PIZZAPI_SESSION_ID ?? null;
```

- [ ] **Step 3: Add early return in `plan_mode` execute for child sessions**

In the `plan_mode` tool's `execute` function, after parameter validation, add:

```typescript
if (isChildSession && parentSessionId) {
    const conn = getRelaySocket();
    if (!conn) {
        return { content: [{ type: "text" as const, text: "Error: Not connected to relay. Cannot send plan to parent." }] };
    }

    const triggerId = crypto.randomUUID();
    const trigger: ConversationTrigger = {
        type: "plan_review",
        sourceSessionId: ownSessionId ?? "",
        sourceSessionName: pi.getSessionName?.() ?? undefined,
        targetSessionId: parentSessionId,
        payload: {
            title: params.title ?? "Plan Review",
            steps: params.steps ?? [],
            description: params.description ?? undefined,
        },
        deliverAs: "followUp",
        expectsResponse: true,
        triggerId,
        timeoutMs: 300_000,
        ts: new Date().toISOString(),
    };

    conn.socket.emit("session_trigger" as any, { token: conn.token, trigger });

    // Wait for parent's response
    const response = await new Promise<string>((resolve) => {
        const timeout = setTimeout(() => {
            cleanup();
            resolve("Cancel");  // Default to cancel on timeout
        }, trigger.timeoutMs ?? 300_000);

        const handler = (data: { triggerId: string; response: string }) => {
            if (data.triggerId === triggerId) {
                cleanup();
                resolve(data.response);
            }
        };

        const cleanup = () => {
            clearTimeout(timeout);
            conn.socket.off("trigger_response" as any, handler);
        };

        conn.socket.on("trigger_response" as any, handler);
        signal?.addEventListener("abort", () => { cleanup(); resolve("Cancel"); });
    });

    // Map parent response to plan_mode actions:
    // "Begin" / "approve" / "lgtm" → proceed
    // "Cancel" → cancel
    // Anything else → treat as "Suggest Edit" feedback
    const lower = response.toLowerCase().trim();
    const isApproval = ["begin", "approve", "approved", "lgtm", "looks good", "go", "proceed"].some(p => lower.includes(p));
    const isCancel = ["cancel", "stop", "no", "reject"].some(p => lower === p);

    if (isApproval) {
        return { content: [{ type: "text" as const, text: "Plan approved by parent. Proceeding." }] };
    } else if (isCancel) {
        return { content: [{ type: "text" as const, text: "Plan cancelled by parent." }] };
    } else {
        // Treat as edit suggestion
        return { content: [{ type: "text" as const, text: `Parent suggests edit: ${response}` }] };
    }
}
```

- [ ] **Step 4: Commit**

```bash
git add packages/cli/src/extensions/plan-mode-toggle.ts
git commit -m "feat: plan_mode fires trigger to parent in child sessions"
```

---

### Task 14: Fire `session_complete` trigger on child exit

**Files:**
- Modify: `packages/cli/src/extensions/triggers/extension.ts`

- [ ] **Step 1: Listen for `session_shutdown` event**

The pi extension API fires `"session_shutdown"` when the session ends (used by `mcp-extension.ts:693`, `claude-plugins.ts:303`). Use `pi.on?.("session_shutdown", ...)` with optional chaining since the method may not exist on all pi versions.

In the `triggersExtension` factory, add:

```typescript
pi.on?.("session_shutdown", () => {
    if (!parentSessionId || !sioSocket?.connected) return;
    sioSocket.emit("session_trigger", {
        token: relay?.token ?? "",
        trigger: {
            type: "session_complete",
            sourceSessionId: ownSessionId ?? "",
            sourceSessionName: pi.getSessionName?.() ?? undefined,
            targetSessionId: parentSessionId,
            payload: { summary: "Session completed", exitCode: 0 },
            deliverAs: "followUp" as const,
            expectsResponse: true,
            triggerId: crypto.randomUUID(),
            timeoutMs: 300_000,
            ts: new Date().toISOString(),
        },
    });
});
```

Note: The extension needs access to the relay socket. Either import it from `remote.ts` via an exported getter, or restructure the trigger tools to live inside `remote.ts`. The cleanest approach is to export a `getRelaySocket()` function from `remote.ts`.

- [ ] **Step 2: Add `getRelaySocket` export to `remote.ts`**

In `packages/cli/src/extensions/remote.ts`, add a module-level export:

```typescript
let _relaySocket: Socket | null = null;
let _relayToken: string | null = null;

export function getRelaySocket(): { socket: Socket; token: string } | null {
    return _relaySocket?.connected ? { socket: _relaySocket, token: _relayToken ?? "" } : null;
}
```

Set `_relaySocket = sioSocket` and `_relayToken = relay.token` inside the `registered` handler.

- [ ] **Step 3: Fire `session_error` on error scenarios**

Add error handling in the triggers extension — listen for unhandled rejections or pi error events and fire `session_error` triggers.

- [ ] **Step 4: Commit**

```bash
git add packages/cli/src/extensions/triggers/extension.ts packages/cli/src/extensions/remote.ts
git commit -m "feat: fire session_complete and session_error triggers on child exit"
```

---

## Chunk 6: System Prompt & Documentation

### Task 15: Update system prompt

**Files:**
- Modify: `packages/cli/src/config.ts`

- [ ] **Step 1: Add trigger system documentation to `BUILTIN_SYSTEM_PROMPT`**

Add a section explaining:
- Linked sessions: spawned sessions are automatically linked
- Child triggers arrive as injected messages with `<!-- trigger:ID -->` metadata
- Use `respond_to_trigger(triggerId, response)` to respond
- Use `escalate_trigger(triggerId)` to pass to human
- Use `tell_child(sessionId, message)` to proactively message children
- `send_message`/`wait_for_message` are for non-parent-child communication only

- [ ] **Step 2: Commit**

```bash
git add packages/cli/src/config.ts
git commit -m "docs: update BUILTIN_SYSTEM_PROMPT with trigger system guidance"
```

---

### Task 16: Update AGENTS.md

**Files:**
- Modify: `AGENTS.md`

- [ ] **Step 1: Update the "Spawning Sub-Agents" section**

Replace the "include your session ID" pattern with:
- "Spawned sessions are automatically linked — child events appear in your conversation"
- "Use `respond_to_trigger` / `escalate_trigger` to handle child questions"
- "Use `tell_child` for proactive messages to children"
- Keep `send_message`/`wait_for_message` documentation for non-linked coordination

- [ ] **Step 2: Commit**

```bash
git add AGENTS.md
git commit -m "docs: update AGENTS.md with trigger-based interaction model"
```

---

### Task 17: Update docs site

**Files:**
- Modify: `packages/docs/src/content/docs/reference/environment-variables.mdx`
- Modify: `packages/docs/src/content/docs/guides/runner-daemon.mdx`

- [ ] **Step 1: Add `PIZZAPI_WORKER_PARENT_SESSION_ID` to env vars docs**

- [ ] **Step 2: Add trigger routing section to runner daemon docs**

- [ ] **Step 3: Commit**

```bash
git add packages/docs/
git commit -m "docs: add trigger system and parent-child linking to docs site"
```

---

## Chunk 7: Web UI Changes

### Task 18: Add session tree to sidebar

**Files:**
- Modify: `packages/ui/src/components/SessionViewer.tsx` (or sidebar component)
- Modify: `packages/ui/src/App.tsx`

- [ ] **Step 1: Fetch `parentSessionId` and children in session list API**

Ensure the sessions list endpoint returns `parentSessionId` for each session.

- [ ] **Step 2: Build tree structure from flat session list**

Group sessions into a tree based on `parentSessionId`. Top-level sessions have no parent.

- [ ] **Step 3: Render indented child sessions in sidebar**

Display child sessions indented under their parent with status badges.

- [ ] **Step 4: Commit**

```bash
git add packages/ui/src/
git commit -m "feat: add parent-child session tree to sidebar"
```

---

### Task 19: Add trigger cards to conversation view

**Files:**
- Modify: `packages/ui/src/components/session-viewer/cards/InterAgentCards.tsx`

- [ ] **Step 1: Create `TriggerCard` component**

Render trigger-injected messages distinctly:
- Icon + child session name
- Trigger type badge
- Payload display (question + options, plan steps, etc.)
- "Respond" button for `expectsResponse` triggers (sends response to daemon)

- [ ] **Step 2: Detect trigger messages by `<!-- trigger:ID -->` prefix**

Parse the trigger ID from the message content and render as a TriggerCard instead of a plain message.

- [ ] **Step 3: Commit**

```bash
git add packages/ui/src/components/session-viewer/cards/InterAgentCards.tsx
git commit -m "feat: add TriggerCard component for child session triggers"
```

---

## Chunk 8: Integration Testing

### Task 20: Integration tests for parent-child flow

**Files:**
- Create: `packages/cli/src/extensions/triggers/integration.test.ts`

- [ ] **Step 1: Test trigger render → inject → response → route-back flow**

Mock the relay socket and test:
1. Child emits `session_trigger`
2. Relay routes to parent socket
3. Parent receives rendered trigger text
4. Parent calls `respond_to_trigger`
5. Response routes back to child

- [ ] **Step 2: Test error cases**

- Parentless trigger emission → error
- Unknown trigger type → fallback rendering
- Already-responded trigger → error
- Timeout → timeout notification

- [ ] **Step 3: Run all tests**

```bash
bun run test
```

- [ ] **Step 4: Commit**

```bash
git add packages/cli/src/extensions/triggers/integration.test.ts
git commit -m "test: add integration tests for trigger routing flow"
```

---

## Chunk 9: Final Verification

### Task 21: Typecheck, build, and push

- [ ] **Step 1: Run typecheck**

```bash
bun run typecheck
```

- [ ] **Step 2: Run full test suite**

```bash
bun run test
```

- [ ] **Step 3: Build all packages**

```bash
bun run build
```

- [ ] **Step 4: Push**

```bash
git pull --rebase
bd sync
git push -u origin epic/linked-sessions-triggers
```
