# Audit: reference/windows-crashes.mdx
Verdict: MAJOR ISSUES
Claims checked: 18 | Failed: 5

## Findings

### [P1] Wrong git clone URL in "run from source" workaround
- Claim (line 95): `git clone https://github.com/badlogic/PizzaPi.git`
- Reality: Every other doc and the site config use `https://github.com/Pizzaface/PizzaPi` — `packages/docs/astro.config.mjs:42` (social link), `:46` (editLink base), `start-here/installation.mdx:40`, `deployment/self-hosting.mdx:75`, `reference/development.mdx:35`, `start-here/getting-started.mdx:125`. The `badlogic/PizzaPi` repo does not exist; the clone command fails.
- Fix: Replace with `https://github.com/Pizzaface/PizzaPi.git`.

### [P2] "Confirmed" `.env` trigger has no code evidence
- Claim (line 110): "One confirmed trigger is standalone executables crashing when a `.env` file exists in the working directory. The dotenv loader mutates environment state across threads."
- Reality: No dotenv handling exists in `packages/cli/src`. The only `.env` references are sandbox `denyWrite` entries (`sandbox-config.test.ts:75-79`, `config.ts` defaults) — unrelated to a crash trigger. PizzaPi relies on Bun's built-in `.env` loading; there is no PizzaPi code that "mutates environment state across threads." The claim is presented as a confirmed, code-level fact but is unverifiable in-repo and the described mechanism is not implemented here.
- Fix: Soften to "Anecdotally reported upstream; remove `.env` from the runner's CWD as a test" or cite the upstream Bun issue that documents it.

### [P2] "Latest release as of February 2026" is 5 months stale
- Claim (line 63): "Bun v1.3.10 (the latest release as of February 2026)" and the affected-versions list stops at v1.3.10.
- Reality: Current date is 2026-07-09. The page asserts Bun v1.3.10 is the latest release, which is no longer provable and likely outdated. `@types/bun` in the repo is `^1.3.9` (`packages/cli/package.json:43`, `packages/server/package.json:34`) but there is no pinned Bun runtime version anywhere, so "we will update the bundled Bun version" is also ungrounded.
- Fix: Drop the "latest as of February 2026" assertion; restate the version list as "tested through v1.3.10" and add a re-check date, or move the version table under a "last verified" heading.

### [P3] Example log output uses a prefix the structured logger never emits
- Claim (lines 17-23): Logs shown as `pizzapi runner: connecting to relay at …`, `pizzapi runner: connected. Registering as …`, `pizzapi runner: registered as …`.
- Reality: The connect/register logs go through the structured logger, which formats lines as `<ISO timestamp> [daemon] <msg>` — `packages/cli/src/runner/logger.ts:42-52`. The actual emitted text is `connecting to relay at ${sioUrl}/runner…` (`daemon.ts:769`), `connected. Registering as ${identity.runnerId}…` (`daemon.ts:833`), and `registered as ${runnerId}` (`daemon.ts:863`). The `pizzapi runner:` prefix only appears on ad-hoc `console.log` lines like `terminal.ts:204`, not on these relay lifecycle messages. The message bodies are accurate; only the prefix is invented.
- Fix: Show the real `[daemon]`-tagged format, or strip the prefix and note logs are timestamp-prefixed.

### [P3] "fetch() … on background threads" mischaracterizes the runtime model
- Claim (line 57): "`fetch()` calls — usage cache refresh on background threads"
- Reality: The usage refresh runs on the daemon's main event loop via `setInterval` — `runner-usage-cache.ts:299-307` (`startUsageRefreshLoop`), invoked once at `daemon.ts:314`. There are no worker threads for usage refresh; it is async I/O on the main thread. The `fetch` calls themselves are real (`runner-usage-cache.ts:102,179,218`).
- Fix: Reword to "usage cache refresh on a recurring timer (main-thread async I/O)."

### [P3] "We will update the bundled Bun version" implies a pin that doesn't exist
- Claim (line 154): "We will update the bundled Bun version when a complete fix ships."
- Reality: No Bun runtime version is pinned in the repo (no `engines.bun`, no `bun.lockb` version constraint checked here, `@types/bun` is `^1.3.9`). The compiled binary embeds whatever Bun ships it with via `bun build --compile` (`build-binaries.ts:291`). The statement is aspirational, not tied to a config knob.
- Fix: Reframe as "we'll ship a new compiled binary built with a fixed Bun" to match reality.

### [P3] Page is orphaned from the install flow and documents a bug with no in-repo mitigation
- Claim (entire page): Documents an upstream Bun Windows segfault and workarounds.
- Reality: `start-here/installation.mdx` lists Windows x64 as supported (lines 13, 46) with no warning and no link to this page; a `grep` for `windows-crashes` across `packages/docs/src/content/docs` finds zero inbound links. The repo's only Windows-specific code is the `@earendil-works/pi-tui` console/VT/UTF-8 rendering patch (`patches/@earendil-works%2Fpi-tui@0.80.3.patch:9-156`, summarized in `patches/README.md:108-118`) — a TUI rendering fix this page never mentions. There is no segfault detection, mitigation, or Windows-specific crash handling in `packages/cli/src` (only `process.platform === "win32"` checks for shell/signal selection: `terminal-utils.ts:39`, `stop.ts:80`, `runner-state.ts:142`, `terminal-worker.ts:72`). The referenced design spec `docs/superpowers/specs/2026-04-24-windows-tui-rendering-design.md` does not exist in the repo. The page is still relevant as a known-issue advisory, but it is disconnected from the install page and from the actual Windows work that landed.
- Fix: Add a warning + cross-link on `installation.mdx` for Windows users; either archive this page once a fixed Bun ships or add a "last verified" date and a pointer to the TUI rendering patch for the Unicode/VT side of Windows support.

## Redesign notes
- Lead with the actionable conclusion (WSL2 / Linux-macOS) before the JSC GC root-cause essay; most readers need the workaround, not the finalizer analysis.
- Move the three-crash-family table and issue-link dump into a collapsible "details" section — they are evidence, not guidance.
- Replace the invented `pizzapi runner:` log prefix with the real `[daemon]`-tagged sample so users can actually grep their `runner.log`.
- Add a "Last verified: YYYY-MM" stamp on the affected-versions table so staleness is self-declaring.
- Reconcile with `installation.mdx`: either mark Windows as "experimental — see Windows crashes" or document the WSL2 path inline.

## Code UX opportunities
- The supervisor already auto-restarts on crash with backoff (`supervisor.ts:140-149`); consider emitting a single user-facing "daemon crashed and is restarting (known Windows Bun issue — see docs)" line so the connection between the panic and the restart is visible.
- `installation.mdx` could surface platform support tier (Linux/macOS full, Windows best-effort) from a single config-driven source so the docs and the crash page can't drift.
- Since the repo has a real Windows TUI rendering patch (`pi-tui@0.80.3.patch`), a short "Windows terminal rendering" subsection would document work that actually exists rather than only the upstream bug that doesn't.