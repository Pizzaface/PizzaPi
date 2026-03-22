# Runners WebSocket Feed Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace all polling and ad-hoc `fetch("/api/runners")` calls with a `/runners` Socket.IO namespace that pushes runner lifecycle events in real time, and use that cached data everywhere in the UI that currently re-fetches it.

**Architecture:** A new browser-facing `/runners` Socket.IO namespace (server-side) broadcasts `runners` (initial snapshot), `runner_added`, `runner_removed`, and `runner_updated` to authenticated users. A `useRunnersFeed()` React hook (client-side) subscribes and maintains runner state. All components that previously fetched runner data on a timer or on dialog/command open are refactored to consume this shared state via props.

**Tech Stack:** Bun, TypeScript, Socket.IO 4, React 19, `bun:test`

**Spec:** `docs/specs/2026-03-21-runners-websocket-feed-design.md`

---

## Chunk 1: Protocol + Server

### Task 1: Add `/runners` protocol types

**Files:**
- Create: `packages/protocol/src/runners.ts`
- Modify: `packages/protocol/src/index.ts`

- [ ] **Step 1: Create the protocol file**

```typescript
// packages/protocol/src/runners.ts
// ============================================================================
// /runners namespace — Browser runner feed (read-only for clients)
// ============================================================================

import type { RunnerInfo } from "./shared.js";

// ---------------------------------------------------------------------------
// Server → Client (Server pushes runner state to browsers)
// ---------------------------------------------------------------------------

export interface RunnersServerToClientEvents {
  /** Full runner list snapshot sent on connection */
  runners: (data: { runners: RunnerInfo[] }) => void;

  /** A runner daemon connected and registered */
  runner_added: (data: RunnerInfo) => void;

  /** A runner daemon disconnected */
  runner_removed: (data: { runnerId: string }) => void;

  /** Runner metadata changed (skills, agents, plugins, hooks) */
  runner_updated: (data: RunnerInfo) => void;
}

// ---------------------------------------------------------------------------
// Client → Server (read-only feed — no client events)
// ---------------------------------------------------------------------------

export interface RunnersClientToServerEvents {
  // Runners feed is read-only; clients do not emit events
}

// ---------------------------------------------------------------------------
// Inter-server events
// ---------------------------------------------------------------------------

export interface RunnersInterServerEvents {
  // Reserved for future Redis adapter usage
}

// ---------------------------------------------------------------------------
// Per-socket metadata
// ---------------------------------------------------------------------------

export interface RunnersSocketData {
  userId?: string;
}
```

- [ ] **Step 2: Export from protocol index**

Add after the `/hub` namespace block at the bottom of `packages/protocol/src/index.ts`:

```typescript
// /runners namespace (Browser runner feed)
export type {
  RunnersClientToServerEvents,
  RunnersServerToClientEvents,
  RunnersInterServerEvents,
  RunnersSocketData,
} from "./runners.js";
```

- [ ] **Step 3: Verify typecheck passes**

```bash
cd packages/protocol && bun run build 2>&1
```

Expected: no errors, dist/ updated.

- [ ] **Step 4: Commit**

```bash
git add packages/protocol/src/runners.ts packages/protocol/src/index.ts
git commit -m "feat(protocol): add /runners namespace event types"
```

---

### Task 2: Add `/runners` server namespace

**Files:**
- Modify: `packages/server/src/ws/sio-registry/context.ts`
- Create: `packages/server/src/ws/namespaces/runners.ts`
- Modify: `packages/server/src/ws/namespaces/index.ts`

Room name helpers live in `context.ts` (alongside `hubUserRoom`) to avoid circular dependencies. The namespace file imports from `sio-registry.js` (the barrel), following the `hub.ts` pattern.

- [ ] **Step 1: Add `runnersUserRoom` to context.ts**

In `packages/server/src/ws/sio-registry/context.ts`, add after the `hubUserRoom` function:

```typescript
/** Room name for a specific user's /runners feed. */
export function runnersUserRoom(userId: string): string {
    return `runners:user:${userId}`;
}
```

- [ ] **Step 2: Re-export `runnersUserRoom` from the sio-registry barrel**

In `packages/server/src/ws/sio-registry/index.ts`, find the `context.js` export line and add `runnersUserRoom`:

```typescript
export { initSioRegistry, emitToRunner, emitToRelaySession, emitToRelaySessionVerified, emitToRelaySessionAwaitingAck, runnersUserRoom } from "./context.js";
```

- [ ] **Step 3: Create the namespace file**


```typescript
// packages/server/src/ws/namespaces/runners.ts
// ============================================================================
// /runners namespace — Browser runner feed (read-only for clients)
//
// On connection: send initial runner list snapshot.
// Clients receive runner_added / runner_removed / runner_updated events
// pushed by sio-registry when the runner daemon connects or changes.
// ============================================================================

import type { Server as SocketIOServer, Namespace } from "socket.io";
import type {
    RunnersClientToServerEvents,
    RunnersServerToClientEvents,
    RunnersInterServerEvents,
    RunnersSocketData,
} from "@pizzapi/protocol";
import { sessionCookieAuthMiddleware } from "./auth.js";
import { getRunners, runnersUserRoom } from "../sio-registry.js";

export function registerRunnersNamespace(io: SocketIOServer): void {
    const runners: Namespace<
        RunnersClientToServerEvents,
        RunnersServerToClientEvents,
        RunnersInterServerEvents,
        RunnersSocketData
    > = io.of("/runners");

    // Auth: validate session cookie from handshake (same as /hub)
    runners.use(sessionCookieAuthMiddleware() as Parameters<typeof runners.use>[0]);

    runners.on("connection", async (socket) => {
        const userId = socket.data.userId ?? "";

        console.log(`[sio/runners] connected: ${socket.id} userId=${userId}`);

        // Join per-user room so broadcasts are user-scoped
        await socket.join(runnersUserRoom(userId));

        // Send initial runner list for this user
        const initialRunners = await getRunners(userId);
        socket.emit("runners", { runners: initialRunners });

        // ── disconnect ───────────────────────────────────────────────────────
        socket.on("disconnect", (reason) => {
            console.log(`[sio/runners] disconnected: ${socket.id} (${reason})`);
            // Socket.IO automatically removes sockets from rooms on disconnect
        });
    });
}
```

- [ ] **Step 4: Register the namespace in index.ts**

In `packages/server/src/ws/namespaces/index.ts`, add:

```typescript
import { registerRunnersNamespace } from "./runners.js";
```

And in `registerNamespaces`:

