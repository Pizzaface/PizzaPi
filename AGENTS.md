# PizzaPi — Agent Guide

PizzaPi is a self-hosted web interface and relay server for the [`pi` coding agent](https://github.com/mariozechner/pi). It streams live agent sessions to any browser and allows remote interaction from mobile or desktop without needing terminal access.

---

## Repository Layout

```
packages/
  cli/      CLI wrapper — launches pi with PizzaPi extensions and the runner daemon
  server/   Bun HTTP + WebSocket relay server (auth, session relay, attachments)
  ui/       React 19 PWA web interface (Vite, TailwindCSS v4, Radix UI / shadcn)
  tools/    Shared agent tools (bash, read-file, write-file, search, toolkit)
  npm/      npm distribution — builds & publishes `npx pizzapi` packages

docker/     Docker Compose (redis + server services)
patches/    Bun patches for upstream pi packages (auto-applied on bun install)
```

Build order: `tools` → `server` → `ui` → `cli`.

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
- **Redis** is required for the server. For local dev without Docker: `redis-server` or `docker compose up redis`.
- **Database migrations**: run `bun run migrate` after schema changes. DB file is `packages/server/auth.db`.

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

---

## Spawning Sub-Agents

When spawning agents, **always expect a response** and **ensure your sub-agents know how to respond.**

- Always include your session ID in the sub-agent's prompt so it can `send_message` back to you.
- Use `wait_for_message` (or `check_messages` for polling) to receive the sub-agent's result.
- The sub-agent's prompt must be **self-contained** — it has no context from the parent session.
- Explicitly instruct sub-agents to report their results back via `send_message` when done.

**Example pattern:**
```
1. Get your own session ID with `get_session_id`
2. Include it in the spawn prompt: "When done, send results to session <ID> using send_message."
3. After spawning, call `wait_for_message` to block until the sub-agent replies.
```

**Rules:**
- Never fire-and-forget a sub-agent — always await a response.
- If a sub-agent may take a long time, use `check_messages` to poll between other work.
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
   bd sync
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
