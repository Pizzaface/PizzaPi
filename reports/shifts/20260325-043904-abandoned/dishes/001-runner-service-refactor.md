# Dish 001: Runner Service System Phase 1 Refactor

- **Cook Type:** claude-sonnet-4-6
- **Complexity:** L
- **Godmother ID:** 9mOLVdjU
- **Dependencies:** none
- **Band:** A (dispatchPriority=high)
- **Files:** 
  - `packages/cli/src/runner/service-handler.ts` (new)
  - `packages/cli/src/runner/services/terminal-service.ts` (new)
  - `packages/cli/src/runner/services/file-explorer-service.ts` (new)
  - `packages/cli/src/runner/services/git-service.ts` (new)
  - `packages/cli/src/runner/daemon.ts` (shrink from ~1253 to <600 lines)
- **Verification:** `bun run typecheck` && `bun test packages/cli`
- **Status:** served

## Task Description

Extract three service handlers from `packages/cli/src/runner/daemon.ts` into a shared ServiceHandler pattern.

### Background

`daemon.ts` (1253 lines) has three inline service handler groups wired directly into the main socket event loop:

1. **Terminal** (~lines 521-612): `new_terminal`, `terminal_input`, `terminal_resize`, `kill_terminal`, `list_terminals`
2. **FileExplorer** (~lines 856-1020): `list_files`, `search_files`, `read_file`
3. **Git** (~lines 1021-1123): `git_status`, `git_diff`

The goal is to extract these into a shared ServiceHandler pattern, giving each service its own file and wiring them back via a ServiceRegistry.

### Step 1: Create ServiceHandler interface + ServiceRegistry

Create `packages/cli/src/runner/service-handler.ts`:

```typescript
import type { Socket } from "socket.io-client";

/**
 * Interface for runner-side service handlers.
 * Each service registers its socket event handlers in init() and cleans up in dispose().
 */
export interface ServiceHandler {
    /** Unique service identifier (e.g., "terminal", "file-explorer", "git") */
    readonly id: string;
    
    /**
     * Initialize the service — register socket event listeners and perform setup.
     * Called once per socket connection.
     */
    init(socket: Socket, options: ServiceInitOptions): void;
    
    /**
     * Clean up the service — kill processes, clear state, remove listeners.
     * Called on socket disconnect or daemon shutdown.
     */
    dispose(): void;
}

export interface ServiceInitOptions {
    isShuttingDown: () => boolean;
}

/**
 * Generic relay protocol envelope.
 * All service messages flow through this shape even though the socket events
 * themselves don't change (Phase 1 is internal-only — relay stays unchanged).
 */
export interface ServiceEnvelope {
    serviceId: string;
    type: string;
    requestId?: string;
    payload: unknown;
}

/**
 * Registry of service handlers. The daemon uses this to register and dispose services.
 */
export class ServiceRegistry {
    private handlers = new Map<string, ServiceHandler>();

    register(handler: ServiceHandler): void {
        if (this.handlers.has(handler.id)) {
            throw new Error(`ServiceRegistry: duplicate service id "${handler.id}"`);
        }
        this.handlers.set(handler.id, handler);
    }

    get(id: string): ServiceHandler | undefined {
        return this.handlers.get(id);
    }

    getAll(): ServiceHandler[] {
        return Array.from(this.handlers.values());
    }

    /**
     * Initialize all registered services against the given socket.
     */
    initAll(socket: Socket, options: ServiceInitOptions): void {
        for (const handler of this.handlers.values()) {
            handler.init(socket, options);
        }
    }

    /**
     * Dispose all registered services (e.g., on disconnect or shutdown).
     */
    disposeAll(): void {
        for (const handler of this.handlers.values()) {
            try {
                handler.dispose();
            } catch (err) {
                // Log but don't rethrow — we want all services to dispose
                console.error(`[ServiceRegistry] dispose error for service "${handler.id}":`, err);
            }
        }
    }
}
```

### Step 2: Create TerminalService

Create `packages/cli/src/runner/services/terminal-service.ts`:

Move the terminal socket handlers from daemon.ts (lines ~521-612) into this class.
The terminal module (`terminal.ts`) already exists — it stays. Only the socket event wiring moves here.

```typescript
import type { Socket } from "socket.io-client";
import type { ServiceHandler, ServiceInitOptions } from "../service-handler.js";
import {
    spawnTerminal,
    writeTerminalInput,
    resizeTerminal,
    killTerminal,
    killAllTerminals,
    listTerminals,
} from "../terminal.js";
import { isCwdAllowed } from "../workspace.js";
import { logInfo, logWarn, logError } from "../logger.js";

export class TerminalService implements ServiceHandler {
    readonly id = "terminal";

    init(socket: Socket, { isShuttingDown }: ServiceInitOptions): void {
        socket.on("new_terminal", (data: any) => { /* ... */ });
        socket.on("terminal_input", (data: any) => { /* ... */ });
        socket.on("terminal_resize", (data: any) => { /* ... */ });
        socket.on("kill_terminal", (data: any) => { /* ... */ });
        socket.on("list_terminals", () => { /* ... */ });
    }

    dispose(): void {
        killAllTerminals();
    }
}
```

