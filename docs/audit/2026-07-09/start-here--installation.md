# Audit: start-here/installation.mdx
Verdict: MAJOR ISSUES
Claims checked: 48 | Failed: 6

## Findings

### [P1] Pre-built binary GitHub Releases download does not exist; download URL is wrong
- Claim (lines 37-52): "Download a binary for your platform from the [GitHub Releases page](https://github.com/Pizzaface/PizzaPi/releases) ... `curl -L https://github.com/Pizzaface/PizzaPi/releases/latest/download/pizzapi-linux-x64 -o pizzapi`"
- Reality: The release workflow (`.github/workflows/release.yml`) only publishes to npm (and a Docker UI image to GHCR); it uploads build artifacts to GitHub Actions with `retention-days: 1` but never runs `gh release create` or attaches binaries to a GitHub Release. There is no GitHub Releases binary download produced by the project. Additionally, the compiled binaries are named `pizza-linux-x64`, `pizza-macos-arm64`, etc. (`packages/cli/build-binaries.ts:21-29`, `exeName: "pizza-linux-x64"`), not `pizzapi-linux-x64`, so even a hand-uploaded asset at that URL would 404. The `pizzapi`/`pizza` npm bin is a Node launcher (`packages/npm/bin/pizza.mjs`) requiring `@pizzapi/cli-<platform>` optional deps, not a standalone binary download.
- Fix: Drop the "Pre-built binary" tab, or add a release step that uploads `pizza-<platform>` binaries to GitHub Releases and correct the asset name in the curl URL.

### [P2] "Files & Directories" table lists `~/.pizzapi/logs/` as created by "macOS LaunchAgent setup"
- Claim (line 139): "`~/.pizzapi/logs/` | macOS LaunchAgent setup | Log files for runner stdout/stderr"
- Reality: No CLI code creates `~/.pizzapi/logs/`. grep for `.pizzapi/logs`, `mkdirSync.*logs`, `StandardOutPath` in `packages/cli/src` returns nothing. The directory only appears in `deployment/mac-setup.mdx:117` as a manual `mkdir -p ~/.pizzapi/logs` step inside a user-authored LaunchAgent plist; PizzaPi never auto-installs a LaunchAgent. So "Created by macOS LaunchAgent setup" implies an automated step that does not exist.
- Fix: Change the "Created by" cell to "manual (LaunchAgent plist)" or remove the row and link to mac-setup.mdx.

### [P3] runner.json table claims a "name" is stored; it is not
- Claim (line 137): "`~/.pizzapi/runner.json` | `pizzapi runner` (first start) | Runner identity, name, and PID tracking (auto-generated)"
- Reality: `RunnerState` (`packages/cli/src/runner/runner-state.ts:23-29`) contains only `pid`, `supervisorPid?`, `startedAt`, `runnerId`, `runnerSecret`. The runner display name is derived at registration time from `PIZZAPI_RUNNER_NAME` env or `hostname()` (`packages/cli/src/runner/daemon.ts:399`) and sent to the server (`daemon.ts:791`); it is never persisted in `runner.json`.
- Fix: Drop "name" from the Purpose cell ("Runner identity, lock/PID, and runner secret").

### [P3] Migration is described as "Copies" but it moves files
- Claim (lines 169-170): "Phase 1 — `~/.pi/agent/` → `~/.pizzapi/`: Copies sessions, auth, and other data from a legacy `pi` install..."
- Reality: `mergeDir()` (`packages/cli/src/migrations.ts:118-141`) does `renameSync(srcPath, dstPath)` first, only falling back to `cpSync` on failure, and skips files already present at the destination. Individual files are moved out of `~/.pi/agent/`, not copied; the source tree is left emptied (the source directory itself is not deleted). Calling this "copies" misleads users who expect `~/.pi/agent/` to remain intact after migration.
- Fix: Say "moves (merges) sessions, auth, and other data" or note the legacy dir is left empty.