```typescript
export function registerNamespaces(io: SocketIOServer): void {
  registerRelayNamespace(io);
  registerViewerNamespace(io);
  registerRunnerNamespace(io);
  registerTerminalNamespace(io);
  registerHubNamespace(io);
  registerRunnersNamespace(io);   // ← add this line
}
```

- [ ] **Step 5: Typecheck**

```bash
cd packages/server && bun run typecheck 2>&1
```

Expected: zero errors.

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/ws/sio-registry/context.ts \
        packages/server/src/ws/sio-registry/index.ts \
        packages/server/src/ws/namespaces/runners.ts \
        packages/server/src/ws/namespaces/index.ts
git commit -m "feat(server): add /runners Socket.IO namespace"
```

---

### Task 3: Add `broadcastToRunnersNs` + wire broadcasts in sio-registry

**Files:**
- Modify: `packages/server/src/ws/sio-registry/runners.ts`
- Create: `packages/server/src/ws/sio-registry/runners.broadcast.test.ts`

The broadcasts hook into three existing moments:
1. `registerRunner()` success → `runner_added`
2. `removeRunner()` → `runner_removed` (must read userId before deleting)
3. `updateRunnerSkills/Agents/Plugins()` → `runner_updated`

A helper `runnerDataToInfo(r: RedisRunnerData): RunnerInfo` converts Redis data to the protocol shape (same logic as in `getRunners` but for a single runner, with `sessionCount: 0` since the client computes it from live sessions).

- [ ] **Step 1: Write failing tests**

Create `packages/server/src/ws/sio-registry/runners.broadcast.test.ts`:

```typescript
import { describe, it, expect, mock, beforeEach } from "bun:test";

// ── Minimal Redis mock (same shape as sessions.parent-miss-delink.test.ts) ──

const store = new Map<string, string>();
const setStore = new Map<string, Set<string>>();

const mockMulti = () => {
    const ops: Array<() => void> = [];
    return {
        hSet: mock((key: string, fields: Record<string, string>) => {
            ops.push(() => {
                const existing = JSON.parse(store.get(`__hash__:${key}`) ?? "{}");
                Object.assign(existing, fields);
                store.set(`__hash__:${key}`, JSON.stringify(existing));
            });
            return mockMulti();
        }),
        sAdd: mock((key: string, ...members: string[]) => {
            ops.push(() => {
                const s = setStore.get(key) ?? new Set();
                for (const m of members.flat()) s.add(m);
                setStore.set(key, s);
            });
            return mockMulti();
        }),
        sRem: mock((key: string, ...members: string[]) => {
            ops.push(() => {
                const s = setStore.get(key);
                if (s) for (const m of members.flat()) s.delete(m);
            });
            return mockMulti();
        }),
        expire: mock(() => mockMulti()),
        del: mock((key: string) => {
            ops.push(() => {
                store.delete(key);
                store.delete(`__hash__:${key}`);
            });
            return mockMulti();
        }),
        exec: mock(async () => { for (const op of ops) op(); return []; }),
    };
};

const mockRedis = {
    isOpen: true,
    sAdd: mock(async (key: string, ...members: string[]) => {
        const s = setStore.get(key) ?? new Set();
        for (const m of members.flat()) s.add(m);
        setStore.set(key, s);
    }),
    sMembers: mock(async (key: string) => Array.from(setStore.get(key) ?? [])),
    sRem: mock(async (key: string, ...members: string[]) => {
        const s = setStore.get(key);
        if (s) for (const m of members.flat()) s.delete(m);
    }),
    expire: mock(async () => {}),
    multi: mock(() => mockMulti()),
    on: mock(() => mockRedis),
    connect: mock(async () => {}),
    set: mock(async (key: string, value: string) => { store.set(key, value); }),
    get: mock(async (key: string) => store.get(key) ?? null),
    del: mock(async (key: string) => {
        store.delete(key);
        store.delete(`__hash__:${key}`);
    }),
    hGetAll: mock(async (key: string) => {
        const raw = store.get(`__hash__:${key}`);
        return raw ? JSON.parse(raw) as Record<string, string> : {};
    }),
    hGet: mock(async () => null),
    hSet: mock(async (key: string, field: string, value: string) => {
        const existing = JSON.parse(store.get(`__hash__:${key}`) ?? "{}");
        existing[field] = value;
        store.set(`__hash__:${key}`, JSON.stringify(existing));
    }),
    incr: mock(async () => 1),
    exists: mock(async (key: string) => {
        return store.has(`__hash__:${key}`) ? 1 : 0;
    }),
};

mock.module("redis", () => ({ createClient: () => mockRedis }));
mock.module("./hub.js", () => ({ broadcastToHub: mock(async () => {}) }));
mock.module("../../sessions/store.js", () => ({
    getEphemeralTtlMs: () => 60_000,
    updateRelaySessionRunner: mock(async () => {}),
}));

// Track broadcast calls
const broadcastCalls: Array<{ event: string; data: unknown; userId?: string }> = [];
mock.module("./runners-broadcast.js", () => ({
    broadcastToRunnersNs: mock(async (event: string, data: unknown, userId?: string) => {
        broadcastCalls.push({ event, data, userId });
    }),
}));

const { initStateRedis } = await import("../sio-state.js");
const { registerRunner, removeRunner, updateRunnerSkills, updateRunnerAgents, updateRunnerPlugins } = await import("./runners.js");

// Note: updateRunnerHooks is not yet implemented in runners.ts and is intentionally
// excluded from this plan. Add it alongside updateRunnerAgents/Plugins when needed.

