# Audit: reference/development.mdx
Verdict: MINOR ISSUES
Claims checked: 36 | Failed: 7

## Findings

### [P2] Build order diagram omits the `tunnel` package
- Claim (line ~88): "The build must follow this sequence: `protocol → tools → server → ui → cli`"
- Reality: The root `build` script is `build:protocol && build:tunnel && build:tools && build:server && build:ui && build:cli` — `tunnel` is the second build step and ships in every full build. (`package.json:13`)
- Fix: Change the sequence to `protocol → tunnel → tools → server → ui → cli`.

### [P2] Repository layout omits `tunnel` and `mobile`
- Claim (line ~68): The layout block lists only `protocol, tools, server, ui, cli, docs, npm`.
- Reality: `workspaces` includes `packages/tunnel` and a root-level `mobile` workspace, both present on disk (`packages/tunnel/`, `package.json:3-12`, `ls packages/`). `packages/npm` exists as a directory but is *not* a workspace entry.
- Fix: Add `tunnel/  Bun-based HTTP tunnel/proxy package` and a `mobile/` entry; note `npm/` is a build script dir, not a workspace.

### [P2] "Build individual packages" list omits `build:tunnel`
- Claim (line ~99): Lists `build:protocol`, `build:tools`, `build:server`, `build:ui`, `build:cli`.
- Reality: `build:tunnel` exists and is part of the top-level `build` (`package.json:15`). Omitting it implies tunnel is not independently buildable.
- Fix: Add `bun run build:tunnel` to the list.

### [P2] Patches section mischaracterizes what the patches do
- Claim (line ~150): "PizzaPi patches some upstream `pi` packages to add relay streaming and other features."
- Reality: No patch adds "relay streaming"; the relay is native server code. The four active patches do: dynamic tool refresh (`pi-agent-core`), Windows console lifecycle (`pi-tui`), Anthropic web search + Ollama Cloud + retryable JSON (`pi-ai`), and config-dir/session-control/version-check changes (`pi-coding-agent`). (`patches/README.md`, `package.json:patchedDependencies`)
- Fix: Replace "relay streaming" with an accurate one-line summary (e.g. "dynamic tool refresh, Windows console support, Anthropic web search, and PizzaPi config/session wiring").

### [P3] Test coverage table omits protocol, tunnel, and mobile
- Claim (line ~128): Coverage table lists only server, ui, tools, cli.
- Reality: The `test` script runs `packages/protocol/src`, `packages/tunnel/src`, and `mobile` in addition to the listed packages (`package.json:33`). AGENTS.md likewise flags protocol/tunnel/mobile coverage.
- Fix: Add rows for `protocol`, `tunnel`, and `mobile`, or note them as "growing/needs tests" per AGENTS.md.

### [P3] `Bun ≥ 1.1` prerequisite is unsourced
- Claim (line ~20): "Bun ≥ 1.1" in the prerequisites table.
- Reality: No `engines` field exists in the root or `packages/docs` `package.json` to enforce a minimum Bun version. The claim is plausible but unverifiable from the repo.
- Fix: Either add `"engines": { "bun": ">=1.1.0" }` to the root package.json, or soften to "a recent Bun (1.1+ recommended)".

### [P3] Dev commands omit `dev:redis` helper
- Claim (line ~113): Dev commands section lists `dev`, `dev:server`, `dev:ui`, `dev:cli`, `dev:runner`, `dev:docs`.
- Reality: `dev:redis` and `dev:redis:stop` scripts exist (`package.json:29-30`, backed by `scripts/start-redis.sh` / `stop-redis.sh`), giving a repo-local alternative to bare `redis-server`.
- Fix: Mention `bun run dev:redis` in "Option A" alongside `redis-server`.

## Redesign notes
- The page duplicates the AGENTS.md tech-stack table, repo layout, build-order, and test-conventions content nearly verbatim. Since AGENTS.md is the agent-facing guide and this is the human-facing dev page, keep the canonical detail here and let AGENTS.md link in. But reconcile both so they stop drifting (both currently drop `tunnel`).
- The "Patches" section is much thinner than `patches/README.md` and AGENTS.md's patch workflow. Consider linking to `patches/README.md` for the per-package details instead of restating a vague summary that goes stale on every version bump.
- "Build order matters" tip says rebuild `protocol` or `tools` before downstream — should also name `tunnel` since `tools`/`server` depend on it being built.
- The Docker "Option B" claim "Same ports as above" is correct but the dev service only mounts the repo and runs `bun run dev`; worth noting it does not run migrations or apply the SQLite volume, so first-time setup still needs `bun run migrate` on the host.

## Code UX opportunities
- `bun run dev` requires the user to know Redis must be started first. Since `dev:redis` already exists, consider making `dev` (or a `dev:full` alias) start Redis automatically when unavailable, removing the two-terminal prerequisite the docs have to warn about.
- The build order is implicit in script chaining. A `build:all` that just runs `build` plus a printed dependency graph would let the docs state one command instead of a fragile manual sequence diagram that keeps dropping packages.
- `patches/README.md` is the real source of truth for patches; the docs page restates it badly. A `pizza patches` CLI subcommand that prints the active patch list from `patchedDependencies` would give docs a stable link target and remove the drift.
- Test coverage table will always be stale. A `bun run test:list` that enumerates test files per package could generate the table at build time instead of hand-editing.