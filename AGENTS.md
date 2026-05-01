# PizzaPi — Agent Guide

PizzaPi is a self-hosted web interface and relay server for the [`pi` coding agent](https://github.com/badlogic/pi-mono). It streams live agent sessions to any browser and allows remote interaction from mobile or desktop without needing terminal access.

---

## Repository Layout

```
packages/
  cli/      CLI wrapper — launches pi with PizzaPi extensions and the runner daemon
  server/   Bun HTTP + WebSocket relay server (auth, session relay, attachments)
  ui/       React 19 PWA web interface (Vite, TailwindCSS v4, Radix UI / shadcn)
  tools/    Shared agent tools (bash, read-file, write-file, search, toolkit)
  docs/     Starlight (Astro) documentation site — https://pizzaface.github.io/PizzaPi/
  npm/      npm distribution — builds & publishes `npx pizzapi` packages

docker/     Docker Compose (redis + server services)
patches/    Bun patches for upstream pi packages (auto-applied on bun install)
```

Build order: `tools` → `server` → `ui` → `cli`.

---

## Documentation Site

User-facing documentation lives in `packages/docs/` — a [Starlight](https://starlight.astro.build/) (Astro) site deployed to GitHub Pages.

- **Source**: `packages/docs/src/content/docs/` (`.mdx` files)
- **Config**: `packages/docs/astro.config.mjs`
- **Build**: `cd packages/docs && bun run build`
- **Dev**: `cd packages/docs && bun run dev`
- **Live site**: https://pizzaface.github.io/PizzaPi/

**When changing CLI commands, flags, config options, or self-hosting behavior, always update the corresponding docs pages:**

| Topic | Doc page |
|-------|----------|
| CLI commands & flags | `running/cli-reference.mdx` |
| Config, env vars | `customization/configuration.mdx` |
| MCP servers | `customization/mcp-servers.mdx` |
| Hooks | `customization/hooks.mdx` |
| Skills | `customization/skills.mdx` |
| Agent definitions | `customization/agent-definitions.mdx` |
| Claude plugins | `customization/claude-plugins.mdx` |
| Subagents | `customization/subagents.mdx` |
| `pizza web`, Docker | `deployment/self-hosting.mdx` |
| Tailscale HTTPS | `deployment/tailscale.mdx` |
| Runner daemon | `running/runner-daemon.mdx` |
| Installation | `start-here/installation.mdx` |
| Sandbox & safe mode | `security/sandbox.mdx` |
| Architecture | `reference/architecture.mdx` |
| Server env vars | `reference/environment-variables.mdx` |

The README is intentionally slim — it has a quick start and links to the docs site. **Do not duplicate detailed docs in the README.**

---

## Tech Stack

| Layer | Technology |
|-------|------------|
| Runtime / package manager | **Bun** (required — not Node/npm/yarn) |
| Language | TypeScript (strict mode, ESM throughout) |
| Server | Bun.serve, better-auth, Kysely + SQLite, Redis, web-push |
| UI | React 19, Vite 6, TailwindCSS v4, Radix UI, shadcn/ui, streamdown |
| Agent core | `@mariozechner/pi-coding-agent`, `@mariozechner/pi-ai`, `@mariozechner/pi-tui` |

---

## Common Commands

```bash
# Install dependencies
bun install

# Build everything
bun run build

# Development (server + UI, hot-reload)
bun run dev

# Type-check all packages
bun run typecheck

# Run DB migrations
bun run migrate

# Clean all dist/ directories
bun run clean
```

---

## Development Notes

- **Always use `bun`** — no Node, npm, yarn, or pnpm.
- **Build order**: `tools` must be built before `server` or `cli`; `ui` can be built in parallel with `server`.
- **TypeScript**: run `bun run typecheck` to check all packages at once.
- **Patches**: Never edit files inside `node_modules` directly — changes go in `patches/` and are applied via `bun install`.
- **Turn/lifecycle semantics matter**: When changing tools, prompts, models, or other agent capabilities at runtime, verify exactly *when* the change becomes visible to the next assistant response. Do not assume a setter like `setActiveTools()` is immediate inside the current loop — add an integration test that crosses the boundary you are changing.
- **Redis** is required for the server. For local dev without Docker: `redis-server` or `docker compose up redis`.
- **Do not repoint sandbox/test harnesses at an existing user or production Redis instance** (for example `redis://127.0.0.1:6379`) without explicit user permission. Sandboxes must use their own isolated Redis and must not assume the user's local Redis is safe to reuse.
- **Database migrations**: run `bun run migrate` after schema changes. DB file is `packages/server/auth.db`.
- **UI + TUI for every feature**: Custom features should include both a **web UI** component (in `packages/ui`) and **TUI/CLI** support (agent tools in `packages/cli`). Backend-only features without a UI are incomplete — users interact through the web interface, not just agent tools. When adding a new capability, ask: "Can the user configure/see/use this from the web UI?" If not, add it.

---

## Upstream Patches

PizzaPi patches three upstream pi packages via `patchedDependencies` in the root `package.json`. Patches live in `patches/` and are auto-applied on `bun install`. See `patches/README.md` for full details.

### @mariozechner/pi-agent-core

- **Dynamic tool refresh:** When a tool changes the active tool set mid-run (for example Tool Deferral loading a deferred tool), the next assistant response now sees the refreshed tools/system prompt instead of the stale turn-start snapshot.

### @mariozechner/pi-coding-agent

- **Session control:** Exposes `newSession()` / `switchSession()` on the extension API so the remote extension can trigger `/new` and `/resume` from the web UI.
- **Version check removal:** Disables the npm registry version check and "Update Available" notification (irrelevant for PizzaPi's headless runner).
- **Auth path display:** Shows the actual auth file path instead of hardcoded default.

### @mariozechner/pi-ai

- **Anthropic web search:** Adds support for Anthropic's native server-side web search tool, including streaming handling and conversation round-tripping. Configured via `providerSettings.anthropic.webSearch` in `~/.pizzapi/config.json`. See `patches/README.md` for details.

### Recreating patches after a version bump

1. Update version specifiers in all `package.json` files
2. `bun install` to fetch the new versions
3. `bun patch @mariozechner/pi-coding-agent@<version>` — edit files, then `bun patch --commit 'node_modules/@mariozechner/pi-coding-agent'`
4. `bun patch @mariozechner/pi-ai@<version>` — edit files, then `bun patch --commit 'node_modules/@mariozechner/pi-ai'`
5. Run `cd packages/cli && bun test src/patches.test.ts` to verify

---

## Configuration Conventions

- **Environment variable prefix:** PizzaPi-specific env vars use the `PIZZAPI_` prefix (e.g., `PIZZAPI_SERVER_URL`, `PIZZAPI_AUTH_TOKEN`). Upstream pi env vars use the `PI_` prefix (e.g., `PI_WEB_SEARCH`, `PI_CACHE_RETENTION`). Never introduce a new env var without one of these prefixes.
- **MCP config format:** Always use the `mcpServers{}` format (Claude Code compatible) as the preferred format. The `mcp.servers[]` array format is supported but not preferred. Claude Code compatibility is always the priority.

---

## Docker & Deployment

**Use `pizza web` to rebuild and redeploy the production server.** This is the preferred method — it rebuilds the Docker image from the repo source and restarts the production compose project at `~/.pizzapi/web/`. Runners and viewers reconnect automatically.

```bash
# Preferred: rebuild + redeploy production server
pizza web
```

---

## Testing

**Test runner**: `bun test` (built-in Bun test runner). No additional frameworks needed.

```bash
# Run all tests
bun run test

# Run tests for a specific package
bun test packages/server
bun test packages/tools
bun test packages/ui
cd packages/cli && bun test src/patches.test.ts
```

### Test file conventions

- Co-locate test files next to the source: `foo.ts` → `foo.test.ts`
- Integration / multi-module tests go in `packages/<pkg>/tests/`
- Use `describe` / `test` / `expect` from `bun:test` — no extra imports needed

### Current coverage by package

| Package | Test files | What's covered |
|---------|-----------|----------------|
| **server** | 10 | Validation, security, sessions store, attachments store, API routes, pruning, pi-compat |
| **ui** | 3 | Message grouping, session viewer utils, path utilities |
| **tools** | 2 | Toolkit helpers, pi-compat |
| **cli** | 1 | Patch application and runtime behavior |
| **protocol** | 0 | ⚠️ Needs tests |
| **npm** | 0 | Build/publish scripts — no runtime code |

### Testing standards

- **All new code must include tests.** If you add or modify a module, add or update its `.test.ts` file.
- **Run `bun run test` before committing.** Tests are part of the quality gates in session completion.
- **Test pure logic first.** Validation, parsing, transforms, and utility functions should have thorough unit tests.
- **Keep tests fast.** Avoid real network/Redis/DB calls in unit tests — mock or use in-memory alternatives.
- **Test lifecycle boundaries explicitly.** If a bug depends on "next turn", "after tool call", startup sequencing, reloads, or streamed state, add a regression test that crosses that boundary. Snapshot/timing bugs are easy to miss with pure unit tests.

---

## Built-in System Prompt

The CLI appends a built-in system prompt (`BUILTIN_SYSTEM_PROMPT` in `packages/cli/src/config.ts`) to every session automatically. It covers inter-agent communication, the subagent tool, and session completion guidance. User-configured `appendSystemPrompt` in `~/.pizzapi/config.json` is concatenated **after** the built-in, so custom additions stack on top.

**When adding new tools or changing agent-facing behavior**, update `BUILTIN_SYSTEM_PROMPT` in `config.ts` — not config.json. This ensures all installs get the change without any setup step.

---

## Spawning Sub-Agents

Spawned sessions are **automatically linked** — child events (questions, plans, completion) surface as trigger messages in the parent's conversation. No manual session ID plumbing needed.

**Handling child triggers:**
- Trigger messages arrive with a `<!-- trigger:ID -->` prefix and instructions.
- Use `respond_to_trigger(triggerId, response)` to answer a child's question or approve a plan.
- Use `escalate_trigger(triggerId)` to pass a trigger to the human viewer.
- Use `tell_child(sessionId, message)` to proactively message a child session.

**Example pattern:**
```
1. Spawn a session with `spawn_session` (child is automatically linked)
2. When the child calls AskUserQuestion or plan_mode, a trigger appears in your conversation
3. Respond with `respond_to_trigger(triggerId, "your answer")`
4. When the child finishes, a session_complete trigger arrives — acknowledge or follow up
```

**For non-linked sessions** (e.g., two sessions that weren't spawned by each other):
- Use `send_message`/`wait_for_message` for manual inter-session messaging.
- Include session IDs explicitly when coordinating.

**Rules:**
- The `subagent` tool handles its own communication — triggers only apply to `spawn_session`.
- Sub-agents must follow the same coding standards (testing, typecheck, etc.) as the parent.

---

## Session Completion

**When ending a work session**, complete ALL steps. Work is NOT done until `git push` succeeds.

1. **Run quality gates** — typecheck, build, verify nothing is broken
2. **Commit all changes** — clear commit message describing what changed
3. **Push to remote**:
   ```bash
   git pull --rebase
   git push
   git status  # must show "up to date with origin"
   ```
4. **Hand off** — leave a clear summary of what was done and what's next

**Rules:**
- Work is NOT complete until `git push` succeeds
- Never stop before pushing — that leaves work stranded locally
- If push fails, resolve and retry until it succeeds

## Landing the Plane (Session Completion)

**When ending a work session**, you MUST complete ALL steps below. Work is NOT complete until `git push` succeeds.

**MANDATORY WORKFLOW:**

1. **File issues for remaining work** - Create issues for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **PUSH TO REMOTE** - This is MANDATORY:
   ```bash
   git pull --rebase
   git push
   git status  # MUST show "up to date with origin"
   ```
5. **Clean up** - Clear stashes, prune remote branches
6. **Verify** - All changes committed AND pushed
7. **Hand off** - Provide context for next session

**CRITICAL RULES:**
- Work is NOT complete until `git push` succeeds
- NEVER stop before pushing - that leaves work stranded locally
- NEVER say "ready to push when you are" - YOU must push
- If push fails, resolve and retry until it succeeds