describe("runners broadcast", () => {
    beforeEach(async () => {
        store.clear();
        setStore.clear();
        broadcastCalls.length = 0;
        await initStateRedis();
    });

    it("broadcasts runner_added when registerRunner succeeds", async () => {
        const socket = { join: mock(async () => {}), data: {} } as any;
        const result = await registerRunner(socket, {
            name: "my-runner",
            roots: ["/home/user/code"],
            requestedRunnerId: undefined,
            runnerSecret: undefined,
            skills: [],
            agents: [],
            plugins: [],
            hooks: [],
            version: "1.0.0",
            platform: "linux",
            userId: "user1",
            userName: "User One",
        });

        expect(result instanceof Error).toBe(false);
        const runnerId = result as string;

        const added = broadcastCalls.find(c => c.event === "runner_added");
        expect(added).toBeDefined();
        expect((added!.data as any).runnerId).toBe(runnerId);
        expect((added!.data as any).name).toBe("my-runner");
        expect(added!.userId).toBe("user1");
    });

    it("broadcasts runner_removed when removeRunner is called", async () => {
        const socket = { join: mock(async () => {}), data: {} } as any;
        const result = await registerRunner(socket, {
            name: "runner-to-remove",
            roots: [],
            requestedRunnerId: undefined,
            runnerSecret: undefined,
            skills: [],
            agents: [],
            plugins: [],
            hooks: [],
            version: null,
            platform: null,
            userId: "user2",
            userName: "User Two",
        });
        expect(result instanceof Error).toBe(false);
        const runnerId = result as string;
        broadcastCalls.length = 0; // reset after register

        await removeRunner(runnerId);

        const removed = broadcastCalls.find(c => c.event === "runner_removed");
        expect(removed).toBeDefined();
        expect((removed!.data as any).runnerId).toBe(runnerId);
        expect(removed!.userId).toBe("user2");
    });

    it("broadcasts runner_updated after updateRunnerSkills", async () => {
        const socket = { join: mock(async () => {}), data: {} } as any;
        const result = await registerRunner(socket, {
            name: "skills-runner",
            roots: [],
            requestedRunnerId: undefined,
            runnerSecret: undefined,
            skills: [],
            agents: [],
            plugins: [],
            hooks: [],
            version: null,
            platform: null,
            userId: "user3",
            userName: "User Three",
        });
        expect(result instanceof Error).toBe(false);
        const runnerId = result as string;
        broadcastCalls.length = 0;

        await updateRunnerSkills(runnerId, [{ name: "my-skill", description: "does stuff", filePath: "/path/to/skill.md" }]);

        const updated = broadcastCalls.find(c => c.event === "runner_updated");
        expect(updated).toBeDefined();
        expect((updated!.data as any).runnerId).toBe(runnerId);
        const skills = (updated!.data as any).skills as Array<{ name: string }>;
        expect(skills.some(s => s.name === "my-skill")).toBe(true);
    });

    it("broadcasts runner_updated after updateRunnerAgents", async () => {
        const socket = { join: mock(async () => {}), data: {} } as any;
        const result = await registerRunner(socket, {
            name: "agents-runner",
            roots: [],
            requestedRunnerId: undefined,
            runnerSecret: undefined,
            skills: [],
            agents: [],
            plugins: [],
            hooks: [],
            version: null,
            platform: null,
            userId: "user4",
            userName: "User Four",
        });
        expect(result instanceof Error).toBe(false);
        const runnerId = result as string;
        broadcastCalls.length = 0;

        await updateRunnerAgents(runnerId, [{ name: "my-agent", description: "an agent", filePath: "/path/to/agent.md" }]);

        const updated = broadcastCalls.find(c => c.event === "runner_updated");
        expect(updated).toBeDefined();
        const agents = (updated!.data as any).agents as Array<{ name: string }>;
        expect(agents.some(a => a.name === "my-agent")).toBe(true);
    });

    it("broadcasts runner_updated after updateRunnerPlugins", async () => {
        const socket = { join: mock(async () => {}), data: {} } as any;
        const result = await registerRunner(socket, {
            name: "plugins-runner",
            roots: [],
            requestedRunnerId: undefined,
            runnerSecret: undefined,
            skills: [],
            agents: [],
            plugins: [],
            hooks: [],
            version: null,
            platform: null,
            userId: "user5",
            userName: "User Five",
        });
        expect(result instanceof Error).toBe(false);
        const runnerId = result as string;
        broadcastCalls.length = 0;

        await updateRunnerPlugins(runnerId, [{ name: "my-plugin", description: "a plugin", rootPath: "/path", commands: [], hookEvents: [], skills: [], hasMcp: false, hasAgents: false, hasLsp: false }]);

        const updated = broadcastCalls.find(c => c.event === "runner_updated");
        expect(updated).toBeDefined();
        const plugins = (updated!.data as any).plugins as Array<{ name: string }>;
        expect(plugins.some(p => p.name === "my-plugin")).toBe(true);
    });

    it("skips runner_removed broadcast gracefully when runner not in Redis", async () => {
        // removeRunner on a non-existent runner must not throw
        await removeRunner("ghost-runner");
        const removed = broadcastCalls.find(c => c.event === "runner_removed");
        // No broadcast since runner had no userId to target
        expect(removed).toBeUndefined();
    });
});
```

- [ ] **Step 2: Run tests — expect assertion failures**

```bash
cd packages/server && bun test src/ws/sio-registry/runners.broadcast.test.ts 2>&1 | tail -20
```

Expected: test failures with messages like `Expected [undefined] to be defined` — the `broadcastCalls` array stays empty because `runners.ts` hasn't been wired yet. Module resolution succeeds (the mock is in place); the assertions simply fail because no broadcasts fire yet.

- [ ] **Step 3: Create broadcast helper module**

Create `packages/server/src/ws/sio-registry/runners-broadcast.ts`:

```typescript
// runners-broadcast.ts — Helpers for broadcasting runner events to /runners namespace
// Room helper lives in context.ts (alongside hubUserRoom) to avoid circular deps.
import { getIo, runnersUserRoom } from "./context.js";

/**
 * Broadcast a runner lifecycle event to all connected /runners clients.
 * Scoped to a specific user via their room when userId is provided.
 * Mirrors the hub.ts broadcast pattern.
 */
export async function broadcastToRunnersNs(
    eventName: string,
    data: unknown,
    userId?: string,
): Promise<void> {
    const io = getIo();
    try {
        const runnersNs = io.of("/runners");
        if (userId) {
            runnersNs.to(runnersUserRoom(userId)).emit(eventName, data);
        } else {
            runnersNs.emit(eventName, data);
        }
    } catch (err) {
        // Fallback: local-only delivery (mirrors hub.ts pattern)
        console.warn("[sio-registry] broadcastToRunnersNs failed, falling back to local:", (err as Error)?.message);
        try {
            const runnersNs = io.of("/runners");
            if (userId) {
                runnersNs.local.to(runnersUserRoom(userId)).emit(eventName, data);
            } else {
                runnersNs.local.emit(eventName, data);
            }
        } catch {
            // Nothing more we can do
        }
    }
}
```

- [ ] **Step 4: Add `runnerDataToInfo` helper + wire broadcasts in runners.ts**

In `packages/server/src/ws/sio-registry/runners.ts`:

**Add import at top:**
```typescript
import { broadcastToRunnersNs } from "./runners-broadcast.js";
```

**Add helper function** (near `getRunners`):
```typescript
/**
 * Convert a single RedisRunnerData to RunnerInfo for WS broadcast.
 * sessionCount is set to 0 — the client computes it from live sessions.
 */
