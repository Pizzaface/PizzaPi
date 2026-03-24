# PizzaPi Server Test Harness

A full integration-test harness for the PizzaPi server. It spins up a real
PizzaPi server (SQLite + Redis + Socket.IO) on an ephemeral port and provides
mock clients for every Socket.IO namespace, plus a fluent BDD scenario builder
for composing multi-component tests.

---

## Table of Contents

1. [Overview](#overview)
2. [Prerequisites](#prerequisites)
3. [Quick Start](#quick-start)
4. [Architecture](#architecture)
5. [API Reference](#api-reference)
   - [`createTestServer()`](#createtestserver)
   - [`createMockRunner()`](#createmockrunner)
   - [`createMockRelay()`](#createmockrelay)
   - [`createMockViewer()`](#createmockviewer)
   - [`createMockHubClient()`](#createmockhubclient)
   - [Event Builders](#event-builders)
   - [`TestScenario`](#testscenario)
6. [BDD Patterns](#bdd-patterns)
7. [Common Recipes](#common-recipes)
   - [Testing a REST Endpoint](#testing-a-rest-endpoint)
   - [Testing WebSocket Event Flow](#testing-websocket-event-flow-end-to-end)
   - [Testing Multi-Session Scenarios](#testing-multi-session-scenarios)
   - [Testing Conversation Replay](#testing-conversation-replay)
   - [Testing Inter-Session Triggers](#testing-inter-session-triggers)
8. [Sandbox Mode](#sandbox-mode)
9. [Troubleshooting](#troubleshooting)
10. [Known Limitations](#known-limitations)

---

## Overview

Integration tests for PizzaPi need a server with a real event pipeline: HTTP
routes, Socket.IO namespaces, Redis pub/sub, SQLite, and better-auth. The
harness provides all of this in a single `createTestServer()` call, together
with typed mock clients for every namespace:

| Namespace | Mock client | Role |
|-----------|-------------|------|
| `/runner` | `MockRunner` | Simulates a PizzaPi runner daemon |
| `/relay`  | `MockRelay`  | Simulates a running agent session emitting events |
| `/viewer` | `MockViewer` | Simulates a browser tab watching a session |
| `/hub`    | `MockHubClient` | Simulates the session list panel |

All clients are typed against the `@pizzapi/protocol` event maps, so TypeScript
catches mismatches at compile time.

For composing multi-component scenarios, `TestScenario` provides a fluent BDD
builder that handles creation order, resource tracking, and cleanup.

---

## Prerequisites

1. **Bun** — the project uses Bun exclusively. `npm`/`yarn`/`node` will not work.
2. **Redis** running on `localhost:6379` (the default). Override with
   `PIZZAPI_REDIS_URL` if needed:
   ```bash
   PIZZAPI_REDIS_URL=redis://localhost:6379 bun test
   ```
3. All server dependencies installed:
   ```bash
   bun install
   ```

---

## Quick Start

```ts
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createTestServer } from "./harness/server.js";
import { createMockRelay } from "./harness/mock-relay.js";
import { createMockViewer } from "./harness/mock-viewer.js";
import { buildHeartbeat } from "./harness/builders.js";
import type { TestServer } from "./harness/types.js";

let server: TestServer;

beforeAll(async () => {
    server = await createTestServer();
});

afterAll(async () => {
    await server.cleanup();
});

test("relay → viewer receives heartbeat", async () => {
    // 1. Create a relay connection (simulates a running agent)
    const relay = await createMockRelay(server);
    const { sessionId, token } = await relay.registerSession({ cwd: "/my-project" });

    // 2. Create a viewer watching that session
    const viewer = await createMockViewer(server, sessionId);

    // 3. Emit an event through the relay
    relay.emitEvent(sessionId, token, buildHeartbeat({ active: true }), 0);

    // 4. Viewer receives the event
    const received = await viewer.waitForEvent(
        (evt) => (evt as any).type === "heartbeat",
    );
    expect((received as any).active).toBe(true);

    // Cleanup
    await viewer.disconnect();
    relay.emitSessionEnd(sessionId, token);
    await relay.disconnect();
});
```

---

## Architecture

```
┌────────────────────────────────────────────────────────┐
│                  createTestServer()                    │
│                                                        │
│  SQLite (temp dir)  +  Redis  +  Socket.IO  +  HTTP   │
│  better-auth session + pre-created test user          │
└──────────────────────────┬─────────────────────────────┘
                           │
         ┌─────────────────┼─────────────────┐
         │                 │                 │
   /runner ns        /relay ns         /viewer ns  /hub ns
         │                 │                 │
  MockRunner         MockRelay         MockViewer  MockHubClient
  (auth: apiKey)    (auth: apiKey)    (auth: cookie) (auth: cookie)
```

**Data flow for a typical event test:**

1. `createTestServer()` spins up all infrastructure and provisions a test user.
2. `createMockRelay()` connects to `/relay` using the server's API key and
   registers a session. The server returns a `sessionId` + `token`.
3. `createMockViewer()` connects to `/viewer` with the pre-created session
   cookie, joins the session.
4. `relay.emitEvent(sessionId, token, event, seq)` sends an agent event. The
   server buffers it in Redis and fans it out to all viewers.
5. `viewer.waitForEvent(predicate)` blocks until a matching event arrives.
6. `createMockHubClient()` connects to `/hub` and receives a live `SessionInfo[]`
   snapshot plus incremental `session_added` / `session_removed` updates.

**TestScenario** wraps this flow in a fluent builder:

```
new TestScenario()
  .setup()              → createTestServer()
  .addRunner()          → createMockRunner()
  .addSession()         → createMockRelay() + registerSession()
  .addViewer(sessionId) → createMockViewer()
  .addHub()             → createMockHubClient()
  .teardown()           → disconnect all, cleanup server
```

---

## API Reference

### `createTestServer()`

**File:** `harness/server.ts`

Creates a fully-initialized PizzaPi server on an ephemeral port with:
- A temporary SQLite database
- Redis pub/sub adapter (uses `PIZZAPI_REDIS_URL` or `redis://localhost:6379`)
- Socket.IO with all namespaces registered
- A pre-created test user with an API key and session cookie

```ts
import { createTestServer } from "./harness/server.js";

const server = await createTestServer(opts?);
```

#### Options (`TestServerOptions`)

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `baseUrl` | `string` | `http://127.0.0.1:{port}` | Override the base URL (useful for proxy testing) |
| `trustedOrigins` | `string[]` | `[]` | Extra origins to add to CORS trusted list |
| `disableSignupAfterFirstUser` | `boolean` | `true` | Disables multi-user signup (keeps test isolation) |

#### Return type (`TestServer`)

| Field | Type | Description |
|-------|------|-------------|
| `port` | `number` | Ephemeral port the HTTP server is listening on |
| `baseUrl` | `string` | `http://127.0.0.1:{port}` |
| `io` | `SocketIOServer` | The Socket.IO server instance |
| `apiKey` | `string` | API key for the pre-created test user |
| `userId` | `string` | User ID of the pre-created test user |
| `userName` | `string` | Display name (`"Test User"`) |
| `userEmail` | `string` | Email (`"testuser@pizzapi-harness.test"`) |
| `sessionCookie` | `string` | `Set-Cookie` string for viewer/hub auth |
| `fetch(path, init?)` | `Promise<Response>` | Authenticated HTTP helper (injects API key + cookie) |
| `cleanup()` | `Promise<void>` | Shuts down Socket.IO, Redis, HTTP, and removes temp DB |

#### Singleton constraint

**Only one `TestServer` may be active at a time.** PizzaPi's `auth.ts` and
`sio-state.ts` use module-level singletons. Creating a second server while the
first is alive throws:

```
Error: [test-harness] A TestServer is already active.
       Call cleanup() on the existing server before creating another.
```

The recommended pattern — used in `integration.test.ts` — is to share a single
server across all suites in a file:

```ts
let server: TestServer;

beforeAll(async () => { server = await createTestServer(); });
afterAll(async () => { await server.cleanup(); });
```

Each test suite then creates its own `TestScenario` and calls `setServer(server)`.

#### Cleanup

Always call `cleanup()` in `afterAll`. The cleanup:
- Closes the Socket.IO server (which implicitly closes the HTTP server)
- Quits the state Redis client
- Quits the pub/sub Redis clients
- Removes the temporary SQLite directory
- Releases the singleton guard so another server can be created

---

### `createMockRunner()`

**File:** `harness/mock-runner.ts`

Connects to the server's `/runner` namespace, sends a `register_runner` message,
and waits for `runner_registered` confirmation.

```ts
import { createMockRunner } from "./harness/mock-runner.js";

const runner = await createMockRunner(server, opts?);
```

#### Options (`MockRunnerOptions`)

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `apiKey` | `string` | `server.apiKey` | Override to test auth failures (pass an invalid key) |
| `runnerId` | `string` | Random UUID | Client-side hint; server assigns the final ID |
| `name` | `string` | `"test-runner"` | Runner display name |
| `roots` | `string[]` | `["/tmp/test"]` | Filesystem roots the runner exposes |
| `skills` | `RunnerSkill[]` | `[]` | Runner skills |
| `agents` | `RunnerAgent[]` | `[]` | Runner agents |
| `plugins` | `RunnerPlugin[]` | `[]` | Runner plugins |
| `hooks` | `RunnerHook[]` | `[]` | Runner hooks |
| `version` | `string` | `"1.0.0-test"` | Runner version string |
| `platform` | `string` | `"linux"` | Platform identifier |

#### `MockRunner` interface

```ts
interface MockRunner {
    runnerId: string;       // Server-assigned runner ID
    socket: ClientSocket;   // Raw socket.io-client socket

    // Session lifecycle helpers
    emitSessionReady(sessionId: string): void;
    emitSessionError(sessionId: string, error: string): void;
    emitSessionEvent(sessionId: string, event: unknown): void;
    emitSessionEnded(sessionId: string): void;

    // Request handler registration
    onSkillRequest(handler: (data: unknown) => unknown): void;
    onFileRequest(handler: (data: unknown) => unknown): void;

    // Utilities
    waitForEvent(eventName: string, timeout?: number): Promise<unknown>;
    disconnect(): Promise<void>;
}
```

**Note:** `runnerId` is set from the server's `runner_registered` response — not
from `opts.runnerId`. The server may generate a new ID regardless of the hint.

---

### `createMockRelay()`

**File:** `harness/mock-relay.ts`

Connects to the server's `/relay` namespace (API key auth). Provides helpers for
registering sessions and emitting the full range of agent protocol events.

```ts
import { createMockRelay } from "./harness/mock-relay.js";

const relay = await createMockRelay(server, opts?);
```

#### `MockRelay` interface

```ts
interface MockRelay {
    socket: ClientSocket;

    registerSession(opts?: {
        sessionId?: string;      // Optional deterministic ID
        cwd?: string;            // Default: "/tmp/mock-session"
        ephemeral?: boolean;     // Default: true
        collabMode?: boolean;    // Default: false
        sessionName?: string | null;
        parentSessionId?: string | null;
    }): Promise<{ sessionId: string; token: string; shareUrl: string }>;

    emitEvent(sessionId: string, token: string, event: unknown, seq?: number): void;
    emitSessionEnd(sessionId: string, token: string): void;

    emitTrigger(data: {
        token: string;
        trigger: { type, sourceSessionId, targetSessionId, payload, deliverAs, expectsResponse, triggerId, ts };
    }): void;

    emitTriggerResponse(data: {
        token: string;
        triggerId: string;
        response: string;
        action?: string;
        targetSessionId: string;
    }): void;

    emitSessionMessage(data: {
        token: string;
        targetSessionId: string;
        message: string;
        deliverAs?: "input";
    }): void;

    waitForEvent(eventName: string, timeout?: number): Promise<unknown>;
    disconnect(): Promise<void>;
}
```

**`registerSession()` is serial.** Concurrent calls on the same relay socket are
queued; only one registration is in-flight at a time. This prevents both callers
from racing to consume the first `registered` event.

**`disconnect()` includes a 100 ms settle pause** after the socket-level
disconnect to allow the underlying TCP connection to tear down before
`cleanup()` / `io.close()` is called.

---

### `createMockViewer()`

**File:** `harness/mock-viewer.ts`

Connects to the server's `/viewer` namespace using cookie-based auth
(`server.sessionCookie`), joins the specified session, and auto-collects
all incoming events.

```ts
import { createMockViewer } from "./harness/mock-viewer.js";

const viewer = await createMockViewer(server, sessionId, opts?);
```

#### Options (`MockViewerOptions`)

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `connectTimeout` | `number` | `5000` | Milliseconds to wait for the `connected` event |
| `maxAttempts` | `number` | `2` | Retry count on `connect_error: unauthorized` (better-auth cold-start) |

#### `MockViewer` interface

```ts
interface MockViewer {
    socket: ClientSocket<ViewerServerToClientEvents, ViewerClientToServerEvents>;
    sessionId: string;

    // Send actions
    sendInput(text: string, attachments?: Attachment[]): void;
    sendExec(id: string, command: string): void;
    sendTriggerResponse(triggerId: string, response: string, targetSessionId: string, action?: string): void;
    sendResync(): void;

    // Received events (auto-buffered from connect)
    getReceivedEvents(): ReceivedEvent[];  // Returns a snapshot (copy)
    clearEvents(): void;

    // Async helpers
    waitForEvent(predicate?: (evt: unknown) => boolean, timeout?: number): Promise<unknown>;
    waitForDisconnected(timeout?: number): Promise<string>;

    disconnect(): Promise<void>;
}

interface ReceivedEvent {
    event: unknown;
    seq?: number;
    replay?: boolean;   // true when event came from sendResync()
}
```

**All listeners are attached before the handshake completes.** This prevents the
race where events emitted between the `connected` event and subsequent listener
registration are dropped.

**`waitForEvent()` checks the buffer first.** If a matching event was already
received before `waitForEvent()` is called, it resolves immediately.

---

### `createMockHubClient()`

**File:** `harness/mock-hub.ts`

Connects to the server's `/hub` namespace using cookie-based auth, waits for the
initial `sessions` snapshot, then continuously maintains a live `sessions` list
via incremental `session_added` / `session_removed` / `session_status` updates.

```ts
import { createMockHubClient } from "./harness/mock-hub.js";

const hub = await createMockHubClient(server, opts?);
```

#### Options (`MockHubClientOptions`)

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `connectTimeout` | `number` | `5000` | Milliseconds to wait for the initial `sessions` snapshot |
| `maxAttempts` | `number` | `2` | Retry count on `connect_error: unauthorized` |

#### `MockHubClient` interface

```ts
interface MockHubClient {
    socket: ClientSocket<HubServerToClientEvents, HubClientToServerEvents>;
    sessions: SessionInfo[];  // Live — mutated as events arrive

    waitForSessionAdded(
        predicate?: (s: SessionInfo) => boolean,
        timeout?: number,  // Default: 5000
    ): Promise<SessionInfo>;

    waitForSessionRemoved(sessionId: string, timeout?: number): Promise<void>;

    waitForSessionStatus(
        sessionId: string,
        predicate?: (data: unknown) => boolean,
        timeout?: number,
    ): Promise<unknown>;

    subscribeSessionMeta(sessionId: string): void;
    unsubscribeSessionMeta(sessionId: string): void;

    disconnect(): Promise<void>;
}
```

**`hub.sessions` is a live array.** It's seeded from the initial snapshot and
kept current by server broadcasts. Check it at any time for the current state.

**`waitForSessionAdded()` checks the buffer first.** If a matching session is
already in `hub.sessions` when called, it resolves immediately.

---

### Event Builders

**File:** `harness/builders.ts`

Pure data builders — no server dependency. All functions are importable
independently.

#### `buildHeartbeat(overrides?)`

```ts
buildHeartbeat({ active: true, sessionName: "my-session" })
// → { type: "heartbeat", active: true, sessionName: "my-session", ... }
```

Builds a heartbeat event. Heartbeats drive hub `session_status` updates (session
name, model, active flag, working directory).

#### `buildAssistantMessage(text, overrides?)`

```ts
buildAssistantMessage("I found 3 files.")
// → { type: "message_update", role: "assistant", content: [{ type: "text", text: "..." }], messageId: "msg_1_abc" }
```

#### `buildToolUseEvent(toolName, input, toolCallId?)`

```ts
buildToolUseEvent("bash", { command: "ls -la" })
// → { type: "tool_use", id: "tool_2_xyz", name: "bash", input: { command: "ls -la" } }
```

#### `buildToolResultEvent(toolCallId, output)`

```ts
buildToolResultEvent("tool_2_xyz", "file1.ts\nfile2.ts")
// → { type: "tool_result", tool_use_id: "tool_2_xyz", content: [{ type: "text", text: "..." }] }
```

#### `buildConversation(turns)`

Higher-level builder. Converts a human-readable turn spec into relay-compatible events:

```ts
const events = buildConversation([
    { role: "assistant", text: "Let me check the files." },
    { role: "assistant", toolCall: { name: "bash", input: { command: "ls" } } },
    { role: "tool", toolCallId: "...", result: "file1.ts" },
    { role: "user", text: "Thanks" },  // → harness:user_turn marker (skip when emitting)
]);
```

> **Important:** `user` turns produce a `harness:user_turn` marker that is **not** a real
> protocol event. Filter them out before calling `relay.emitEvent()`.
> `TestScenario.sendConversation()` does this automatically.

#### `buildSessionInfo(overrides?)` / `buildRunnerInfo(overrides?)`

Construct complete `SessionInfo` / `RunnerInfo` objects for assertion fixtures.

#### `buildMetaState(overrides?)`

Returns `defaultMetaState()` merged with overrides. Use with `buildTodoList()`:

```ts
const meta = buildMetaState({
    todoList: buildTodoList([
        { text: "Step 1", status: "done" },
        { text: "Step 2" },
    ]),
});
```

#### `buildTodoList(items)`

```ts
buildTodoList([{ text: "Do X" }, { text: "Do Y", status: "in_progress" }])
// → [{ id: 1, text: "Do X", status: "pending" }, { id: 2, text: "Do Y", status: "in_progress" }]
```

---

### `TestScenario`

**File:** `harness/scenario.ts`

A fluent BDD builder. Manages creation order, resource tracking, and cleanup.
Preferred for tests that need more than one harness component.

#### Lifecycle

```ts
const scenario = new TestScenario();
await scenario.setup();       // creates its own TestServer
// OR
scenario.setServer(server);   // injects an existing server (scenario won't clean it up)

// ... add components ...

await scenario.teardown();    // disconnects all components; cleans up server if owned
// OR
await scenario.reset();       // disconnects components only (keeps the server)
```

#### Component builders

```ts
const runner  = await scenario.addRunner(opts?);         // MockRunner
const session = await scenario.addSession(opts?);        // ScenarioSession
const viewer  = await scenario.addViewer(sessionId, opts?); // MockViewer
const hub     = await scenario.addHub(opts?);            // MockHubClient
```

**`addSession()` uses an isolated relay** (`forceNew: true`) to prevent Manager
sharing with hub/viewer sockets — a critical correctness requirement. See
[Troubleshooting](#troubleshooting) for why this matters.

#### `ScenarioSession`

```ts
interface ScenarioSession {
    sessionId: string;
    token: string;
    shareUrl: string;
    relay: MockRelay;  // The underlying relay socket for direct emission
}
```

#### Scenario actions

```ts
// Send a full conversation through the relay for sessions[0]
await scenario.sendConversation(0, [
    { role: "assistant", text: "Working on it..." },
    { role: "assistant", toolCall: { name: "bash", input: { command: "ls" } } },
]);

// Signal session end for sessions[0]
await scenario.endSession(0);
```

#### Accessors

```ts
scenario.server    // TestServer (throws if not initialized)
scenario.runners   // MockRunner[]
scenario.sessions  // ScenarioSession[]
scenario.viewers   // MockViewer[]
scenario.hub       // MockHubClient | null
```

---

## BDD Patterns

The harness is designed for **Given/When/Then** style tests. Use `TestScenario`
for setup, emit events in the "When" step, and await assertions in "Then".

```ts
test("session ends → hub sees removal (Given/When/Then)", async () => {
    const scenario = new TestScenario();
    scenario.setServer(server);

    try {
        // GIVEN: a hub watching sessions and a registered session
        const hub = await scenario.addHub();
        const addedWaiter = hub.waitForSessionAdded(undefined, 8_000); // set up BEFORE creating session
        const session = await scenario.addSession({ cwd: "/project" });
        await addedWaiter; // confirm hub saw the session appear

        expect(hub.sessions.some((s) => s.sessionId === session.sessionId)).toBe(true);

        // WHEN: the session ends
        const removalWaiter = hub.waitForSessionRemoved(session.sessionId, 5_000);
        session.relay.emitSessionEnd(session.sessionId, session.token);

        // THEN: the hub reflects the removal
        await removalWaiter;
        expect(hub.sessions.find((s) => s.sessionId === session.sessionId)).toBeUndefined();

    } finally {
        await scenario.reset();
    }
});
```

### Hub-before-session ordering (critical)

Always connect the hub **before** creating a session, and call
`waitForSessionAdded()` **before** creating the session. Waiting for the
`waitForSessionAdded` promise after session creation is fine — the waiter is
already set up and cannot miss the event:

```ts
// ✅ Correct — waiter registered before session exists
const hub = await scenario.addHub();
const waiter = hub.waitForSessionAdded(undefined, 8_000); // register BEFORE session
const session = await scenario.addSession({ cwd: "/project" });
await waiter;  // resolves with the SessionInfo

// ❌ Wrong — may miss the session_added event
const hub = await scenario.addHub();
const session = await scenario.addSession({ cwd: "/project" });
const waiter = hub.waitForSessionAdded();  // too late — event already fired
await waiter;  // may time out
```

---

## Common Recipes

### Testing a REST Endpoint

Use `server.fetch()` — it injects the API key and session cookie automatically:

```ts
test("GET /api/runners returns registered runners", async () => {
    const scenario = new TestScenario();
    scenario.setServer(server);

    try {
        const runner = await scenario.addRunner({ name: "my-runner" });

        const res = await server.fetch("/api/runners");
        expect(res.status).toBe(200);

        const data = await res.json() as { runners: Array<{ runnerId: string; name: string }> };
        const found = data.runners.find((r) => r.runnerId === runner.runnerId);
        expect(found?.name).toBe("my-runner");
    } finally {
        await scenario.reset();
    }
});
```

For unauthenticated requests, use plain `fetch()` with `server.baseUrl`:

```ts
const res = await fetch(`${server.baseUrl}/api/runners`);
expect(res.status).toBe(401);
```

---

### Testing WebSocket Event Flow End-to-End

```ts
test("relay → viewer: heartbeat flows through", async () => {
    const scenario = new TestScenario();
    scenario.setServer(server);

    try {
        const session = await scenario.addSession({ cwd: "/project" });
        const viewer  = await scenario.addViewer(session.sessionId);
        viewer.clearEvents();

        // Emit a heartbeat through the relay
        const hb = buildHeartbeat({ active: true, sessionName: "demo" });
        session.relay.emitEvent(session.sessionId, session.token, hb, 0);

        // Wait for it to arrive at the viewer
        const received = await viewer.waitForEvent(
            (evt) => (evt as any).type === "heartbeat",
            5_000,
        );
        expect((received as any).sessionName).toBe("demo");
    } finally {
        await scenario.reset();
    }
});
```

---

### Testing Multi-Session Scenarios

```ts
test("events for one session don't bleed into another", async () => {
    const scenario = new TestScenario();
    scenario.setServer(server);

    try {
        const sessA = await scenario.addSession({ cwd: "/project-a" });
        const sessB = await scenario.addSession({ cwd: "/project-b" });

        const viewerA = await scenario.addViewer(sessA.sessionId);
        const viewerB = await scenario.addViewer(sessB.sessionId);

        // Emit only to session A
        sessA.relay.emitEvent(sessA.sessionId, sessA.token,
            buildHeartbeat({ sessionName: "only-a" }), 0);

        // Viewer A receives it
        await viewerA.waitForEvent((e) => (e as any).sessionName === "only-a");

        // Give viewer B a moment to receive anything
        await new Promise<void>((r) => setTimeout(r, 200));

        // Viewer B sees nothing from session A
        const bleed = viewerB.getReceivedEvents().filter(
            (e) => (e.event as any)?.sessionName === "only-a"
        );
        expect(bleed).toHaveLength(0);
    } finally {
        await scenario.reset();
    }
});
```

---

### Testing Conversation Replay

```ts
test("late viewer receives stored events via resync", async () => {
    const scenario = new TestScenario();
    scenario.setServer(server);

    try {
        // Send events BEFORE the viewer connects
        const session = await scenario.addSession({ cwd: "/replay-test" });
        session.relay.emitEvent(session.sessionId, session.token,
            buildHeartbeat({ active: true }), 0);
        await new Promise<void>((r) => setTimeout(r, 400)); // wait for server to buffer

        // Late viewer connects and requests a resync
        const viewer = await scenario.addViewer(session.sessionId);
        viewer.clearEvents();
        viewer.sendResync();

        await new Promise<void>((r) => setTimeout(r, 800));

        // Events should have arrived, flagged as replay
        const events = viewer.getReceivedEvents();
        expect(events.length).toBeGreaterThan(0);
        expect(events.some((e) => e.replay === true)).toBe(true);
    } finally {
        await scenario.reset();
    }
});
```

---

### Testing Inter-Session Triggers

Triggers are messages a child session sends to a parent (e.g., "review my plan"):

```ts
test("child emits trigger → parent relay receives it", async () => {
    const scenario = new TestScenario();
    scenario.setServer(server);

    try {
        const parent = await scenario.addSession({ cwd: "/parent" });
        const child  = await scenario.addSession({
            cwd: "/child",
            parentSessionId: parent.sessionId,
        });

        const triggerId = `trigger-${Date.now()}`;

        // Listen on the PARENT relay BEFORE emitting — critical ordering
        const deliveryPromise = parent.relay.waitForEvent("session_trigger", 5_000);

        child.relay.emitTrigger({
            token: child.token,
            trigger: {
                type: "plan_review",
                sourceSessionId: child.sessionId,
                targetSessionId: parent.sessionId,
                payload: { steps: ["Step 1", "Step 2"] },
                deliverAs: "steer",
                expectsResponse: true,
                triggerId,
                ts: new Date().toISOString(),
            },
        });

        const delivered = await deliveryPromise;
        const trigger = (delivered as any).trigger;
        expect(trigger.triggerId).toBe(triggerId);
        expect(trigger.sourceSessionId).toBe(child.sessionId);
    } finally {
        await scenario.reset();
    }
});
```

---

## Sandbox Mode

The harness includes an interactive **sandbox** — a long-running dev server
you can open in your browser to test UI/server changes with realistic mock
data, without deploying or spinning up the full stack.

### Quick start

```bash
cd packages/server
bun run sandbox
```

This:

1. Starts a real PizzaPi server on an ephemeral port (SQLite + Redis + Socket.IO + static UI)
2. Pre-populates 3 mock sessions with heartbeats, models, and a streamed conversation
3. Prints login credentials for the browser
4. Drops you into an interactive REPL

### REPL commands

| Command | Description |
|---------|-------------|
| `session [name]` | Add a new mock session (random model/cwd) |
| `chat <n> [scenario]` | Stream a conversation into session n (`review`, `tools`, `subagent`) |
| `child <n>` | Spawn a child session linked to session n |
| `end <n>` | End session n |
| `heartbeat <n> [bool]` | Send heartbeat (active=true/false) |
| `flood [count]` | Create N sessions at once (stress-test the dashboard) |
| `status` | Show all sessions with share URLs |
| `quit` | Clean shutdown |

### When to use it

- Testing UI changes on a feature branch without deploying `pizza web`
- Verifying dashboard behavior with many sessions
- Testing conversation viewer rendering with different event types
- Checking real-time Socket.IO updates (add sessions from REPL, watch them appear)
- Stress-testing with `flood 50` to see how the UI handles many sessions

---

## Troubleshooting

### Redis not running

```
Error: connect ECONNREFUSED 127.0.0.1:6379
```

Start Redis locally:
```bash
redis-server
# or with Docker:
docker run -p 6379:6379 redis:latest
# or via Docker Compose (project root):
docker compose up redis
```

Or override the URL:
```bash
PIZZAPI_REDIS_URL=redis://my-host:6379 bun test
```

---

### Singleton guard error

```
Error: [test-harness] A TestServer is already active.
       Call cleanup() on the existing server before creating another.
```

You called `createTestServer()` while a previous server's `cleanup()` was not
called. Fix: ensure `afterAll` always calls `cleanup()` and runs before the next
suite's `beforeAll`.

The most common cause is a test file that crashes before `afterAll` runs.
Restarting the test runner (fresh Bun process) clears the singleton.

---

### Cleanup hangs

If `teardown()` or `cleanup()` hangs, the most likely cause is an open
WebSocket connection that Socket.IO is waiting to drain. `TestScenario.teardown()`
calls `io.disconnectSockets(true)` and `httpServer.closeAllConnections()` before
`cleanup()` to force-close lingering connections.

If you're calling `cleanup()` directly (without `TestScenario`), do this first:
```ts
await server.io.disconnectSockets(true);
await new Promise<void>((r) => setTimeout(r, 100));
await server.cleanup();
```

---

### Viewer gets `connect_error: unauthorized`

The first connection to a freshly-started server may fail because better-auth
lazily initializes its prepared statements. Both `createMockViewer()` and
`createMockHubClient()` automatically retry up to `maxAttempts` times (default
`2`) with a 150 ms delay. If you see persistent failures, increase `maxAttempts`:

```ts
const viewer = await createMockViewer(server, sessionId, { maxAttempts: 3 });
```

---

### Hub never receives `session_added`

Almost always caused by the **hub-after-session** anti-pattern. Register the
`waitForSessionAdded()` waiter **before** creating the session. See
[Hub-before-session ordering](#hub-before-session-ordering-critical).

---

### Relay hangs on connect (indefinite — no connect_error)

This is the **Manager sharing** bug. `socket.io-client` caches Managers by base
URL. Hub sockets authenticate via HTTP cookies (`extraHeaders`); relay sockets
authenticate via `auth: { apiKey }`. When they share a Manager, the relay
namespace handshake travels over a WebSocket connection authenticated with hub
cookies — the server's relay middleware silently drops the connection.

**Fix:** Always create relay sockets with `forceNew: true`. `TestScenario.addSession()`
does this automatically. If you're using `createMockRelay()` directly alongside
a hub, pass `forceNew: true` in the options:

```ts
const relay = await createMockRelay(server, { forceNew: true });
```

Or use `TestScenario` instead, which sets this automatically.

---

### Socket.IO timing: events arrive before listeners

The harness attaches all event listeners **before** awaiting the connection
handshake. This is intentional — it's the correct pattern. Do not reorder
listener attachment after `await`:

```ts
// ✅ Correct
const waiter = hub.waitForSessionAdded(); // register waiter
const session = await scenario.addSession(); // then create
await waiter;

// ❌ Wrong
const session = await scenario.addSession();
const waiter = hub.waitForSessionAdded(); // too late
await waiter; // may time out
```

---

## Known Limitations

1. **Singleton server constraint.** Only one `TestServer` may be active at a
   time (module-level auth and Socket.IO state singletons). Tests in the same
   file must share a single server via `setServer()`. Tests across different
   files **must not** share a `TestServer` — Bun runs test files in parallel by
   default, so each file that calls `createTestServer()` will race for the
   module-level singleton and corrupt each other's state. Either run harness
   test files with `--serial` / `bun test --timeout ... packages/server/tests/harness`
   in a dedicated invocation, or ensure each file creates and cleans up its own
   isolated server instance and that the test runner does not run those files
   concurrently. Use `describe.serial` within a file to prevent intra-file
   parallelism.

2. **`sleep`-based waits in some tests.** Certain assertions use
   `setTimeout(r, N)` to wait for server-side async operations (Redis cache
   warmup, event buffering, hub broadcast propagation). These are inherently
   timing-sensitive. If tests are flaky on a slow CI machine, increase the
   sleep durations.

3. **Hub snapshot race on first relay connection.** On a fresh server, the
   relay namespace initializes a Redis cache client asynchronously on its first
   connection. During this window (< 1 s), hub and viewer sockets can be
   unexpectedly disconnected. `integration.test.ts` works around this with a
   warmup relay session in `beforeAll`. If you write a new test file with a
   fresh server, include the same warmup pattern or add a `setTimeout(r, 1500)`
   after the first relay session.

4. **`buildConversation()` user turns are not real events.** `{ role: "user" }`
   turns produce a `harness:user_turn` marker object. It must be filtered before
   emitting to the relay. `TestScenario.sendConversation()` does this for you.

5. **Relay serial registration lock.** `registerSession()` on a `MockRelay`
   socket is serialized — only one call is in-flight at a time. Concurrent
   registrations on the same relay socket are safe but will execute serially.
   For parallel session creation, use `TestScenario.addSession()` which creates
   an isolated relay per session.

6. **No `MockRunner` → session routing tests.** The harness does not yet
   simulate the full runner↔session dispatch flow (i.e., the server sending a
   `start_session` command to a runner and the runner responding with
   `session_ready`). Such flows require orchestrating runner event handlers.
   See `MockRunner.emitSessionReady()` and `MockRunner.onSkillRequest()` for
   the building blocks.

---

## Real-World Example

See [`integration.test.ts`](./integration.test.ts) for a complete test suite
covering:

- Full session lifecycle (relay → viewer event flow, session end notification)
- Runner registration and REST API verification
- Multi-runner and multi-session isolation
- Hub session tracking (add/remove/status)
- Conversation replay via `sendResync()`
- Inter-session trigger routing
- Concurrent `registerSession()` correctness
- Session meta state (`buildTodoList`, `buildMetaState`)