### [P3] Docs use `pizzapi` everywhere; the canonical command/help text uses `pizza`
- Claim (throughout, e.g. lines 20, 28, 60, 80): all examples use `pizzapi ...`
- Reality: `packages/cli/package.json` exposes both `pizza` and `pizzapi` bins (so `pizzapi` works), but `--help` output (`packages/cli/src/index.ts:329-352`) and the `pizza web` help (`packages/cli/src/web.ts`) print every command as `pizza ...` (e.g. `pizza web`, `pizza runner stop`, `pizza setup`). Users who run `pizzapi --help` will see `pizza`-prefixed commands and may be confused about whether they have the right tool.
- Fix: Add a one-line note that `pizza` and `pizzapi` are aliases (or pick one and align help text with the docs).

### [P3] Uninstall LaunchAgent/systemd steps duplicate other docs pages
- Claim (lines 309-322): Sections "4. Remove macOS LaunchAgent" and "5. Remove systemd service" reproduce `launchctl unload ~/Library/LaunchAgents/com.pizzapi.runner.plist` and `sudo systemctl stop/disable/rm pizzapi-runner` verbatim.
- Reality: The same commands appear in `running/runner-daemon.mdx:155-158`, `deployment/mac-setup.mdx:147-154,205-211`, and `security/sandbox.mdx:364-365`. Per the repo AGENTS.md ("Do not duplicate detailed docs"), installation.mdx should link rather than re-list.
- Fix: Replace the two sections with a short pointer to runner-daemon.mdx / mac-setup.mdx uninstall sections.

## Redesign notes
- The "Pre-built binary" tab is the highest-risk item: it sends users to a URL the project never populates. Either remove it or make the release workflow publish real GitHub Release assets; until then mark the tab experimental/coming-soon.
- The "Files & Directories" table mixes CLI-created, daemon-created, and user-manual-created paths in one column without distinguishing them; splitting into "Auto-created by PizzaPi" vs "Created manually / by you" would prevent false expectations (e.g. `logs/`, `models.json`, `skills/`).
- "Re-run setup" instructs users to hand-edit `~/.pizzapi/config.json` to add `relayUrl` after setup. This is correct (setup only persists `apiKey` via `saveGlobalConfig({ apiKey })` in `setup.ts:204`), but the workflow is awkward; consider having `pizzapi setup --relay <url>` persist both `apiKey` and `relayUrl`.
- The Ollama Cloud "Quick start" block (lines 104-116) is an odd fit for an Installation page and overlaps with `customization/configuration.mdx:267` and `reference/environment-variables.mdx:80`; consider moving it to the providers/configuration page.
- "Resetting Configuration" and "Uninstalling" are large reset/uninstall recipes that belong closer to a dedicated "Maintenance / Reset" page or the configuration page; installation.mdx is doing too much.

## Code UX opportunities
- `runSetup()` only persists `apiKey`, never `relayUrl` (`packages/cli/src/setup.ts:204`, `saveGlobalConfig({ apiKey: result.key })`); `pizzapi setup` against a non-default relay silently leaves the relay unconfigured for the next run, forcing manual JSON edits. Persist `relayUrl` alongside `apiKey`.
- The `pizzapi` vs `pizza` dual-name is a recurring source of confusion (help text says `pizza`, docs say `pizzapi`). Either document the alias explicitly on the help screen or standardize on one.
- No CLI command creates or removes the macOS LaunchAgent/systemd unit — users must hand-author plists (`deployment/mac-setup.mdx:64`). A `pizzapi runner install --service`/`pizzapi runner uninstall` command would eliminate the duplicated manual steps in installation.mdx, runner-daemon.mdx, and mac-setup.mdx.
- The release workflow publishes npm packages but never produces the "Pre-built binary" GitHub Release the docs advertise; either add a `gh release create` step attaching `packages/cli/dist/binaries/<target>/pizza-*` or remove the docs tab.
