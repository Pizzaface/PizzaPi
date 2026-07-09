# Audit: running/cli-reference.mdx

Verdict: MAJOR ISSUES
Claims checked: 43 | Failed: 9

## Findings

### [P1] `pizzapi update --self` does not update anything — it is a no-op
- Claim (line ~430): "update --self | Update the upstream pi package only (use `npm install -g @pizzapi/pizza` to update PizzaPi)" and the Aside: "pizzapi update --self updates the upstream pi-coding-agent package, not the PizzaPi wrapper."
- Reality: When `--self` is passed, `rewriteUpdateArgs` sets `includeSelf=true`, and `runPackageCommand` immediately calls `printSelfUpdateNote()` and `return 0` WITHOUT ever invoking the upstream `handlePackageCommand`. No update happens; it only prints "Use npm install -g @pizzapi/pizza to update the PizzaPi wrapper itself." (packages/cli/src/package-commands.ts:155-160, 198-204). The same no-op path is taken for the positional forms `update self` and `update pi` (positionalIsSelf branch, line 188-191).
- Fix: Replace the description with "Prints a note and exits; self-update is disabled — run `npm install -g @pizzapi/pizza` to update PizzaPi."

### [P1] Plugin global trust dirs include `~/.claude/plugins/` — code excludes it
- Claim (line ~366): "Global plugins in `~/.pizzapi/plugins/`, `~/.agents/plugins/`, or `~/.claude/plugins/` are always auto-trusted".
- Reality: `globalPluginDirs()` returns ONLY `~/.pizzapi/plugins` and `~/.agents/plugins`. The source explicitly comments: "NOTE: ~/.claude/plugins/ is intentionally excluded here. Claude Code manages that directory via its marketplace system — plugins are installed into a cache subdirectory and tracked via installed_plugins.json. We discover those via discoverClaudeInstalledPlugins() instead of blindly scanning the directory." (packages/cli/src/plugins/discover.ts:20-32). Dropping a plugin folder into `~/.claude/plugins/` will NOT auto-trust it; only manifest entries in `~/.claude/plugins/installed_plugins.json` are discovered.
- Fix: State that global auto-trusted dirs are `~/.pizzapi/plugins/` and `~/.agents/plugins/`, and that Claude Code marketplace plugins are discovered via `~/.claude/plugins/installed_plugins.json`.

### [P2] Synopsis `--help` block omits the `--sandbox` flag
- Claim (line ~30): The embedded help block lists flags `--cwd, --safe-mode, --no-mcp, --no-plugins, --no-hooks, --no-relay, -v, -h` but no `--sandbox`.
- Reality: The actual `--help` output prints a `--sandbox <mode>` line between `--cwd` and `--safe-mode`: `log.info(`  ${c.flag("--sandbox")} ${c.dim("<mode>")}      Set sandbox mode: ${c.dim("enforce, audit, or off")}`);` (packages/cli/src/index.ts, the `--help`/`-h` branch). The default-command table below does list `--sandbox`, so the page is internally inconsistent.
- Fix: Add the `--sandbox <mode>` line to the synopsis help block.

### [P2] `pizza web --tag` default is the CLI version, not `latest`
- Claim (line ~88 help block and line ~150 flags table): "`--tag <tag>` UI image tag from GHCR (default: latest)" / "default: `latest`".
- Reality: `parseArgs` defaults `tag` to `"latest"`, but `runWeb` overrides it: when not a local repo and not `--build`/`--dev-ui` and tag is still `latest`, it sets `parsed.tag = getCliVersion()` (currently 0.5.4) and logs "Using Docker image tag matching CLI version" (packages/cli/src/web.ts runWeb start block). The real `--help` text itself says "default: CLI version, or latest".
- Fix: Change the default to "CLI version (falls back to `latest` when unset)" to match the help text.

### [P2] `pizza web --help` block in docs contains sections not in the real help output
- Claim (line ~78): The code block presented as "Run `pizza web --help` for the full usage" includes "Local dev UI stack (`--dev-ui` on a repo checkout): …" and "Docker build args (fallback mode): PREBUILT_UI (auto) …" sections.
- Reality: `printWebHelp()` only emits Commands, Flags, Configuration, and Examples sections — there is no "Local dev UI stack" or "Docker build args" section in the actual `--help` output (packages/cli/src/web.ts printWebHelp). PREBUILT_UI is a real Docker build arg used in the compose template, but it is not part of `--help`.
- Fix: Move the dev-UI and build-arg notes out of the `--help` code block into prose, or remove the framing "Run `pizza web --help` for the full usage:".

