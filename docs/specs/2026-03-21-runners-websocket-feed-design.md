# Design: Runner WebSocket Feed (`/runners` namespace)

**Date:** 2026-03-21  
**Branch:** `feat/ui-websocket-realtime`  
**Status:** Approved

---

## Problem

The `RunnerManager` component polls two REST endpoints every 10 seconds:
- `GET /api/runners` — runner metadata (name, skills, agents, plugins, version)
- `GET /api/sessions` — session list (to compute per-runner session counts and show session lists)

There is also a spin-poll loop after spawning a session (`poll()` in `RunnerManager`, `waitForSessionToGoLive` in `App.tsx`) that hits `/api/sessions` every 1 second until the new session appears.

Additionally:
- `App.tsx` does a one-time eager `fetch("/api/runners")` on mount
- `App.tsx` re-fetches `/api/runners` every time the new-session dialog opens
- `TerminalManager` fetches `/api/runners` every time the terminal dialog opens
- `SessionViewer` fires `fetch("/api/runners/{id}/skills|agents|plugins")` each time a user runs a `/skills`, `/agents`, or `/plugins` slash command, and fetches agents on every `@mention` popover open and `/agents <name>` invocation — even though this data is already known from the runner's registration

**Effect:** Up to 10-second lag before a newly connected/disconnected runner appears in the UI. Unnecessary HTTP load on every dialog open and slash command. Architectural smell — the rest of the session lifecycle already uses WebSocket (`/hub` namespace for sessions, `/viewer` for content).

---

## Goal

- Instant runner connect/disconnect/update notifications (latency → ~0)
- Zero polling: eliminate all `setInterval` + `fetch` for runners and sessions
- Eliminate redundant on-demand runner fetches in dialogs and slash commands — use cached WS state
- Consistent architecture: all real-time state flows through Socket.IO namespaces

---

## Out of Scope

- Changing `/hub` session events (already WebSocket, already working)
- Changing `/viewer` session content events
- Multi-node / Redis adapter runner broadcasting (existing pattern; runners broadcast to per-user rooms)

---

## Chosen Approach: New `/runners` Namespace

A dedicated browser-facing `/runners` Socket.IO namespace alongside the existing `/hub`. The runner daemon's existing `/runner` (singular) namespace is unchanged.

---

## Component Design

### 1. Protocol (`packages/protocol`)

**New file:** `packages/protocol/src/runners.ts`

```typescript
import type { RunnerInfo } from "./shared.js";

/** Server → Client events on the /runners namespace */
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

/** Client → Server: read-only feed, no client events */
export interface RunnersClientToServerEvents {}

export interface RunnersInterServerEvents {}

export interface RunnersSocketData {
  userId?: string;
}
```

`sessionCount` is **not** a meaningful field in WS events. The server will
send the `RunnerInfo` shape as-is (which includes `sessionCount`), but the
client **ignores the server's `sessionCount`** and computes it locally from
`liveSessions.filter(s => s.runnerId === r.runnerId).length` — it already has
the full sessions list from the `/hub` feed. Implementers should not rely on
the server's `sessionCount` value in the WS events.

**Updated:** `packages/protocol/src/index.ts` — export the four new types.

---

### 2. Server: `/runners` Namespace (`packages/server`)

#### 2a. New namespace file: `src/ws/namespaces/runners.ts`

```
/runners namespace:
  auth: sessionCookieAuthMiddleware (same as /hub)
  on connection:
    - extract userId from socket.data
    - join user room: "runners:user:<userId>"
    - fetch runners: getRunners(userId)
    - emit "runners" with initial list
    - on disconnect: leave rooms (Socket.IO cleans up automatically)
```

#### 2b. Extend: `src/ws/sio-registry/runners.ts`

New helper:
```typescript
async function broadcastToRunnersNs(
  eventName: string,
  data: unknown,
  userId?: string,
): Promise<void>
```
Uses `io.of("/runners").to("runners:user:<userId>")` for user-scoped delivery.

New broadcast calls:
- `registerRunner()` — after `setRunner()` succeeds, build `RunnerInfo` and call `broadcastToRunnersNs("runner_added", runnerInfo, userId)`
- `removeRunner()` — the current implementation deletes without reading first; change it to call `getRunnerState(runnerId)` before `deleteRunnerState` to get the `userId` for room targeting, then broadcast `runner_removed`, then delete
- `updateRunnerSkills(runnerId, skills)` — after the field update, re-fetch runner, broadcast `runner_updated`
- `updateRunnerAgents(runnerId, agents)` — same pattern
- `updateRunnerPlugins(runnerId, plugins)` — same pattern
- `updateRunnerHooks(runnerId, hooks)` — same pattern (if this function exists or is added)

**Race safety:** `runner_removed` reads the userId *before* deleting so the user-room target is available. If the runner is not found in Redis during an update, the broadcast is skipped silently.

#### 2c. Extend: `src/ws/namespaces/index.ts`

Register `registerRunnersNamespace(io)` alongside the existing namespaces.

---

### 3. UI: `useRunnersFeed` Hook (`packages/ui`)

**New file:** `packages/ui/src/lib/useRunnersFeed.ts`

