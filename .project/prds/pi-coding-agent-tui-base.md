---
name: pi-coding-agent-tui-base
description: TUI-based coding agent CLI with remote session bridging, multi-provider LLM support, OAuth flows, and extensible configuration — built on pi-mono foundations.
status: backlog
created: 2026-02-19T17:15:03Z
---

# PRD: pi-coding-agent-tui-base

## Executive Summary

PizzaPi currently exposes a basic HTTP REST API wrapping `@mariozechner/pi-agent-core`. This PRD defines the **TUI Base** — a terminal user interface coding agent that mimics the interactive experience of Claude Code and OpenAI Codex CLI, extended with:

- **Multi-provider LLM support** across 10+ providers including OAuth-authenticated ones (Codex, GitHub Copilot, Gemini CLI, Antigravity)
- **Remote session bridging** so local TUI sessions can be shared to a browser UI, and the web UI can spawn new sessions on a remote host
- **Rich configuration**: provider/model selection, system prompt customization, tool permissions (incl. YOLO mode), key bindings, themes, MCP server support, and `.agents` folder support
- **Built on `@mariozechner/pi-tui`** for differential ANSI rendering with a web-UI-compatible component model

This is the foundational layer upon which all future PizzaPi UX is built.

---

## Problem Statement

### What problem are we solving?

The existing PizzaPi server is headless — it accepts a single message and returns a single response. There is no:
- Interactive terminal experience for developers to work with coding agents
- Way to switch models or providers mid-session
- Remote access to a running agent session from a browser
- OAuth-based authentication for subscription-backed providers (Codex, Copilot, etc.)
- Fine-grained tool permission control
- MCP (Model Context Protocol) integration
- Support for agent definitions via `.agents` folder

Developers who want a Claude Code / Codex-like experience with PizzaPi have no path forward today.

### Why now?

The pi-mono ecosystem (`@mariozechner/pi-tui`, `@mariozechner/pi-agent-core`, `@mariozechner/pi-ai`) already provides the building blocks. The market for coding agent CLIs is moving fast — Claude Code, Codex CLI, Gemini CLI, and GitHub Copilot are all competing. PizzaPi needs its own first-class terminal experience to serve as the foundation for hapi.run-style remote access.

---

## User Stories

### Primary Personas

**Persona A: Solo Developer (Local Power User)**
- Wants a Claude Code / Codex CLI replacement that works with any provider
- Needs to switch between Claude (for reasoning) and Codex (for coding, on subscription) in the same session
- Wants YOLO mode for trusted personal machines
- Wants to customize keybindings and themes

**Persona B: Team Lead / Operator (Remote Oversight)**
- Starts an agent session on their local machine and wants to share it with a teammate via a browser link
- Wants the web UI (hapi.run-style) to show the live TUI session
- Needs to spawn new agent sessions on a remote developer's machine from the web UI

**Persona C: Power Integrator**
- Wants MCP server support to connect custom tools
- Wants to define specialized agents via `.agents` folder (per-project agent personas)
- Wants to configure system prompts and tool permissions per agent

### User Journeys

**Journey 1: First Run (Local)**
1. Developer runs `pizzapi` in their project directory
2. If no config exists, prompted to select a provider and configure credentials
3. For API-key providers: enter key directly in TUI
4. For OAuth providers (Codex, Copilot, Gemini): browser opens for OAuth flow, token stored
5. TUI launches with interactive agent session
6. Developer types messages, agent responds with streaming output, tool calls shown inline
7. Developer uses `/model` to switch to a different provider mid-session

**Journey 2: Remote Session Sharing**
1. Developer has a local TUI session running
2. Types `/share` — TUI connects to the PizzaPi relay server and displays a shareable URL
3. Teammate opens the URL in browser — sees the live TUI session (read-only or collaborative based on config)
4. Session continues; all output is synced to browser in real-time

**Journey 3: Web UI Spawning New Session**
1. Operator opens the PizzaPi web UI (via hapi.run or self-hosted)
2. Web UI shows available Runner instances (remote machines with PizzaPi Runner daemon)
3. Operator clicks "New Session" on a remote Runner
4. Runner spawns a new agent session on that machine and streams TUI output back to browser