### [P2] `pizzapi models` example output format is wrong (flat table vs. grouped-by-provider)
- Claim (line ~285): Example shows a single flat table with `provider`, `model`, `notes` columns.
- Reality: `runModelsCommand` groups entries by provider, printing a `c.label(provider)` header per group then `  <model.id>  <notes>` rows, with blank lines between groups — no `provider` column and no `-----` separator row (packages/cli/src/models-command.ts, non-JSON branch). The model IDs/notes shown (e.g. `claude-opus-4-5`, `glm-5.1`, `202,752 ctx`) are also fabricated.
- Fix: Replace the example with the real grouped-by-provider layout, or label it as illustrative.

### [P2] `subagent` parallel limit "up to 4" is wrong (max 8 tasks, 4 concurrent)
- Claim (line ~491): "Parallel: `{ tasks: [...] }` — run multiple agents concurrently (up to 4)".
- Reality: `DEFAULT_MAX_PARALLEL_TASKS = 8` and `DEFAULT_MAX_CONCURRENCY = 4` (packages/cli/src/extensions/subagent/types.ts:10-11). The tool rejects `params.tasks.length > maxParallelTasks` with "Max is 8" (subagent/index.ts:263-266). The sibling docs (subagents.mdx:124, architecture.mdx:227) correctly state "up to 4 at once, max 8 tasks". The 4 is concurrency, not the tasks cap.
- Fix: Write "run multiple agents concurrently (up to 4 at once, max 8 tasks)".

### [P2] `subagent` agent-definition dirs omit `~/.claude/agents/` and `.claude/agents/`
- Claim (line ~494): "Agent definitions are loaded from `~/.pizzapi/agents/*.md` (user scope) and `.pizzapi/agents/*.md` (project scope)."
- Reality: Discovery also scans `~/.claude/agents/` (user) and `.claude/agents/` (project) for backward compatibility. The tool description itself says: 'Default agent scope is "user" (from ~/.pizzapi/agents and ~/.claude/agents). To enable project-local agents in .pizzapi/agents or .claude/agents, set agentScope: "both".' (packages/cli/src/extensions/subagent/index.ts:120-121; precompiled prompt confirms the four paths).
- Fix: List all four paths, or link to the Subagents guide which covers them.

### [P3] Synopsis help block version string is stale and header differs from real output
- Claim (line ~14): The block opens with "pizzapi v0.2.2 — PizzaPi coding agent".
- Reality: The real `--help` prints "🍕 PizzaPi v<version>" (currently 0.5.4 from packages/cli/package.json) followed by separate Commands/Flags sections, not a one-line "pizzapi v0.2.2 — PizzaPi coding agent" header (packages/cli/src/index.ts `--help` branch; package.json version 0.5.4).
- Fix: Update the snapshot to the current version and header format, or mark it as an illustrative excerpt.

### [P3] `--safe-mode` description adds "(fast startup)" not present in real help
- Claim (line ~31): "`--safe-mode`     Skip MCP, plugins, hooks, and relay (fast startup)".
- Reality: The actual help line is `--safe-mode            Skip MCP, plugins, hooks, and relay` (no "(fast startup)"); the "(fast startup)" phrasing only appears in the default-command table, not the `--help` output (packages/cli/src/index.ts `--help` branch).
- Fix: Drop "(fast startup)" from the verbatim help block, keep it only in the descriptive table.

### [P3] `pizzapi setup` prompts omit the optional "name" field
- Claim (line ~73): "Prompts for the relay server URL, email, and password, then saves the API key to `~/.pizzapi/config.json`."
- Reality: `runSetup` also prompts for "Your name (leave blank if account already exists):" between the relay URL and email (packages/cli/src/setup.ts:230-231).
- Fix: Add "name (optional)" to the prompt list.

### [P3] `pizzapi usage` Anthropic example omits the "7-day (co-work)" line
- Claim (line ~225): The Anthropic example shows 5-hour, 7-day, 7-day (OAuth apps), 7-day (Opus), 7-day (Sonnet), then Extra usage.
- Reality: `formatWindow` is also called for `usage.seven_day_cowork` labeled "7-day (co-work)", printed between Sonnet and the extra-usage block (packages/cli/src/index.ts usage branch, `formatWindow("7-day (co-work)", usage.seven_day_cowork)`).
- Fix: Add the "7-day (co-work)" row to the example, or mark the example as a partial excerpt.

### [P3] `pizzapi web` ~/.pizzapi/web/ file table omits host-build.json (and legacy vapid.json)
- Claim (line ~178): Table lists only `config.json`, `compose.yml`, `data/`.
- Reality: The web dir also stores `host-build.json` (host UI pre-build cache state, packages/cli/src/web.ts HOST_BUILD_STATE_PATH) and historically `vapid.json` (legacy, migrated). `compose.override.yml` is mentioned separately but not in the table.
- Fix: Add `host-build.json` to the table (purpose: host pre-build cache state).