```
useRunnersFeed() → {
  runners: RunnerInfo[],
  status: 'connected' | 'disconnected' | 'connecting'
}
```

Behavior:
- On mount: connects to `io("/runners", { withCredentials: true })`
- `connect` event: sets `status = "connected"`
- `disconnect` / `connect_error`: sets `status = "disconnected"`
- `runners` event: replaces the entire runners state
- `runner_added` event: upserts (replace if runnerId matches, else append)
- `runner_removed` event: filters out by runnerId
- `runner_updated` event: merges (replace matching runner by runnerId)
- On unmount: `socket.disconnect()`

---

### 4. UI: `RunnerManager` Refactor (`packages/ui`)

**Remove:**
- `const [runners, setRunners]` local state
- `const [sessions, setSessions]` local state
- `fetchData` callback (entire function)
- `setInterval(fetchData, 10000)` effect
- `poll()` loop inside `handleSpawn` (waits for spawned session to appear)

**Add:**
- `const { runners } = useRunnersFeed()` — replaces local runners state
- New prop: `sessions: Array<{ sessionId: string; runnerId: string | null }>` — passed from App.tsx `liveSessions` (already from `/hub`). Narrow type: RunnerManager only uses `runnerId` for grouping and `sessionId` for the spawn-wait check. Using a narrow type avoids coupling RunnerManager to the full `HubSession` or `SessionInfo` shape.
- `const [pendingSessionId, setPendingSessionId] = React.useState<string | null>(null)` — tracks a spawning session
- `useEffect` on `sessions` + `pendingSessionId` → calls `onOpenSession(id)` when session appears, then clears
- `useEffect` timeout guard: after 30s, clears `pendingSessionId` if session never appeared

**`onRunnersChange` callback:** now called from a `useEffect` on `runners` instead of from `fetchData`.

**`sessionCount` computation:** `runners.map(r => ({ ...r, sessionCount: sessions.filter(s => s.runnerId === r.runnerId).length }))` — computed in render from props.

---

### 5. UI: `App.tsx` Changes

#### 5a. Remove all ad-hoc runner fetches

**On-mount eager fetch** (lines ~137–159): remove the `useEffect` that does `fetch("/api/runners")` on mount to pre-populate `runnersForSidebar`. `useRunnersFeed` inside `RunnerManager` provides this data on first WS connect.

**New-session dialog fetch** (`newSessionOpen` effect, lines ~352–385): the `runners` state (with `runnerId`, `name`, `roots`, `platform`) is now always fresh via `useRunnersFeed`. Remove the `fetch` and instead derive this from `useRunnersFeed` data. The `runners` state and `runnersLoading` state in App.tsx are replaced by the feed. The `NewSessionWizardDialog` receives the same `runners` array from the feed.

**`runnersLoading` state**: replaced by `useRunnersFeed`'s `status`. Loading is `status === 'connecting'`.

#### 5b. Replace `waitForSessionToGoLive` with hub-based waiter

Replace the polling `while`-loop implementation with a ref-based observer:

```typescript
// Pending session waiters
const sessionWaitersRef = React.useRef<Map<string, {
  resolve: (found: boolean) => void;
  timer: ReturnType<typeof setTimeout>;
}>>(new Map());

// Resolve waiters when liveSessions changes
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

No HTTP requests. Resolves as soon as the session appears on the `/hub` feed.

#### 5c. Pass sessions and runners to consumers

```tsx
<RunnerManager
  sessions={liveSessions}         // ← new prop (from /hub)
  onOpenSession={...}
  onRunnersChange={setSidebarRunners}
  selectedRunnerId={selectedRunnerId}
  onSelectRunner={setSelectedRunnerId}
/>
```

`TerminalManager` and `NewSessionWizardDialog` receive runners via props — see §6 and §7.

---

### 6. UI: `TerminalManager` Refactor (`packages/ui`)

**Remove:**
- `const [runners, setRunners]` local state
- `const [runnersLoading, setRunnersLoading]` local state
- `useEffect` that fires `fetch("/api/runners")` when `dialogOpen` changes

**Add:**
- New props: `runners: RunnerInfo[]` and `runnersLoading: boolean` — passed from App.tsx

App.tsx gets runner data from `useRunnersFeed()` and passes it down:
```tsx
const { runners: feedRunners, status: runnersStatus } = useRunnersFeed();
// ...
<TerminalManager
  runners={feedRunners}
  runnersLoading={runnersStatus === 'connecting'}
  // ...existing props...