**Journey 4: MCP + .agents**
1. Developer has a `.agents/` folder in their project with an `architect.md` agent definition
2. Starts `pizzapi --agent architect` — agent is initialized with the custom system prompt and tool config
3. MCP servers listed in the project config are auto-connected, their tools available to the agent

### Pain Points Addressed
- No interactive experience today (REST-only)
- No subscription-backed provider support (Codex, Copilot need OAuth — API keys alone insufficient)
- No way to collaborate or observe a running agent session remotely
- No per-project agent customization

---

## Requirements

### Functional Requirements

#### FR-1: CLI Entry Point (`packages/cli`)
- New monorepo package: `@pizzapi/cli`
- Binary: `pizzapi` (or `pi`)
- Modes: interactive TUI (default), JSON/print (non-interactive), RPC (for external control)
- Reads config from `~/.pizzapi/` (global) and `.pi/` or `.pizzapi/` (project-local), following pi-coding-agent conventions

#### FR-2: TUI Rendering (via `@mariozechner/pi-tui`)
- Full differential ANSI rendering — no full-screen redraws on each update
- Components: message list (markdown-rendered), multi-line input editor, status bar (model, token usage, cost), tool call display
- Streaming output: tokens appear as they arrive from the LLM
- Tool calls: shown inline with collapsible details (command, stdout, result)
- Keyboard-driven navigation matching Claude Code conventions by default
- Configurable key bindings (stored in `~/.pizzapi/keybindings.json`)
- Theme support: bundled themes (dark, light, minimal) + custom theme files

#### FR-3: Multi-Provider LLM Support

**API Key Providers** (configure with `PROVIDER_API_KEY` env or via TUI):
- Anthropic (Claude 3.5, Claude 4.x)
- OpenAI (GPT-4o, o1, o3, o4)
- Google (Gemini 2.0 Flash, Gemini 2.5 Pro)
- Groq
- OpenRouter (multi-model gateway)
- Kimi for Coding / Moonshot AI (Anthropic-compatible API)

**Azure OpenAI (Responses API)**:
- Configure endpoint, deployment name, API key or managed identity

**OAuth-Authenticated Providers** (browser-based OAuth flow):
- **OpenAI Codex** (ChatGPT Plus/Pro subscription): OAuth via OpenAI; uses `codex` model subscription quota
- **GitHub Copilot**: OAuth via GitHub; uses Copilot subscription
- **Google Gemini CLI**: OAuth via Google account; uses Gemini CLI quota
- **Antigravity**: OAuth via Antigravity account

OAuth flow:
1. TUI displays "Opening browser for [Provider] authentication..."
2. Opens system browser to provider's OAuth authorization URL
3. Local callback server (random port) captures authorization code
4. Exchanges code for access + refresh tokens
5. Stores tokens in `~/.pizzapi/auth/<provider>.json` (encrypted at rest)
6. Refresh tokens automatically on expiry

#### FR-4: Session Management
- Sessions stored as JSONL files under `~/.pizzapi/sessions/`
- Session tree (branching) via `/fork` command
- Context compaction via `/compact` (manual) and auto-compaction when approaching context limit
- Session naming, listing, and resuming: `pizzapi --resume <session-id>`
- `/tree` command: visualize session branch history in TUI
- `/export` command: export session as markdown or JSON

#### FR-5: Tool Permissions & YOLO Mode
- Default: tool calls require implicit approval (tools run, results shown)
- YOLO mode: `--yolo` flag or config setting, disables all permission gates
- Per-tool allow/deny list in config
- Dangerous command detection (rm -rf, etc.) with confirmation prompt unless YOLO
- Tool execution sandboxing option: run bash tools in Docker container (optional, config-driven)

#### FR-6: MCP (Model Context Protocol) Support
- Config: `~/.pizzapi/mcp.json` (global) and `.pizzapi/mcp.json` (project-local)
- MCP server types: stdio (local process) and SSE (remote HTTP)
- Tools from MCP servers are surfaced to the agent as native tools
- `/mcp` command: list connected MCP servers and their available tools
- Graceful degradation if MCP server unavailable at startup

#### FR-7: `.agents` Folder Support
- Project-local agent definitions in `.agents/<name>.md`
- Each agent file has frontmatter: `name`, `description`, `system_prompt`, `model`, `tools`, `mcp`
- Launch with: `pizzapi --agent <name>`
- `/agents` command in TUI: list available agents and switch to one
- `.agents/default.md` is the default agent if present