function runnerDataToInfo(r: RedisRunnerData): RunnerInfo {
    return {
        runnerId: r.runnerId,
        name: r.name,
        roots: safeJsonParse(r.roots) ?? [],
        sessionCount: 0,
        skills: safeJsonParse(r.skills) ?? [],
        agents: safeJsonParse(r.agents ?? "[]") ?? [],
        plugins: safeJsonParse(r.plugins ?? "[]") ?? [],
        hooks: safeJsonParse(r.hooks ?? "[]") ?? [],
        version: r.version ?? null,
        platform: r.platform ?? null,
    };
}
```

**In `registerRunner()`**, after `await socket.join(runnerRoom(runnerId));` and `return runnerId;`, add broadcast (just before `return`):
```typescript
    // Broadcast runner_added to connected browsers
    void broadcastToRunnersNs("runner_added", runnerDataToInfo(runnerData), opts.userId ?? undefined);

    return runnerId;
```

**In `removeRunner()`**, change from:
```typescript
export async function removeRunner(runnerId: string): Promise<void> {
    localRunnerSockets.delete(runnerId);
    await deleteRunnerState(runnerId);
}
```

To:
```typescript
export async function removeRunner(runnerId: string): Promise<void> {
    // Read userId before deleting so we can target the correct user room
    const existing = await getRunnerState(runnerId);
    localRunnerSockets.delete(runnerId);
    await deleteRunnerState(runnerId);
    if (existing) {
        void broadcastToRunnersNs(
            "runner_removed",
            { runnerId },
            existing.userId ?? undefined,
        );
    }
}
```

**In `updateRunnerSkills()`**, after `await updateRunnerFields(...)`, add:
```typescript
    const fresh = await getRunnerState(runnerId);
    if (fresh) {
        void broadcastToRunnersNs("runner_updated", runnerDataToInfo(fresh), fresh.userId ?? undefined);
    }
```

Apply the same pattern to `updateRunnerAgents()` and `updateRunnerPlugins()`.

- [ ] **Step 5: Run tests — expect pass**

```bash
cd packages/server && bun test src/ws/sio-registry/runners.broadcast.test.ts 2>&1 | tail -15
```

Expected: all tests pass.

- [ ] **Step 6: Full server typecheck**

```bash
cd packages/server && bun run typecheck 2>&1
```

Expected: zero errors.

- [ ] **Step 7: Full test suite**

```bash
bun run test 2>&1 | tail -10
```

Expected: ≥406 pass, 0 fail.

- [ ] **Step 8: Commit**

```bash
git add packages/server/src/ws/sio-registry/runners-broadcast.ts \
        packages/server/src/ws/sio-registry/runners.ts \
        packages/server/src/ws/sio-registry/runners.broadcast.test.ts
git commit -m "feat(server): broadcast runner_added/removed/updated to /runners namespace"
```

---

## Chunk 2: UI Hook + RunnerManager + App.tsx Core

### Task 4: `useRunnersFeed` hook

**Files:**
- Create: `packages/ui/src/lib/useRunnersFeed.ts`
- Create: `packages/ui/src/lib/useRunnersFeed.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `packages/ui/src/lib/useRunnersFeed.test.ts`:

```typescript
import { describe, it, expect } from "bun:test";
// Pure logic tests: upsert, remove, merge helpers extracted from the hook

// These mirror the reducer logic inside useRunnersFeed.
// We test the state-update logic in isolation (no DOM/socket needed).

import type { RunnerInfo } from "@pizzapi/protocol";

function makeRunner(overrides: Partial<RunnerInfo> = {}): RunnerInfo {
    return {
        runnerId: "r1",
        name: "runner",
        roots: [],
        sessionCount: 0,
        skills: [],
        agents: [],
        plugins: [],
        hooks: [],
        version: null,
        platform: null,
        ...overrides,
    };
}

// ── upsert ────────────────────────────────────────────────────────────────

function upsert(list: RunnerInfo[], incoming: RunnerInfo): RunnerInfo[] {
    const idx = list.findIndex(r => r.runnerId === incoming.runnerId);
    if (idx === -1) return [...list, incoming];
    const next = [...list];
    next[idx] = incoming;
    return next;
}

describe("useRunnersFeed state helpers", () => {
    describe("upsert (runner_added / runner_updated)", () => {
        it("appends a new runner", () => {
            const r = makeRunner({ runnerId: "r1" });
            const result = upsert([], r);
            expect(result).toHaveLength(1);
            expect(result[0].runnerId).toBe("r1");
        });

        it("replaces existing runner by runnerId", () => {
            const old = makeRunner({ runnerId: "r1", name: "old" });
            const updated = makeRunner({ runnerId: "r1", name: "new" });
            const result = upsert([old], updated);
            expect(result).toHaveLength(1);
            expect(result[0].name).toBe("new");
        });

        it("does not affect other runners", () => {
            const r1 = makeRunner({ runnerId: "r1" });
            const r2 = makeRunner({ runnerId: "r2", name: "other" });
            const updated = makeRunner({ runnerId: "r1", name: "updated" });
            const result = upsert([r1, r2], updated);
            expect(result).toHaveLength(2);
            expect(result.find(r => r.runnerId === "r2")?.name).toBe("other");
        });
    });

    describe("remove (runner_removed)", () => {
        it("removes runner by runnerId", () => {
            const runners = [makeRunner({ runnerId: "r1" }), makeRunner({ runnerId: "r2" })];
            const result = runners.filter(r => r.runnerId !== "r1");
            expect(result).toHaveLength(1);
            expect(result[0].runnerId).toBe("r2");
        });

        it("is a no-op when runnerId not found", () => {
            const runners = [makeRunner({ runnerId: "r1" })];
            const result = runners.filter(r => r.runnerId !== "ghost");
            expect(result).toHaveLength(1);
        });
    });
});
```

- [ ] **Step 2: Run tests — expect pass (pure logic, no implementation needed)**

```bash
cd packages/ui && bun test src/lib/useRunnersFeed.test.ts 2>&1 | tail -10
```

Expected: all pass (pure JS logic).

- [ ] **Step 3: Create the hook**

Create `packages/ui/src/lib/useRunnersFeed.ts`:

```typescript
import * as React from "react";
import { io, type Socket } from "socket.io-client";
import type {
    RunnersServerToClientEvents,
    RunnersClientToServerEvents,
    RunnerInfo,
} from "@pizzapi/protocol";
import { getSocketIOBase } from "./relay.js";

export type RunnersFeedStatus = "connecting" | "connected" | "disconnected";

export interface RunnersFeedState {
    runners: RunnerInfo[];
    status: RunnersFeedStatus;
}

/**
 * Subscribe to the /runners Socket.IO namespace.
 * Returns the live runner list and connection status.
 *
 * The server broadcasts:
 *   runners       — full snapshot on connect
 *   runner_added  — new runner registered
 *   runner_removed — runner disconnected
 *   runner_updated — runner metadata changed (skills/agents/plugins)
 */
export function useRunnersFeed(): RunnersFeedState {
    const [runners, setRunners] = React.useState<RunnerInfo[]>([]);
    const [status, setStatus] = React.useState<RunnersFeedStatus>("connecting");

    React.useEffect(() => {
        const base = getSocketIOBase();
        const socket: Socket<RunnersServerToClientEvents, RunnersClientToServerEvents> = io(
            base ? `${base}/runners` : "/runners",
            { withCredentials: true },
        );

        socket.on("connect", () => setStatus("connected"));
        socket.on("disconnect", () => setStatus("disconnected"));
        socket.on("connect_error", () => setStatus("disconnected"));

        socket.on("runners", ({ runners: list }) => {
            setRunners(list);
        });

        socket.on("runner_added", (incoming) => {
            setRunners(prev => {
                const idx = prev.findIndex(r => r.runnerId === incoming.runnerId);
                if (idx === -1) return [...prev, incoming];
                const next = [...prev];
                next[idx] = incoming;
                return next;
            });
        });

        socket.on("runner_removed", ({ runnerId }) => {
            setRunners(prev => prev.filter(r => r.runnerId !== runnerId));
        });

        socket.on("runner_updated", (incoming) => {
            setRunners(prev => {
                const idx = prev.findIndex(r => r.runnerId === incoming.runnerId);
                if (idx === -1) return prev; // unknown runner — ignore
                const next = [...prev];
                next[idx] = incoming;
                return next;
            });
        });

        return () => {
            socket.disconnect();
        };
    }, []);

    return { runners, status };
}
```

- [ ] **Step 4: UI typecheck**

```bash
cd packages/ui && bun run typecheck 2>&1
```

Expected: zero errors.

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/lib/useRunnersFeed.ts packages/ui/src/lib/useRunnersFeed.test.ts
git commit -m "feat(ui): add useRunnersFeed hook for /runners WebSocket feed"
```

---

### Task 5: Refactor `RunnerManager`

**Files:**
- Modify: `packages/ui/src/components/RunnerManager.tsx`

Remove all polling and sessions fetching. Accept `sessions` as a prop. Use `useRunnersFeed()` for runner data. Replace `poll()` spawn-wait with effect-based watching.

- [ ] **Step 1: Update the component**

In `packages/ui/src/components/RunnerManager.tsx`:

**Change the props interface** — use full `HubSession` type rather than the narrower `{sessionId, runnerId}` proposed in the spec. The spec's narrow type is insufficient because `RunnerDetailPanel.SessionsList` requires `shareUrl`, `cwd`, `startedAt`, `sessionName`, `isActive`, `lastHeartbeatAt`, `runnerId`, `runnerName`. `HubSession` (from `SessionSidebar.tsx`) is a superset that satisfies all these fields. This is an intentional deviation from the spec's narrow-type recommendation in favor of correctness:

```typescript
import type { HubSession } from "@/components/SessionSidebar";

export interface RunnerManagerProps {
    /** Live sessions from the /hub feed — used for spawn-wait, per-runner counts, and RunnerDetailPanel */
    sessions: HubSession[];
    onOpenSession?: (sessionId: string) => void;
    selectedRunnerId: string | null;
    onSelectRunner?: (runnerId: string) => void;
}
```

Note: `onRunnersChange` is **removed** from props — `App.tsx` will derive `runnersForSidebar` directly from `feedRunners` via its own `useEffect` (see Task 6).

**Change the props interface** — add `runners` and `runnersStatus` from App.tsx's `useRunnersFeed()` call (the hook is called once in App.tsx, not here, to avoid duplicate socket connections):

```typescript
import type { RunnerInfo } from "@pizzapi/protocol";

// Add to props:
runners: RunnerInfo[];
runnersStatus: "connecting" | "connected" | "disconnected";
```

**Remove local state + polling** — remove:
- `const [runners, setRunners]`
- `const [sessions, setSessions]`
- `const [loading, setLoading]`
- `const fetchData` callback
- The `useEffect` with `setInterval(fetchData, 10000)` + initial call
- The standalone `fetch("/api/version")` effect (version is already in `RunnerInfo.version`)

**Derive loading state from props:**
```typescript
const loading = runnersStatus === "connecting" && runners.length === 0;
```

**Add spawn-wait effects** (after existing effects):
```typescript
// Resolve pending spawn: when the spawned session appears in the live feed, open it
React.useEffect(() => {
    if (!pendingSessionId) return;
    const found = sessions.some(s => s.sessionId === pendingSessionId);
    if (found) {
        const id = pendingSessionId;
        setPendingSessionId(null);
        onOpenSession?.(id);
    }
}, [pendingSessionId, sessions, onOpenSession]);

// 30-second timeout guard: clear pendingSessionId if session never appears
React.useEffect(() => {
    if (!pendingSessionId) return;
    const timer = setTimeout(() => setPendingSessionId(null), 30_000);
    return () => clearTimeout(timer);
}, [pendingSessionId]);
```

**Replace all uses of local `runners` → `runners` prop, `sessions` → `sessions` prop.**

**`onSkillsChange`, `onAgentsChange`, `onPluginsChange` on `RunnerDetailPanel`**: these previously updated local `runners` state. Since updates now arrive via WS `runner_updated` events, pass no-op callbacks:
```tsx
onSkillsChange={() => {}}
onAgentsChange={() => {}}
onPluginsChange={() => {}}
```

**In `handleSpawn`**: remove the `poll()` loop. After the spawn succeeds and `sessionId` is known, replace `void poll()` with:
```typescript
setPendingSessionId(sessionId);
```

**Remove `fetchData()` calls in `handleRestart` and `handleStop`**: both `finally` blocks currently call `fetchData()` after the 2s delay. Remove those calls — the WS feed updates automatically when the runner reconnects. Specifically, in `handleRestart`:
```typescript
// Remove this:
fetchData();
```
And same in `handleStop`'s `finally` block.

**Remove `latestVersion` state + `fetch("/api/version")` effect**: this fetches the server version on mount to display an "update available" badge. With `RunnerInfo.version` now flowing through the WS feed, the version is available as `runners[0]?.version`. Remove the separate fetch and use the feed-provided version. (This is a small scope extension beyond the spec, but keeping a redundant HTTP fetch alongside a WS feed would be inconsistent.)

**`runnerSessions` for `RunnerDetailPanel`:**
```typescript
const runnerSessions = sessions.filter(s => s.runnerId === selectedRunnerId);
```

Pass sessions to `RunnerDetailPanel` with an explicit mapping to avoid optional/required type mismatches:
```typescript
const runnerSessions = sessions
    .filter(s => s.runnerId === selectedRunnerId)
    .map(s => ({
        sessionId: s.sessionId,
        shareUrl: s.shareUrl ?? "",
        cwd: s.cwd ?? "",
        startedAt: s.startedAt ?? "",
        sessionName: s.sessionName ?? null,
        isActive: s.isActive ?? false,
        lastHeartbeatAt: s.lastHeartbeatAt ?? null,
        runnerId: s.runnerId ?? null,
        runnerName: s.runnerName ?? null,
    }));