/>
```

The `TerminalDialog` sub-component (which currently receives `runners` and `runnersLoading` as props from `TerminalManager`) is unchanged — it already accepts them as props.

---

### 7. UI: `SessionViewer` Slash Command Optimization (`packages/ui`)

The `/skills`, `/agents`, `/plugins`, and `/sandbox` slash command handlers in `SessionViewer` currently fire individual HTTP fetches. Since `runner_updated` events keep skills/agents/plugins in the WS feed, the data is already cached.

**Add prop:** `runnerInfo: RunnerInfo | null` — the full runner data for the session's runner, passed from App.tsx via `useRunnersFeed`. App.tsx already knows the session's `runnerId` from `liveSessions`.

**`/skills` command:** read `runnerInfo.skills` instead of `fetch("/api/runners/{id}/skills")`.

**`/plugins` command:** read `runnerInfo.plugins` instead of `fetch("/api/runners/{id}/plugins")`.

**`/agents` command:** read `runnerInfo.agents` instead of `fetch("/api/runners/{id}/agents")`.

**`/agents <name>` execution:** same — match against `runnerInfo.agents`.

**`@mention` agent popover:** same — use `runnerInfo.agents` instead of fetching.

**`/sandbox` command:** keep as HTTP fetch — sandbox status (violation counts, recent violations) is not part of `RunnerInfo` and is not in the WS feed. This is an intentional exception.

**`runnerInfo` derivation in App.tsx:**
```typescript
const activeRunnerInfo = React.useMemo(
  () => feedRunners.find(r => r.runnerId === activeSessionInfo?.runnerId) ?? null,
  [feedRunners, activeSessionInfo?.runnerId],
);
```

---

## Data Flow (After)

```
Runner daemon connects
  → /runner namespace: register_runner
  → registerRunner() in sio-registry
  → broadcastToRunnersNs("runner_added", runnerInfo, userId)
  → /runners namespace → useRunnersFeed → feedRunners state
  → RunnerManager, TerminalManager, NewSessionWizardDialog, SessionViewer all updated instantly

Runner daemon disconnects
  → /runner namespace: disconnect event
  → removeRunner() reads userId first, then deletes
  → broadcastToRunnersNs("runner_removed", { runnerId }, userId)
  → /runners namespace → useRunnersFeed filters out runner

Runner updates skills/agents/plugins
  → /runner namespace: skills_list / agent_list / plugins event
  → updateRunnerSkills/Agents/Plugins()
  → broadcastToRunnersNs("runner_updated", freshRunnerInfo, userId)
  → /runners namespace → useRunnersFeed upserts runner
  → SessionViewer slash commands and agent popover use fresh cached data

Session spawned
  → POST /api/runners/spawn → server creates session
  → session TUI connects → registerTuiSession()
  → broadcastToHub("session_added", sessionInfo, userId)
  → /hub namespace → SessionSidebar → onSessionsChange(setLiveSessions)
  → liveSessions useEffect in App.tsx → resolves sessionWaitersRef
  → waitForSessionToGoLive Promise resolves → handleOpenSession(id)

User opens new-session dialog or terminal dialog
  → no HTTP fetch — feedRunners already populated from /runners WS
```

---

## Error Handling

| Scenario | Behavior |
|----------|----------|
| `/runners` socket disconnects | `useRunnersFeed` status → `"disconnected"`, state preserved, Socket.IO auto-reconnects |
| Runner removed before `runner_updated` broadcast | `getRunnerState` returns null → skip broadcast silently |
| Spawned session never arrives (crash at spawn) | 30s timeout in `pendingSessionId` guard (RunnerManager) + `waitForSessionToGoLive` timeout |
| `liveSessions` empty when `waitForSessionToGoLive` is called | Waiter added to map, resolves on next hub `session_added` |

---

## Testing

### Protocol/Server
- `runner_added` fires when `registerRunner` succeeds
- `runner_removed` fires when `removeRunner` is called
- `runner_updated` fires after `updateRunnerSkills/Agents/Plugins` with fresh data
- `/runners` namespace sends `runners` snapshot on connect
- Only broadcasts to the correct user's room

### Client
- `useRunnersFeed`: upsert/remove/update behavior
- `waitForSessionToGoLive`: resolves via liveSessions, times out correctly
- `RunnerManager`: `pendingSessionId` clears when session appears in sessions prop
- `SessionViewer`: `/skills`, `/agents`, `/plugins` commands use cached `runnerInfo` data; `/sandbox` still uses HTTP fetch

---

## Files Changed

| File | Change |
|------|--------|
| `packages/protocol/src/runners.ts` | **New** — namespace event types |
| `packages/protocol/src/index.ts` | Export new types |
| `packages/server/src/ws/namespaces/runners.ts` | **New** — `/runners` namespace |
| `packages/server/src/ws/namespaces/index.ts` | Register new namespace |
| `packages/server/src/ws/sio-registry/runners.ts` | Add `broadcastToRunnersNs`, broadcast on register/remove/update |
| `packages/ui/src/lib/useRunnersFeed.ts` | **New** — hook connecting to `/runners` |
| `packages/ui/src/components/RunnerManager.tsx` | Remove polling + sessions fetch; use hook + sessions/runners props |
| `packages/ui/src/components/TerminalManager.tsx` | Remove `fetch("/api/runners")` on dialog open; accept runners prop |
| `packages/ui/src/components/SessionViewer.tsx` | Replace `/skills`, `/agents`, `/plugins` HTTP fetches with cached `runnerInfo` prop |
| `packages/ui/src/App.tsx` | Use `useRunnersFeed`; remove all ad-hoc runner fetches; hub-based `waitForSessionToGoLive`; pass sessions + runners + runnerInfo to children |
