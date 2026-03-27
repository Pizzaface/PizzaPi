# Dish 003: UI useServiceChannel Hook + Panel Refactors

- **Cook Type:** claude-sonnet-4-6
- **Complexity:** L
- **Godmother ID:** 9mOLVdjU (Phase 3)
- **Dependencies:** 002 (service_message relay channel)
- **Band:** B (dispatchPriority=normal)
- **Status:** served ✅

## Task Description

Create a `useServiceChannel(serviceId)` React hook in `packages/ui/` that provides typed send/receive over the relay service_message envelope. Then refactor the existing Terminal, FileExplorer, and Git panels to use it.

### Before You Start

Study these files:
- `packages/ui/src/components/WebTerminal.tsx` — terminal component
- `packages/ui/src/components/TerminalManager.tsx` — terminal state management
- `packages/ui/src/components/FileExplorer.tsx` — file explorer
- `packages/ui/src/components/RunnerDetailPanel.tsx` — may contain git tab
- `packages/ui/src/components/CombinedPanel.tsx` — panel container
- How the socket is accessed in UI (likely through a context or store)

Find how the socket.io connection to the relay viewer namespace is managed in the UI. This is the socket you'll use in the hook.

### Step 1: Create useServiceChannel hook

Create `packages/ui/src/hooks/useServiceChannel.ts`:

```typescript
import { useEffect, useCallback, useRef } from "react";
// Import the socket context/hook used by the rest of the UI

export interface ServiceChannelOptions<TReceive = unknown> {
    /** Called when a service_message arrives for this serviceId */
    onMessage?: (type: string, payload: TReceive, requestId?: string) => void;
}

export interface ServiceChannel<TSend = unknown> {
    /** Send a message to the runner service */
    send: (type: string, payload: TSend, requestId?: string) => void;
    /** Check if the service is available on the current runner */
    available: boolean;
}

/**
 * Hook providing typed send/receive over the relay service_message channel
 * for a specific service (identified by serviceId).
 * 
 * @param serviceId - Service identifier (e.g., "terminal", "file-explorer", "git")
 * @param options - Callback for incoming messages
 */
export function useServiceChannel<TSend = unknown, TReceive = unknown>(
    serviceId: string,
    options: ServiceChannelOptions<TReceive> = {}
): ServiceChannel<TSend> {
    const { onMessage } = options;
    // Get socket from context
    // Subscribe to service_message events
    // Filter by serviceId
    // Provide send function that emits service_message
    // Track available from service_announce events
}
```

Key design decisions:
- The hook wraps the existing socket (whatever socket the UI uses for viewer)
- Subscribe/unsubscribe in useEffect cleanup
- `available` tracks whether the runner announced this serviceId via `service_announce`
- `send()` emits `{ serviceId, type, payload, requestId }` via the viewer socket

### Step 2: Create service-specific typed wrappers

Create typed wrappers for each service:

`packages/ui/src/hooks/useTerminalService.ts`:
```typescript
export function useTerminalChannel(terminalId: string) {
    return useServiceChannel<TerminalSend, TerminalReceive>("terminal", {
        onMessage: (type, payload) => { /* handle terminal events */ }
    });
}
```

### Step 3: Refactor WebTerminal / TerminalManager

The goal is for the terminal components to OPTIONALLY use `useServiceChannel` for the service_message path, while keeping the existing direct socket event path as fallback.

**DO NOT break existing terminal functionality.** Implement it as an enhancement:

```typescript
// Inside WebTerminal or TerminalManager:
const { send, available } = useServiceChannel("terminal", {
    onMessage: (type, payload) => {
        if (type === "terminal_data") {
            // handle terminal data from envelope
        }
        // etc.
    }
});

// When sending input:
// If service channel available, use envelope; otherwise use legacy event
if (available) {
    send("terminal_input", { terminalId, data: inputData });
} else {
    socket.emit("terminal_input", { terminalId, data: inputData });
}
```

The key: existing behavior is PRESERVED. The hook is additive. Both paths (legacy named events AND service_message envelope) work simultaneously.

### Step 4: Refactor FileExplorer

In `packages/ui/src/components/FileExplorer.tsx`:

```typescript
const { send, available } = useServiceChannel("file-explorer", {
    onMessage: (type, payload) => {
        if (type === "file_result") {
            // handle file result
        }
    }
});

// When requesting files — use envelope if available, fallback to named event
const listFiles = useCallback((path: string) => {
    const requestId = generateRequestId();
    if (available) {
        send("list_files", { path, requestId });
    } else {
        socket.emit("list_files", { path, requestId });
    }
}, [available, send]);
```

### Step 5: Create TunnelPanel

Create `packages/ui/src/components/TunnelPanel.tsx`:

A panel showing available port tunnels on the current runner.
Uses `useServiceChannel("tunnel")`.

```typescript
export function TunnelPanel({ sessionId }: { sessionId: string }) {
    const [tunnels, setTunnels] = useState<TunnelInfo[]>([]);
    const { send, available } = useServiceChannel<TunnelSend, TunnelReceive>("tunnel", {
        onMessage: (type, payload) => {
            if (type === "tunnel_list") {
                setTunnels((payload as any).tunnels ?? []);
            }
        }
    });
    
    // Fetch tunnel list on mount
    useEffect(() => {
        if (available) send("tunnel_list", {});
    }, [available]);
    
    if (!available) return null;
    
    return (
        <div>
            <h3>Port Tunnels</h3>
            {tunnels.map(tunnel => (
                <div key={tunnel.port}>
                    <span>{tunnel.name ?? `Port ${tunnel.port}`}</span>
                    <a href={`/api/tunnel/${sessionId}/${tunnel.port}/`} target="_blank">
                        Open ↗
                    </a>
                </div>
            ))}
        </div>
    );
}
```