Key detail for `new_terminal`: The `termSend` callback needs to emit onto the socket. The socket reference must be captured from the `init()` call. This is fine since socket is passed to `init()`.

### Step 3: Create FileExplorerService

Create `packages/cli/src/runner/services/file-explorer-service.ts`:

Move `list_files`, `search_files`, `read_file` handlers from daemon.ts (lines ~856-1020).

```typescript
import type { Socket } from "socket.io-client";
import type { ServiceHandler, ServiceInitOptions } from "../service-handler.js";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { execFileAsync } from "../exec-utils.js"; // or inline
import { isCwdAllowed } from "../workspace.js";
import { logInfo, logWarn } from "../logger.js";
```

Note: `execFileAsync` is defined inline in daemon.ts at the top. Either re-export it from a shared utils file or just redeclare it in file-explorer-service.ts as well.

### Step 4: Create GitService

Create `packages/cli/src/runner/services/git-service.ts`:

Move `git_status` and `git_diff` handlers from daemon.ts (lines ~1021-1123).

The `git_status` handler is complex — it runs 4 git commands in parallel (branch, status, diff-staged, ahead/behind) and also fetches recent log entries. Move all of this logic as-is.

### Step 5: Wire in daemon.ts

In `daemon.ts`:
1. Import `ServiceRegistry`, `TerminalService`, `FileExplorerService`, `GitService`
2. Create registry at the top of `runDaemon()`, register the three services
3. After socket connect, call `registry.initAll(socket, { isShuttingDown: () => isShuttingDown })`
4. On disconnect, call `registry.disposeAll()`
5. Remove the ~600+ lines of extracted handler code

The daemon's current `killAllTerminals()` call in the shutdown handler should become `registry.disposeAll()` (which TerminalService.dispose() calls killAllTerminals internally).

### Constraints

- **Do NOT change the relay/server side** — socket events stay exactly the same
- **Do NOT change terminal.ts** — it stays as-is
- **All existing functionality must work identically** — same socket events, same payloads
- **Target:** daemon.ts shrinks from ~1253 to <600 lines
- **TypeScript strict** — no `any` types where avoidable on new code, use proper types
- **Tests:** Add test stubs for ServiceRegistry if practical; primary verification is typecheck + existing tests
- **execFileAsync** is defined in daemon.ts top-level — either move it to a shared util or redeclare where needed

### Gotcha: isShuttingDown

In daemon.ts, `isShuttingDown` is a local variable (not a function). You'll need to change the ServiceInitOptions to accept it as either a value OR a getter function. The simplest approach: pass `() => isShuttingDown` (a getter closure) to `initAll()`, matching the interface above.

### Verification Commands

```bash
cd packages/cli && bun run typecheck 2>&1 | tail -20
bun test packages/cli 2>&1 | tail -30
wc -l packages/cli/src/runner/daemon.ts  # Must be < 600
```

## Scope Context (Added Post-Dispatch)
Cook is working with Phase 1 constraints (relay unchanged). Phases 2-4 will adapt on top.
The ServiceHandler interface (init(socket, options)) is correct as-is — Phase 2 adds envelope emission.

## Result
- **PR:** https://github.com/Pizzaface/PizzaPi/pull/315
- **Lines:** 1253 → 892 (–361)
- **Notes:** <600 target not met — skills/agents/sandbox handlers remain (not in Phase 1 scope)

## Critic Review
- **Critic:** gpt-5.3-codex (4ac80cb3)
- **Verdict:** SEND BACK (P1 flagged)
- **Maître d' Adjudication:** FALSE POSITIVE — override to LGTM
  - P1: "disposeAll() not called on disconnect" — incorrect. Calling disposeAll() on disconnect would kill active terminals on every Socket.IO reconnect (transient network drops). Original daemon never called killAllTerminals() in disconnect handler. Socket.IO handlers persist across reconnects on same socket object. Cook correctly preserved this.
- **Final:** SERVED ✅

## Health Inspection — 2026-03-25
- **Inspector Model:** claude-opus-4-6
- **Verdict:** CITATION
- **Findings:**
  - P2: `dispose()` does not remove socket event listeners — if Phase 2+ introduces per-connection init/dispose cycling, `initAll` will double-register every listener
  - P3: `ServiceEnvelope` type is exported but unused dead code in Phase 1
  - P3: Redundant `(data as any)` casts in FileExplorer and GitService
- **Critic Missed:** P2 listener cleanup risk (critic's actual P1 finding was a false positive — correctly overridden by Maître d')