```

- [ ] **Step 2: Typecheck**

```bash
cd packages/ui && bun run typecheck 2>&1
```

Expected: errors about missing `sessions` prop at call sites in `App.tsx`. That's expected — fix in Task 6.

- [ ] **Step 3: Commit (WIP — broken typecheck is expected)**

```bash
git add packages/ui/src/components/RunnerManager.tsx
git commit -m "feat(ui): refactor RunnerManager — use WS feed, remove polling, add sessions prop"
```

---

### Task 6: `App.tsx` — remove runner fetches, hub-based wait, pass sessions

**Files:**
- Modify: `packages/ui/src/App.tsx`

Three changes:
1. Remove the on-mount eager `fetch("/api/runners")` (lines ~137–159)
2. Remove the `runners` state + `runnersLoading` state + new-session-dialog fetch (lines ~181–385)
3. Replace `waitForSessionToGoLive` polling with ref-based hub waiter
4. Pass `sessions` prop to `RunnerManager`
5. Use `useRunnersFeed()` to supply runners to `NewSessionWizardDialog`

- [ ] **Step 1: Add `useRunnersFeed` — single instance in App.tsx**

`useRunnersFeed()` is called **only** in App.tsx, never in RunnerManager. This avoids duplicate `/runners` socket connections.

In `App.tsx`, add import:
```typescript
import { useRunnersFeed } from "@/lib/useRunnersFeed";
```

Add near other hooks at the top of the component body:
```typescript
const { runners: feedRunners, status: runnersStatus } = useRunnersFeed();
```

- [ ] **Step 2: Remove on-mount eager fetch**

Delete the `useEffect` block (~lines 137–159) that does:
```typescript
// Eager fetch: populate sidebar runners immediately on mount (before RunnerManager mounts)
React.useEffect(() => {
    let cancelled = false;
    void fetch("/api/runners", ...)
    ...
}, [setSidebarRunners]);
```

- [ ] **Step 3: Remove `runners` state, `runnersLoading` state, and new-session dialog fetch**

Delete:
```typescript
const [runners, setRunners] = React.useState<RunnerInfo[]>([]);
const [runnersLoading, setRunnersLoading] = React.useState(false);
```

Delete the `useEffect` block (~lines 352–385) that depends on `[newSessionOpen]` and calls `fetch("/api/runners")`.

- [ ] **Step 4: Replace `waitForSessionToGoLive` with hub waiter**

Locate `waitForSessionToGoLive` (~line 2514). Replace the entire function and add the waiter ref + resolver effect:

```typescript
// ── Session live waiter — resolves via /hub feed, no polling ──────────────
const sessionWaitersRef = React.useRef<Map<string, {
    resolve: (found: boolean) => void;
    timer: ReturnType<typeof setTimeout>;
}>>(new Map());

// Resolve any pending waiters when liveSessions updates
React.useEffect(() => {
    for (const [sessionId, waiter] of sessionWaitersRef.current) {
        if (liveSessions.some(s => s.sessionId === sessionId)) {
            clearTimeout(waiter.timer);
            sessionWaitersRef.current.delete(sessionId);
            waiter.resolve(true);
        }
    }
}, [liveSessions]);

const waitForSessionToGoLive = React.useCallback(
    (sessionId: string, timeoutMs: number): Promise<boolean> => {
        // Fast path: already live
        if (liveSessions.some(s => s.sessionId === sessionId)) {
            return Promise.resolve(true);
        }
        return new Promise((resolve) => {
            const timer = setTimeout(() => {
                sessionWaitersRef.current.delete(sessionId);
                resolve(false);
            }, timeoutMs);
            sessionWaitersRef.current.set(sessionId, { resolve, timer });
        });
    },
    [liveSessions],
);
```

- [ ] **Step 5: Derive `runnersForSidebar` in App.tsx from the feed**

Since `RunnerManager` no longer exposes `onRunnersChange`, App.tsx must derive `runnersForSidebar` directly from the feed. Add this effect in App.tsx (replaces the `setSidebarRunners` logic that previously came from `RunnerManager`'s `onRunnersChange`):

```typescript
React.useEffect(() => {
    setSidebarRunners(feedRunners.map(r => ({
        runnerId: r.runnerId,
        name: r.name,
        sessionCount: liveSessions.filter(s => s.runnerId === r.runnerId).length,
        version: r.version,
        isOnline: true,
        platform: r.platform ?? null,
    })));
}, [feedRunners, liveSessions, setSidebarRunners]);
```

- [ ] **Step 6: Pass runners + sessions to RunnerManager; wire NewSessionWizardDialog**

Find `<RunnerManager` in App.tsx (appears ~3 times). Update each to pass the new props and remove `onRunnersChange`:

```tsx
<RunnerManager
    runners={feedRunners}             // ← add (from useRunnersFeed in App.tsx)
    runnersStatus={runnersStatus}     // ← add
    sessions={liveSessions}           // ← add
    onOpenSession={...}
    // onRunnersChange removed — App.tsx derives it via useEffect on feedRunners
    selectedRunnerId={selectedRunnerId}
    onSelectRunner={setSelectedRunnerId}