#### FR-8: Remote Session Bridging
- **Local → Remote (Share)**: `/share` or `--share` flag exposes the TUI session via WebSocket relay
  - Relay server: the PizzaPi server (upgraded to support WebSocket)
  - TUI connects to relay, relay assigns a session ID and shareable URL
  - Browser opens the URL and receives live diff-rendered TUI output
  - Input from browser forwarded back to agent (configurable: read-only vs collaborative)
- **Remote Runner daemon** (`pizzapi runner`):
  - Background daemon that listens for WebSocket connections from the web UI
  - Web UI can request: list sessions, new session, attach to session, kill session
  - Runner spawns agent processes and bridges their stdin/stdout to WebSocket
  - Auth: token-based (`PIZZAPI_RUNNER_TOKEN` env var)

#### FR-9: Server WebSocket Extension
- Extend `packages/server` to handle WebSocket at `/ws/sessions`
- WebSocket message types: `new_session`, `attach`, `input`, `output_diff`, `session_list`, `kill_session`
- REST endpoints remain for backward compatibility
- JWT-based auth for WebSocket connections
- Session registry: tracks active sessions across Runner instances

#### FR-10: System Prompt & Persona Configuration
- Global default system prompt in `~/.pizzapi/config.json`
- Project-level override in `.pizzapi/config.json`
- `/system` command: view and edit system prompt inline in TUI
- System prompt supports variables: `{{cwd}}`, `{{git_branch}}`, `{{os}}`, `{{date}}`

### Non-Functional Requirements

#### NFR-1: Performance
- TUI startup time < 500ms (to interactive prompt)
- Differential rendering: < 16ms per render frame (60 FPS target)
- WebSocket latency for remote sessions: < 100ms additional overhead vs local
- OAuth flow: token exchange < 5s (network dependent)

#### NFR-2: Security
- OAuth tokens stored encrypted at rest (using OS keychain where available, fallback: AES-256 file encryption with machine key)
- WebSocket connections authenticated with JWT (15-minute expiry, refresh token pattern)
- YOLO mode requires explicit opt-in (flag or confirmed config change)
- MCP server connections validated against allowlist
- Runner daemon requires `PIZZAPI_RUNNER_TOKEN` to accept connections; no unauthenticated access

#### NFR-3: Compatibility
- Node.js 20+ and Bun 1.x (primary runtime)
- macOS, Linux (Windows via WSL2 as best-effort)
- Terminals: iTerm2, Terminal.app, kitty, tmux, VS Code integrated terminal
- Kitty keyboard protocol (enhanced modifier support) where available, fallback to standard

#### NFR-4: Extensibility
- Extension system: npm packages prefixed `pizzapi-ext-*` or local `.pizzapi/extensions/`
- Extensions can add: custom tools, slash commands, TUI components, custom providers
- Hot-reload of extensions via `/reload`

---

## Success Criteria

| Metric | Target |
|--------|--------|
| TUI startup to interactive prompt | < 500ms |
| Providers supported at launch | ≥ 10 (including 4 OAuth) |
| Remote session latency (vs local) | < 100ms overhead |
| Session share setup time | < 5s from `/share` to shareable URL |
| Config options exposed | Provider, model, system prompt, tools, keybindings, themes, MCP, agents |
| Parity with Claude Code core slash commands | `/new`, `/fork`, `/compact`, `/model`, `/share`, `/export`, `/system`, `/mcp`, `/agents` |
| YOLO mode available | ✅ |
| MCP protocol support | ✅ (stdio + SSE) |
| `.agents` folder support | ✅ |

---

## Constraints & Assumptions

- **pi-mono as foundation**: We build on `@mariozechner/pi-tui`, `@mariozechner/pi-agent-core`, `@mariozechner/pi-ai` — not reimplementing rendering or agent loop
- **Bun runtime**: Primary runtime is Bun for performance; Node.js compatibility maintained where possible
- **Relay server**: The remote sharing feature requires the PizzaPi server to be deployed (or a managed relay). Local-only use works without a relay.
- **OAuth provider APIs may change**: Codex, Copilot OAuth are not official stable APIs for third parties — implementations may need updating as providers evolve their auth flows
- **Subscription quotas**: Subscription-backed providers (Codex, Copilot) do not expose cost/token APIs in the same way as API-key providers — token tracking will be best-effort
- **MCP stability**: MCP spec is evolving; we target the latest stable MCP version at implementation time