### [P3] `compose.override.yml` note implies Docker auto-detection; code adds it explicitly
- Claim (line ~192): "create a `compose.override.yml` in the same directory — Docker Compose picks it up automatically."
- Reality: Because `composeExecAsync` always passes `-f compose.yml`, Docker's automatic override detection is disabled, so the code explicitly adds `-f compose.override.yml` when it exists (packages/cli/src/web.ts composeExecAsync). Functionally the override works, but the mechanism is the CLI, not Docker's default auto-detection.
- Fix: Rephrase to "PizzaPi automatically includes `compose.override.yml` if present."

### [P3] `pizza plugins` web-UI trust banner buttons are "Trust & Load" / "Skip", not "Trust / Skip"
- Claim (line ~378): "Web UI: Amber trust banner with Trust / Skip buttons".
- Reality: The banner renders buttons labeled "Trust & Load" and "Skip" (packages/ui/src/components/SessionViewer.tsx:1022-1023).
- Fix: Write "Trust & Load / Skip buttons".

### [P3] Package commands omit `-a/--approve`, `-na/--no-approve`, `--force`, `--extension <source>` options
- Claim (line ~415): The command table lists only `install <source> [-l]`, `remove [-l]`, `uninstall`, `update [source|self|pi]`, `update --extensions`, `update --self`, `list`, `config`.
- Reality: `COMMAND_HELP` documents `-a, --approve` / `-na, --no-approve` for all package commands, `--force` and `--extension <source>` for `update` (packages/cli/src/package-commands.ts COMMAND_HELP). None are mentioned in the docs.
- Fix: Add the approve/force/extension flags to the table or note that `--help` lists per-command options.

### [P3] `PIZZAPI_NO_*` env-var equivalents for safe-mode flags are undocumented
- Claim (line ~52): Only CLI flags `--safe-mode`, `--no-mcp`, `--no-plugins`, `--no-hooks`, `--no-relay` are documented.
- Reality: Each flag also honors `PIZZAPI_NO_MCP=1`, `PIZZAPI_NO_PLUGINS=1`, `PIZZAPI_NO_HOOKS=1`, `PIZZAPI_NO_RELAY=1` env vars (and `PIZZAPI_NO_SANDBOX=1` for `--sandbox=off`), used by the worker (packages/cli/src/index.ts safe-mode/sandbox blocks).
- Fix: Add a note that each `--no-*` flag has a `PIZZAPI_NO_*` env-var equivalent.

## Redesign notes
- The page mixes verbatim `--help` snapshots with descriptive prose; snapshots drift (version 0.2.2, missing `--sandbox`, fabricated `pizza web` help sections). Consider generating help blocks from the CLI at build time, or clearly label every block as "illustrative" so staleness isn't read as authoritative.
- Two separate flag tables (synopsis block vs. default-command table vs. Global Flags table) overlap and contradict; consolidate into one canonical flag list with a "applies to" column.
- The `update` command semantics are genuinely confusing in code (self-update is a silent no-op that prints an npm hint). The docs shouldn't paper over this — document the no-op behavior explicitly, and consider a code UX fix (see below).
- The `plugins` trust-model paragraph is duplicated nearly verbatim in the `plugins` CLI help text (which is also wrong about `~/.claude/plugins/`). Fix both the docs and `showHelp()` in plugins-cli.ts together.
- The Agent Tools / subagent section duplicates content already covered in `customization/subagents.mdx` and `features/multi-agent.mdx`; consider reducing this to a short pointer table to avoid the parallel-limit and agent-dir facts drifting again.

## Code UX opportunities
- `pizza update --self` / `update self` / `update pi` silently exit 0 after printing an npm hint — this is indistinguishable from success. Either print a clear "self-update is disabled" warning to stderr, or exit non-zero so scripts don't treat it as "updated".
- `pizza plugins --help` and the `plugins` docs both list `~/.claude/plugins/` as a global auto-trusted dir, but `globalPluginDirs()` excludes it. Either add it to the scan (if intended) or fix the help text so users don't hand-drop plugins there expecting them to load.
- The `--tag` default silently changes from `latest` to the CLI version depending on whether you're in a repo checkout. This conditional default is surprising; surface it explicitly in `--help` (the help text already says "CLI version, or latest" — make the code log which one it picked even when running from a repo).
- `pizza models` output format differs from the documented example; if the grouped-by-provider layout is intentional, add a `--table` option or document the canonical shape so users and integrations aren't misled by the docs' flat-table example.