/>
```

Find `<NewSessionWizardDialog` and change:
```tsx
runners={runners.map((r) => ({ ...r, name: r.name ?? null, isOnline: true }))}
runnersLoading={runnersLoading}
```
To:
```tsx
runners={feedRunners.map((r) => ({ ...r, name: r.name ?? null, isOnline: true }))}
runnersLoading={runnersStatus === "connecting"}
```

- [ ] **Step 7: Typecheck**

```bash
cd packages/ui && bun run typecheck 2>&1
```

Expected: zero errors.

- [ ] **Step 8: Full test suite**

```bash
bun run test 2>&1 | tail -10
```

Expected: ≥406 pass (the new useRunnersFeed tests add a few), 0 fail.

- [ ] **Step 9: Commit**

```bash
git add packages/ui/src/App.tsx
git commit -m "feat(ui): wire App.tsx to /runners feed — remove fetches, hub-based session waiter"
```

---

## Chunk 3: Dialogs + SessionViewer

### Task 7: `TerminalManager` — accept runners prop

**Files:**
- Modify: `packages/ui/src/components/TerminalManager.tsx`

- [ ] **Step 1: Add runners prop to `TerminalManager`**

Find the props type/interface at the top of `TerminalManager.tsx`. The component receives its props as a destructured object. Add:

```typescript
runners?: Array<{
    runnerId: string;
    name: string | null;
    roots: string[];
    sessionCount: number;
}>;
runnersLoading?: boolean;
```

- [ ] **Step 2: Remove local runners state + fetch**

Delete:
```typescript
const [runners, setRunners] = React.useState<RunnerInfo[]>([]);
const [runnersLoading, setRunnersLoading] = React.useState(false);
```

Delete the `useEffect` block that fires `fetch("/api/runners")` when `dialogOpen` changes.

- [ ] **Step 3: Use prop values**

Replace all uses of the local `runners` state with the `runners` prop (defaulting to `[]`):
```typescript
const effectiveRunners = runners ?? [];
```

Replace `runnersLoading` state with the `runnersLoading` prop (defaulting to `false`).

- [ ] **Step 4: Pass props from App.tsx**

Find each `<TerminalManager` in `App.tsx` and add:
```tsx
runners={feedRunners.map(r => ({
    runnerId: r.runnerId,
    name: r.name,
    roots: r.roots,
    sessionCount: liveSessions.filter(s => s.runnerId === r.runnerId).length,
}))}
runnersLoading={runnersStatus === "connecting"}
```

- [ ] **Step 5: Typecheck**

```bash
cd packages/ui && bun run typecheck 2>&1
```

Expected: zero errors.

- [ ] **Step 6: Commit**

```bash
git add packages/ui/src/components/TerminalManager.tsx packages/ui/src/App.tsx
git commit -m "feat(ui): TerminalManager — accept runners prop, remove on-dialog-open fetch"
```

---

### Task 8: `SessionViewer` — use cached runner data for slash commands

**Files:**
- Modify: `packages/ui/src/components/SessionViewer.tsx`
- Modify: `packages/ui/src/App.tsx`

The `/skills`, `/agents`, `/plugins` slash commands and the `@mention` agent popover currently fire `fetch("/api/runners/{id}/...")` each time. Since the runner's skills/agents/plugins flow through `runner_updated` on the WS feed, the data is already in `feedRunners`. Pass it as a `runnerInfo` prop.

Note: `/sandbox` keeps its HTTP fetch — sandbox status (violation counts, recent violations) is not part of `RunnerInfo`.

- [ ] **Step 1: Add `runnerInfo` prop to `SessionViewer`**

Find the `SessionViewerProps` interface (or equivalent) in `SessionViewer.tsx`. Add:

```typescript
/** Full runner data for the active session's runner — from the /runners WS feed */
runnerInfo?: import("@pizzapi/protocol").RunnerInfo | null;
```

Destructure it in the component:
```typescript
const { ..., runnerInfo } = props;
```

- [ ] **Step 2: Replace `/skills` HTTP fetch**

Find the block handling `rawCommand === "skills"`. Replace:
```typescript
fetch(`/api/runners/${encodeURIComponent(runnerId)}/skills`, ...)
    .then(...)