### Step 6: Wire TunnelPanel into CombinedPanel or RunnerDetailPanel

Add TunnelPanel as a tab/section in the panel that shows terminal/file explorer — but only render it when the tunnel service is available (use `available` from the hook to conditionally show the tab).

### Constraints
- **Preserve all existing terminal/file/git behavior** — dual-path approach (envelope + legacy named events)
- **No TypeScript errors** — run `bun run typecheck`
- **No test regressions** — run `bun test packages/ui`
- Use whatever socket context/hook the existing panels use — don't introduce a new socket connection

## Result
- **PR:** https://github.com/Pizzaface/PizzaPi/pull/319
- **Files:** 4 changed
- **Tests:** 611 pass, 0 fail
- **Notes:** ViewerSocketContext + useServiceChannel hook + TunnelPanel wired into CombinedPanel

## Critic Review (Round 1)
- **Critic:** gpt-5.3-codex (c25c0686) — SEND BACK
- **P1-1:** No `socket.on("disconnect")` handler — `available` stays `true` after socket disconnects
- **P1-2:** `service_announce` can be dropped if no sessions in `runnerSessionIds` yet — viewers may never get it, leaving `available` stuck `false`
- **Fix scope:** P1-1 is UI-only. P1-2 requires both UI reset-on-connect AND daemon re-announce at session_ready
- **All other checks passed:** context re-renders on socket change, protocol names correct, URL correct, tests pass

## Kitchen Disconnect
- **Root cause:** Incomplete socket lifecycle — announce handled, disconnect/reconnect not
- **Category:** missing-context (hook needs to mirror socket connection lifecycle, not just announce events)
- **Detail:** service_announce correctly sets available=true, but no mechanism to reset it on disconnect. Reconnect also needs a reset to wait for fresh announce.
- **Prevention:** Spec should list ALL socket events the hook must respond to: announce (set true), disconnect (set false), connect/reconnect (reset to false).

## Fix Applied
- Added disconnect→false and connect→false handlers
- All 4 listeners cleaned up in useEffect teardown
- Tests: 611 pass, 0 fail

## Fixer Result (Round 1 — commit c0bf87f)
- Added handleDisconnect → setAvailable(false)
- Added handleConnect → setAvailable(false)
- All 4 listeners cleaned up in useEffect teardown
- 611 tests pass, 0 fail

## Critic Review (Round 2)
- **Critic:** gpt-5.3-codex (d9c9c22b) — SEND BACK
- **P1:** Dish 002 fixer commits (c1b57d6, f5bbe72, fb299b8) not in Dish 003 worktree — stale merge
  - daemon.ts still has service_announce at old location (line 242, after registry.initAll)
  - Missing: service_announce in runner_registered, re-announce at session_ready
- **Root cause:** Dish 003 worktree merged Dish 002 at 4ed0e42; three subsequent fixer commits not pulled
- **Fix:** `git merge nightshift/dish-002-relay-service-envelope --no-edit`

## Kitchen Disconnect (Round 2)
- **Root cause:** Stale merge — worktree branched off Dish 002 before fixer commits landed
- **Category:** missing-context (dependency branch was still in-flight when Dish 003 was dispatched)
- **Prevention:** Dispatch dependent dishes only after dependency is fully served, or refresh merge before dispatching critic

## Fix Applied (Round 2 — merge-forward)
- git merge nightshift/dish-002-relay-service-envelope
- daemon.ts now has service_announce in runner_registered + session_ready
- All FileExplorer + Git paths use emitFileResult helper
- Tests: 611 pass, 0 fail

## Fixer Result (Round 2 — commit 773ab5f)
- git merge nightshift/dish-002-relay-service-envelope — clean, no conflicts
- service_announce: runner_registered (line 320) + session_ready (line 417)
- file_result: 1 hit each (helper only)
- 611 tests pass

## Critic Review (Round 3 — FINAL)
- **Critic:** gpt-5.3-codex (c9006624) — **LGTM ✅**
- All 5 checks confirmed: service_announce timing, helper pattern, 4 listeners, TunnelPanel, 611 tests

## Health Inspection — 2026-03-25
- **Inspector Model:** claude-opus-4-6
- **Verdict:** CITATION
- **Findings:**
  - P2: Stale tunnels displayed after reconnect — `if (!available) return null` suppresses render but doesn't clear `tunnels` state; user can interact with dead entries until `tunnel_list` response arrives
  - P2: `send()` in `useServiceChannel` doesn't guard on `available` — future consumers without null-render guard will silently emit to nowhere
  - P3: Unsafe payload casts in TunnelPanel without array/type validation
  - P3: `sessionId` not `encodeURIComponent`'d in tunnel URL construction
- **Critic Missed:** P2 stale tunnel state on reconnect (critics caught hook lifecycle for `available` but missed downstream state reset)
