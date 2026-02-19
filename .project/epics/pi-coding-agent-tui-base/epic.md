---
name: pi-coding-agent-tui-base
status: backlog
created: 2026-02-19T17:18:14Z
progress: 0%
prd: .project/prds/pi-coding-agent-tui-base.md
beads_id: [Will be updated when synced to Beads]
---

# Epic: pi-coding-agent-tui-base

## Overview

`@mariozechner/pi-coding-agent` already delivers the full TUI coding agent experience: all 10+ providers, OAuth flows (`/login`), session management, branching, slash commands, themes, keybindings, MCP, `.agents` support, YOLO mode. We use it as the foundation — not a dependency to wrap, but the **actual running CLI** — and extend it via its official extension API and SDK.

PizzaPi's unique value is the **Remote Runner**: the ability to start a session locally and share it to a browser (hapi.run-style), or spawn new sessions on a remote machine from the web UI. That's what this epic builds on top of pi-coding-agent.

The epic is 3 tasks: scaffold the PizzaPi launcher, add session sharing, add the runner daemon.

---

## Architecture Decisions

### 1. `@mariozechner/pi-coding-agent` as the TUI engine
We add `@mariozechner/pi-coding-agent` to the monorepo and use its SDK (`createAgentSession()` + full TUI run mode). All provider auth, session management, slash commands, and TUI rendering come for free. We do NOT reimplement any of this.

### 2. `packages/cli` is a thin PizzaPi launcher
The new `@pizzapi/cli` package contains:
- A `pizzapi` binary entry point
- PizzaPi-specific defaults: config dir (`~/.pizzapi/`), system prompt, model defaults
- `.agents/*.md` wired via `DefaultResourceLoader.agentsFilesOverride`
- Loads the PizzaPi Remote extension before starting the TUI

### 3. Remote sharing via a pi-coding-agent extension
The `/share` command and session relay are implemented as a **pi extension** registered at startup via the SDK. The extension:
- Registers a `/share` slash command
- When invoked, connects to the PizzaPi relay server (WebSocket) and streams TUI output diffs
- Receives input events from browser clients and forwards them to the session

### 4. Remote Runner is a separate sub-command
`pizzapi runner` is a standalone mode (not the TUI) that runs a WebSocket daemon. It accepts connections from the web UI and spawns new `createAgentSession()` instances on demand, bridging their output to WebSocket clients.

### 5. Server WebSocket via Bun native API
Extend `packages/server` with a `/ws/sessions` WebSocket upgrade handler (no new library — Bun supports this natively). The server acts as the relay: browser ↔ server ↔ local TUI session.

---

## Technical Approach

### Package Structure
```
packages/
  cli/                          # NEW: @pizzapi/cli
    src/
      index.ts                  # Entry: dispatch to tui | runner modes
      config.ts                 # Merge ~/.pizzapi/ + .pizzapi/ config
      extensions/
        remote.ts               # Pi extension: /share command + WS relay client
      runner/
        daemon.ts               # 'pizzapi runner' WebSocket daemon
        bridge.ts               # Session ↔ WebSocket output bridge
    package.json                # bin: pizzapi, dep: @mariozechner/pi-coding-agent
    tsconfig.json
  server/                       # EXISTING: add WebSocket relay
    src/
      index.ts                  # Add /ws/sessions upgrade handler
      ws/
        registry.ts             # Active shared session registry
        relay.ts                # Browser ↔ TUI relay logic
```

### Data Flow: Session Sharing
```
Local TUI session (pi-coding-agent SDK)
    ↓ extension hooks (output diffs)
PizzaPi remote extension (packages/cli/src/extensions/remote.ts)
    ↓ WebSocket client
packages/server /ws/sessions (relay)
    ↓ WebSocket server
Browser (packages/ui)
```

### Data Flow: Runner Daemon
```
Browser → POST /ws/sessions {new_session}
packages/server relay → packages/cli runner daemon (WebSocket)
runner daemon → createAgentSession() → new pi TUI session
session output → WebSocket → relay → browser
```

---

## Implementation Strategy

1. **Task 001 first** — get `pizzapi` running locally with pi-coding-agent TUI; validate all provider/auth/session features work through our launcher
2. **Task 002 next** — add `/share` and the relay server; test local→browser sharing
3. **Task 003 last** — Runner daemon; test web UI→remote session spawning

### Risk Mitigation
- pi-coding-agent SDK API may differ from docs at v0.53.0 → read installed types at `node_modules/@mariozechner/pi-coding-agent/` before implementing
- Extension API for intercepting output diffs may be limited → fallback: implement sharing via `session.subscribe()` events in the SDK, bypassing the extension system
- Browser-originated session auth → JWT approach, validated by relay before forwarding to runner

---

## Task Breakdown

- [ ] **001: CLI Package Scaffold** — Create `packages/cli`, add `@mariozechner/pi-coding-agent` dep, `pizzapi` binary that launches pi-coding-agent's full TUI mode with PizzaPi config defaults (config dir, system prompt, model defaults, `.agents` wiring)
- [ ] **002: Remote Session Sharing** — Pi extension registering `/share` command + WS relay client; upgrade `packages/server` with `/ws/sessions` WebSocket handler and relay logic; JWT auth
- [ ] **003: Remote Runner Daemon** — `pizzapi runner` sub-command: WebSocket daemon that accepts web-UI connections and spawns/bridges `createAgentSession()` instances on demand; bearer token auth

---

## Dependencies

```
001 (CLI scaffold) → 002 (sharing) → 003 (runner)
                                  ↗
                     server WebSocket upgrade
```

### External Prerequisites
- OAuth app credentials for Codex, Copilot, Gemini CLI, Antigravity (for `/login` flows — these work via pi-coding-agent itself once configured)
- PizzaPi relay server deployed (or running locally for dev)

---

## Success Criteria (Technical)

| Criterion | Acceptance Test |
|-----------|----------------|
| `pizzapi` starts full TUI via pi-coding-agent | Run `pizzapi`, get interactive chat |
| All pi-coding-agent providers available | `/model` lists Anthropic, OpenAI, Codex, Copilot, etc. |
| `/share` produces accessible browser URL | `pizzapi` → `/share` → browser opens live session |
| Browser input forwarded to agent | Type in browser, agent responds |
| `pizzapi runner` accepts new_session from web UI | POST to relay → new TUI session spawned |
| Session output streams to browser in real-time | Verify diffs arrive < 100ms after terminal output |

---

## Estimated Effort

| Task | Complexity | Notes |
|------|-----------|-------|
| 001: CLI Scaffold | S | Mostly config wiring; pi-coding-agent does the heavy lifting |
| 002: Session Sharing | M | Extension API + server WebSocket + relay logic |
| 003: Runner Daemon | M | Novel code; session lifecycle management |

**Critical Path**: 001 → 002 → 003

## Tasks Created

- [ ] 001.md - CLI Package Scaffold (parallel: false)
- [ ] 002.md - Remote Session Sharing (parallel: false)
- [ ] 003.md - Remote Runner Daemon (parallel: false)

Total tasks: 3
Parallel tasks: 0
Sequential tasks: 3
Estimated total effort: ~6-8 days