---

## Out of Scope

- **Native mobile app**: TUI is terminal-only; mobile is not targeted
- **Custom LLM fine-tuning or model hosting**: We consume provider APIs; we do not host models (vLLM/pod management is a separate workstream)
- **Full collaborative editing**: Remote sessions are view/input sharing, not multiplayer code editing
- **Windows native (non-WSL)**: Windows support is WSL2 only for the TUI; the web UI is Windows-compatible
- **Billing/usage dashboard**: Cost tracking is informational in the TUI (token counters); no billing management UI
- **Extension marketplace**: Extensions are installed via npm or local path; no curated marketplace in this PRD
- **Voice input/output**: Text-only interaction in the TUI base
- **GitHub/GitLab integration beyond tool access**: No PR creation, issue management via TUI (those go through tools)

---

## Dependencies

### Internal
- `@pizzapi/tools` — existing tool implementations (bash, read-file, search, write-file)
- `packages/server` — must be extended with WebSocket support for remote bridging
- `packages/ui` — web UI counterpart that will connect to remote sessions (separate PRD)

### External (npm)
- `@mariozechner/pi-tui` ^0.53.0 — TUI rendering
- `@mariozechner/pi-agent-core` ^0.53.0 — agent runtime
- `@mariozechner/pi-ai` ^0.53.0 — multi-provider LLM API
- `@modelcontextprotocol/sdk` — MCP client
- Encryption library for OAuth token storage (TBD: `@noble/ciphers` or native `crypto`)

### Infrastructure
- PizzaPi relay server (deployed instance) for remote session sharing (can self-host)
- OAuth app registrations with: OpenAI, GitHub, Google, Antigravity (for Codex, Copilot, Gemini CLI, Antigravity flows)

### Team
- OAuth app credentials from each provider's developer portal
- Design input for TUI themes and default keybindings

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│                    packages/cli                          │
│  ┌─────────────┐  ┌──────────────┐  ┌───────────────┐  │
│  │  CLI Entry  │  │  pi-tui TUI  │  │ Session Mgr   │  │
│  │  (index.ts) │  │  Components  │  │ (JSONL files) │  │
│  └──────┬──────┘  └──────┬───────┘  └───────┬───────┘  │
│         │                │                   │          │
│  ┌──────▼───────────────▼───────────────────▼───────┐  │
│  │              Agent Core (pi-agent-core)           │  │
│  └──────┬────────────────────────────────────────────┘  │
│         │                                               │
│  ┌──────▼──────┐  ┌──────────────┐  ┌──────────────┐   │
│  │ pi-ai LLM   │  │ Tool Engine  │  │ MCP Client   │   │
│  │ (10+ provs) │  │ + YOLO mode  │  │ (stdio/SSE)  │   │
│  └─────────────┘  └──────────────┘  └──────────────┘   │
└─────────────────────┬───────────────────────────────────┘
                      │ WebSocket (remote sharing)
┌─────────────────────▼───────────────────────────────────┐
│                 packages/server                          │
│   REST /api/*  +  WebSocket /ws/sessions                 │
│   Session Registry + Runner Bridge                       │
└─────────────────────┬───────────────────────────────────┘
                      │
              Browser / packages/ui
              (hapi.run-style web UI)
```

---

## Open Questions

1. **OAuth relay for Codex**: OpenAI Codex OAuth may require registering a first-party app — what redirect URI does OpenAI allow for CLI tools? (device code flow may be needed as fallback)
2. **Runner daemon distribution**: Should `pizzapi runner` be distributed as a separate binary/service, or always installed with the main CLI?
3. **Relay server hosting**: Is the relay bundled with `packages/server`, or does it need to be a separate globally-deployed service?
4. **Keybinding defaults**: Should defaults match Claude Code (e.g., Escape to cancel), Codex CLI, or PizzaPi-specific?

---

## Next Steps

Ready to create implementation epic? Run: `/pm:prd-parse pi-coding-agent-tui-base`
