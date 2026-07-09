# Audit: reference/architecture.mdx
Verdict: MAJOR ISSUES
Claims checked: 30 | Failed: 9

## Findings

### [P1] `packages/control-plane` does not exist
- Claim (line 64): "`packages/control-plane` | Multi-tenant provisioner — org management, JWT auth, Caddy config, and database migrations for hosted deployments"
- Reality: No `packages/control-plane` directory exists and it is not a workspace. Root `package.json` workspaces are `protocol, tunnel, tools, server, ui, cli, docs, mobile` (package.json:4-13). `find **/control-plane/**` returns nothing. The doc invents a package with specific features (JWT auth, Caddy config, migrations) that have no corresponding code. Additionally, the real `mobile` workspace is never mentioned in the Package Layout table.
- Fix: Remove the `control-plane` row (or restore the package if planned); add a `mobile` row for the Capacitor app.

### [P1] Subagent spawns an in-process session, not a `pi --mode json --no-session` child process
- Claim (line 235): "Spawn `pi --mode json --no-session` child process"
- Reality: The subagent tool creates an in-process `AgentSession` via `createAgentSession` + `session.prompt`. The source explicitly states "no child process, no JSON parsing, direct event access" (packages/cli/src/extensions/subagent/index.ts:4,11-12; engine.ts:283). There is no `spawn("pi", ["--mode","json","--no-session"])` anywhere in the subagent extension.
- Fix: Replace "Spawn `pi --mode json --no-session` child process" with "Creates an in-process AgentSession (createAgentSession + session.prompt) with an isolated context window".

### [P2] Subagent agent discovery omits the Claude Code compatibility dirs
- Claim (line 233): "Discover agents from ~/.pizzapi/agents/ and .pizzapi/agents/"
- Reality: Discovery scans four dirs, not two: `~/.pizzapi/agents/`, `~/.claude/agents/`, `.pizzapi/agents/`, `.claude/agents/` (packages/cli/src/extensions/subagent-agents.ts:7-12,199,220-225). The `.claude/agents/` and `~/.claude/agents/` dirs are Claude Code compatibility paths and are first-class.
- Fix: List all four dirs, or say "~/.pizzapi/agents/ and ~/.claude/agents/ (plus project-local .pizzapi/agents/ and .claude/agents/)".

### [P2] WebSocket API key is not sent in "connection headers"
- Claim (line 153): "All WebSocket connections from the CLI require a valid API key in the connection headers."
- Reality: The SIO control connection reads the key from `socket.handshake.auth?.apiKey` (Socket.IO auth payload), not headers (packages/server/src/ws/namespaces/auth.ts:44-49). The `/_tunnel` client sends the key in a `register` message after the socket opens, not in headers (packages/tunnel/src/client.ts:137; server verifies via `verifyApiKey` at packages/server/src/tunnel-relay.ts:77-86). Neither channel uses HTTP/WebSocket headers for the API key.
- Fix: Change to "…require a valid API key (sent via the Socket.IO handshake auth payload, or a register message on the tunnel channel)".

### [P2] `~/.claude/plugins/` is parsed via installed_plugins.json, not "scanned"
- Claim (line 290): "The adapter scans global dirs (`~/.pizzapi/plugins/`, `~/.agents/plugins/`, `~/.claude/plugins/`) automatically."
- Reality: Only `~/.pizzapi/plugins/` and `~/.agents/plugins/` are directory-scanned. `~/.claude/plugins/` is intentionally excluded from scanning and is instead read via `installed_plugins.json` (packages/cli/src/plugins/discover.ts:20,138-145,284-285). The code comment states "~/.claude/plugins/ is intentionally excluded here. Claude Code manages [it]".
- Fix: Say "scans ~/.pizzapi/plugins/ and ~/.agents/plugins/, and reads Claude Code's ~/.claude/plugins/installed_plugins.json manifest".

### [P2] Tunnel URL form omits the preferred runner-based route
- Claim (line 144): "When a browser requests `/api/tunnel/{sessionId}/{port}/{path}`…"
- Reality: Two route forms exist. The runner-based form `/api/tunnel/runner/:runnerId/:port/*` is the preferred, stable-across-session-switches form; the session-based form is legacy (packages/server/src/routes/tunnel.ts:2,9-10,26,29,45-49). The doc only describes the legacy form.
- Fix: Mention both forms, noting runner-based is preferred.

### [P3] Usage scanner also scans `~/.pi/agent/sessions/`
- Claim (line 173): "A scanner processes session JSONL files from `~/.pizzapi/agent/sessions/`…"
- Reality: The scanner scans both `~/.pizzapi/agent/sessions/` and `~/.pi/agent/sessions/` (packages/cli/src/usage/scanner.ts:375-376).
- Fix: Add "(and ~/.pi/agent/sessions/ for upstream pi sessions)".

### [P3] System overview diagram omits ntfy and the `ui`/`mobile` delivery surfaces
- Claim (lines 14-58): The Relay Server box shows only Bun HTTP/WS, Redis, SQLite; the browser box is the only client.
- Reality: `docker/compose.yml` runs `redis`, `ui` (nginx static dist pulled into the server), `server`, and `ntfy` (self-hosted push) services (docker/compose.yml:3-138). A Capacitor `mobile` workspace also exists (package.json:11). The diagram omits the push path and the separate UI image.
- Fix: Optionally add an ntfy node and note the mobile app; or keep the diagram simple but label it as simplified.

### [P3] "Replaced hand-rolled RFC 6455 parser" is an unsupported historical claim
- Claim (line 142): "Native `ws` library handles framing (replaced hand-rolled RFC 6455 parser)."
- Reality: The server does use the `ws` package (`WebSocketServer` from "ws", packages/server/src/tunnel-relay.ts:4,98), but no code or comment evidences a prior hand-rolled RFC 6455 parser. The "replaced" framing is unverifiable from the current repo.
- Fix: Drop the "replaced hand-rolled…" clause; just state "Native `ws` library handles WebSocket framing".

## Redesign notes
- The Package Layout table is the most error-prone section because it enumerates concrete packages; it should be generated or cross-checked against `package.json` workspaces + `ls packages/` rather than hand-maintained.
- The Subagent Execution diagram hard-codes an implementation detail (`pi --mode json --no-session`) that is false and brittle — architecture docs should describe the abstraction (isolated in-process AgentSession) not a specific CLI invocation that may change.
- The "connection headers" wording for WebSocket auth recurs across docs; consider standardizing on "handshake auth payload / register message" language sourced from the actual auth middleware.
- The Streaming Tunnel section describes only the legacy session-scoped URL; the runner-scoped URL is the recommended one and should lead the description.
- Several sections (Runner Services, Subagents, Claude Plugins) defer to dedicated guides — good — but the summary bullets in this page still need to stay in sync with those guides since readers may treat this page as authoritative.

## Code UX opportunities
- The tunnel client's "register after connect" auth means a misconfigured/old relay fails only after the socket is open with a generic message (packages/tunnel/src/client.ts:174). A clearer auth-failure reason from the relay (e.g., 401 on upgrade) would improve the `pizza web` upgrade hint UX.
- Plugin discovery has three precedence tiers with subtle differences (scan vs. manifest); a single `pizza plugins discover --verbose` that prints which source each plugin came from would help users debug why a plugin is/isn't loaded.
- Subagent limits (`maxParallelTasks`, `maxConcurrency`) are configurable but the architecture doc hard-codes "4 / 8" defaults — surfacing the effective limits in the `/agents` UI would prevent users from assuming fixed values.