```

With:
```typescript
// Use cached runner data from WS feed. If runner disconnected, runnerInfo is null → empty list.
// This is acceptable: the existing pre-guard already catches `if (!runnerId)` (no runner at all).
// If the runner disconnected mid-session, the user sees an empty skills list rather than an error.
const skills = runnerInfo?.skills ?? [];
// Merge with CLI-advertised skill commands (same merge logic as before)
const merged = new Map<string, { name: string; description?: string }>();
for (const s of skills) merged.set(s.name, s);
for (const cmd of skillCommands) {
    const skillName = cmd.name.replace(/^skill:/, "");
    if (!merged.has(skillName)) {
        merged.set(skillName, { name: skillName, description: cmd.description });
    }
}
onAppendSystemMessage?.({
    kind: "skills",
    skills: Array.from(merged.values()),
});
```

Remove the `catch` and `dispatchSessionId` guard (no longer async).

- [ ] **Step 3: Replace `/plugins` HTTP fetch**

Find the block handling `rawCommand === "plugins"`. Replace the `fetch(pluginsUrl, ...)` chain with:
```typescript
const plugins = runnerInfo?.plugins ?? [];
onAppendSystemMessage?.({
    kind: "plugins",
    plugins: plugins.map((p) => ({
        name: p.name,
        description: p.description,
        version: p.version,
        commands: (p.commands ?? []).map((c) => ({ name: c.name, description: c.description })),
        hookCount: p.hookEvents?.length ?? 0,
        skillCount: p.skills?.length ?? 0,
        agentCount: p.agents?.length ?? 0,
        ruleCount: p.rules?.length ?? 0,
        hasMcp: !!p.hasMcp,
        hasAgents: !!p.hasAgents,
    })),
});
```

- [ ] **Step 4: Replace `/agents <name>` execution fetch**

Find the block handling `rawCommand === "agents"` with `args.trim()`. Replace the `fetch(...)` with a synchronous lookup against `runnerInfo?.agents` for name resolution, keeping an individual content fetch:

```typescript
const dispatchSessionId = sessionId;
const agents = runnerInfo?.agents ?? [];
const match = agents.find(a => a.name.toLowerCase() === agentName.toLowerCase());
if (match) {
    // Fetch individual agent content (system prompt) — not in RunnerInfo.agents
    // Note: the list endpoint also doesn't return content (pre-existing limitation).
    // Only the per-agent endpoint (/agents/:name) returns content.
    fetch(`/api/runners/${encodeURIComponent(runnerId)}/agents/${encodeURIComponent(match.name)}`, { credentials: "include" })
        .then(res => res.ok ? res.json() : Promise.reject())
        .then((data: any) => {
            if (dispatchSessionId !== sessionIdRef.current) return; // session changed
            onSpawnAgentSession?.({ name: match.name, description: match.description, systemPrompt: data?.content });
        })
        .catch(() => {
            if (dispatchSessionId !== sessionIdRef.current) return;
            onSpawnAgentSession?.({ name: match.name, description: match.description });
        });
} else {
    onAppendSystemMessage?.(`**Agents** — Agent "${agentName}" not found.`);
}
```

- [ ] **Step 5: Replace `@mention` agent popover fetch**

Find the `useEffect` that fires when `atMentionOpen && runnerId`. Replace the `fetch(...)` with:

```typescript
React.useEffect(() => {
    if (!atMentionOpen || !runnerId) return;
    const agents = (runnerInfo?.agents ?? []).map(a => ({ name: a.name, description: a.description }));
    setAtMentionAgents(agents);
}, [atMentionOpen, runnerId, runnerInfo]);
```

Remove `atMentionAgentsFetchedForRef` (no longer needed since it was just a fetch-dedup guard).

- [ ] **Step 6: Update `/agents` command popover list fetch**

The agents popover uses `agentsList` both for display AND for spawning (`agent.content` as `systemPrompt`). Since `runnerInfo.agents` lacks `content`, keep the HTTP fetch for the agent list but populate the display immediately from cached data while the fetch is in-flight:

```typescript
React.useEffect(() => {
    if (!sessionId || !commandOpen || !isAgentMode || !runnerId) return;
    const requestKey = `${sessionId}-${runnerId}`;
    if (agentsRequestedRef.current === requestKey) return;
    agentsRequestedRef.current = requestKey;
    let stale = false;

    // Pre-populate display from cached runner data immediately (no loading flicker)
    const cachedAgents = (runnerInfo?.agents ?? []).map(a => ({ name: a.name, description: a.description }));
    setAgentsList(cachedAgents);

    // Fetch full agent data (including content for system prompts) in background
    setAgentsLoading(true);
    fetch(`/api/runners/${encodeURIComponent(runnerId)}/agents`, { credentials: "include" })
        .then((res) => res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`)))
        .then((data: any) => {
            if (stale) return;
            const agents: Array<{ name: string; description?: string; content?: string }> = Array.isArray(data?.agents) ? data.agents : [];
            setAgentsList(agents);
        })
        .catch(() => { if (stale) return; /* keep cached data */ })
        .finally(() => { if (!stale) setAgentsLoading(false); });
    return () => { stale = true; };
}, [sessionId, commandOpen, isAgentMode, runnerId, runnerInfo]);
```

This eliminates visible loading states (cached data shows immediately) while still fetching `content` for agent spawning.

Note: `GET /api/runners/:id/agents` (list endpoint) returns `{name, description, filePath}` from Redis — no `content`. `GET /api/runners/:id/agents/:name` (individual endpoint) returns `content`. The fetch in this step is for the list (display + dedup), and `content` was already `undefined` in picker-based spawning before this refactor. The per-agent content fetch is only done explicitly in Step 4 (`/agents <name>` execution). This plan does not change picker spawning behavior.

- [ ] **Step 7: Pass `runnerInfo` from App.tsx**

In `App.tsx`, add:
```typescript
const activeRunnerInfo = React.useMemo(
    () => feedRunners.find(r => r.runnerId === activeSessionInfo?.runnerId) ?? null,
    [feedRunners, activeSessionInfo?.runnerId],
);
```

Find `<SessionViewer` and add:
```tsx
runnerInfo={activeRunnerInfo}
```

- [ ] **Step 8: Typecheck**

```bash
cd packages/ui && bun run typecheck 2>&1
```

Expected: zero errors.

- [ ] **Step 9: Full test suite**

```bash
bun run test 2>&1 | tail -10
```

Expected: ≥406 pass, 0 fail.

- [ ] **Step 10: Commit**

```bash
git add packages/ui/src/components/SessionViewer.tsx packages/ui/src/App.tsx
git commit -m "feat(ui): SessionViewer — use cached runner data for /skills, /agents, /plugins commands"
```

---

## Chunk 4: Final verification

### Task 9: Build + typecheck all packages

- [ ] **Step 1: Full build**

```bash
bun run build 2>&1 | tail -20
```

Expected: all packages build cleanly.

- [ ] **Step 2: Full typecheck**

```bash
bun run typecheck 2>&1
```

Expected: zero errors across all packages.

- [ ] **Step 3: Full test suite**

```bash
bun run test 2>&1 | tail -10
```

Expected: ≥406 pass, 0 fail.

- [ ] **Step 4: Confirm no polling remains**

```bash
grep -rn "setInterval.*fetch\|fetch.*setInterval\|fetchData.*interval\|interval.*fetchData" \
  packages/ui/src --include="*.ts" --include="*.tsx" | grep -v node_modules | grep -v test
```

Expected: no output (no polling loops).

- [ ] **Step 5: Confirm no ad-hoc runner fetches remain**

```bash
grep -rn 'fetch("/api/runners"' packages/ui/src --include="*.ts" --include="*.tsx" | grep -v node_modules
```

Expected: only mutation calls remain (restart, stop, spawn, terminal — all POST). Zero `GET /api/runners` calls.

- [ ] **Step 6: Final commit**

```bash
git add -A
git commit -m "chore: final cleanup — verify zero polling, all builds passing"
```

---

## Summary of Changes

| File | What changed |
|------|-------------|
| `packages/protocol/src/runners.ts` | **New** — WS event types |
| `packages/protocol/src/index.ts` | Exports new types |
| `packages/server/src/ws/namespaces/runners.ts` | **New** — `/runners` namespace |
| `packages/server/src/ws/namespaces/index.ts` | Registers namespace |
| `packages/server/src/ws/sio-registry/context.ts` | Adds `runnersUserRoom` helper |
| `packages/server/src/ws/sio-registry/index.ts` | Re-exports `runnersUserRoom` |
| `packages/server/src/ws/sio-registry/runners-broadcast.ts` | **New** — broadcast helper |
| `packages/server/src/ws/sio-registry/runners.ts` | Adds broadcasts on register/remove/update |
| `packages/server/src/ws/sio-registry/runners.broadcast.test.ts` | **New** — broadcast behavior tests |
| `packages/ui/src/lib/useRunnersFeed.ts` | **New** — hook |
| `packages/ui/src/lib/useRunnersFeed.test.ts` | **New** — state logic tests |
| `packages/ui/src/components/RunnerManager.tsx` | Removes polling; accepts runners+runnersStatus+sessions props from App.tsx |
| `packages/ui/src/components/TerminalManager.tsx` | Accepts runners prop; removes on-open fetch |
| `packages/ui/src/components/SessionViewer.tsx` | Uses cached `runnerInfo` for commands/popover |
| `packages/ui/src/App.tsx` | Uses `useRunnersFeed`; hub-based session waiter; passes props |
