# Audit: deployment/mac-setup.mdx
Verdict: MINOR ISSUES
Claims checked: 29 | Failed: 6

## Findings

### [P2] Plist "EnvironmentVariables Required" overstates what the daemon needs
- Claim (line ~190, Plist Reference table): "EnvironmentVariables | ✅ | Must include `PIZZAPI_API_KEY`, `PIZZAPI_RELAY_URL`, and `PATH`"
- Reality: The daemon resolves `apiKey` and `relayUrl` from `~/.pizzapi/config.json` when env vars are absent. `apiKey = PIZZAPI_RUNNER_API_KEY ?? PIZZAPI_API_KEY ?? PIZZAPI_API_TOKEN ?? daemonConfig.apiKey` and `relayRaw = process.env.PIZZAPI_RELAY_URL ?? resolveConfigRelayUrl() ?? "ws://localhost:7492"` (packages/cli/src/runner/daemon.ts:326-343). Since step 1 already runs `pizzapi setup` (which writes `apiKey`/`relayUrl` to config.json), the env vars are NOT required — only `PATH` truly needs to be in the plist (launchd provides no shell PATH). Marking all three "Required" misleads users into duplicating secrets that already live in config.json.
- Fix: Mark `PIZZAPI_API_KEY`/`PIZZAPI_RELAY_URL` as optional (fallback to config.json); keep only `PATH` as required.

### [P2] `KeepAlive=true` makes `pizzapi runner stop` ineffective, forcing the `launchctl unload` the project warns against
- Claim (lines 96-99, 145-154): plist uses bare `<key>KeepAlive</key><true/>`; "Stop the runner" / "Restart the runner" use `launchctl unload`/`load`.
- Reality: The supervisor exits 0 on a clean stop (`pizzapi runner stop` → SIGTERM → child exits 0 → supervisor exits 0; packages/cli/src/runner/stop.ts, supervisor.ts "exit 0 → clean stop; supervisor exits 0"). With `KeepAlive=true`, launchd respawns the supervisor on *any* exit including exit 0, so `pizzapi runner stop` appears to do nothing — the runner comes right back. The only way to truly stop is `launchctl unload`, which the repo's own AGENTS.md forbids ("Never run `launchctl unload/stop com.pizzapi.runner` — it kills your own session") and which disconnects all active sessions. This contradiction is doc-described friction, not just a doc gap.
- Fix: Recommend `KeepAlive` as a dict with `SuccessfulExit=false` (so a clean `runner stop` is honored) and/or document `pizzapi runner stop` as the primary stop mechanism.

### [P2] Page never mentions the graceful `pizzapi runner stop` command
- Claim (Managing the Service section, lines 143-160): only `launchctl unload`/`load` are offered for stop/restart.
- Reality: A graceful stop exists and is documented elsewhere: `pizzapi runner stop` reads the supervisor PID from `~/.pizzapi/runner.json` and SIGTERMs the tree (packages/cli/src/runner/stop.ts:1-40; packages/cli/src/index.ts:39-44; runner-daemon.mdx "Stopping the Runner"). Omitting it pushes users straight to the disruptive `launchctl unload`.
- Fix: Add `pizzapi runner stop` (and `/restart`, which triggers supervisor exit 42 respawn) as the preferred stop/restart, reserving `launchctl unload` for plist edits.

### [P2] `which pizza → ~/.bun/bin/pizza` only holds for a `bun`-global install, not the `npm install -g` shown in step 1
- Claim (lines 39-46, 71-77): step 1 runs `npm install -g @pizzapi/pizza`; step 2 shows `which pizza` → `/Users/yourname/.bun/bin/pizza`.
- Reality: `npm install -g` places the bin in npm's global prefix (e.g. `/usr/local/bin` or `~/.npm-global/bin`), not `~/.bun/bin`. `~/.bun/bin/pizza` is only the path when installed via `bun install -g` (installation.mdx:29 lists `bun install -g @pizzapi/pizza` as a separate tab). The plist's absolute paths will be wrong for npm users who copy the example verbatim. (Both `pizza` and `pizzapi` bins exist — packages/cli/package.json:18-21, packages/npm/build-npm.ts:221-222 — but the *location* is install-method-dependent.)
- Fix: Tell users to run `which pizza` (or `which pizzapi`) and paste the real result, and note the path differs between npm and bun global installs.

### [P3] Inconsistent command name: `pizzapi setup` then `which pizza`
- Claim (lines 27, 39-46): uses `pizzapi setup` in step 1 but `pizza` in step 2 / ProgramArguments.
- Reality: Both `pizza` and `pizzapi` are valid bin aliases pointing at the same entry (packages/cli/package.json:18-21; packages/npm/build-npm.ts:221-222). Not wrong, but the README and installation.mdx standardize on `pizzapi`, and the mix invites confusion about whether two installs are needed.
- Fix: Pick one name (prefer `pizzapi` to match the README) and use it throughout.

### [P3] `security find-generic-password -s "gh:github.com"` is an unsupported third-party claim
- Claim (lines 245-247): "Should return the token (not an error)".
- Reality: The `gh` CLI's keychain service-name convention is external to this repo and unverifiable here; nothing in packages/cli references it. If `gh` changes its storage scheme the troubleshooting step silently misleads. Also `gh` may store under a different service label depending on version.
- Fix: Soften to "e.g. `security find-generic-password -s 'gh:github.com' -w` (service name may vary by `gh` version)" or remove the specific service string.

## Redesign notes
- The entire LaunchAgent setup is manual — no code in the repo generates or loads a plist (grep for `plist`/`LaunchAgent`/`generatePlist` in packages/**/*.ts returns only the docs and a comment in daemon.ts). A walkthrough with a copy-paste plist, plus separate "Managing", "Migrating", and "Troubleshooting" sections, is inherently long; consider condensing the plist into a single block and moving the reference table into a `<Details>`.
- The "Migrating from a LaunchDaemon" section assumes a prior LaunchDaemon existed, but nothing in the repo ever produced one — it's speculative. Keep only if a prior PizzaPi version shipped a LaunchDaemon; otherwise it's dead weight.
- Duplication: `launchctl load/unload ~/Library/LaunchAgents/com.pizzapi.runner.plist` appears in step 5, Managing, Troubleshooting, and again in installation.mdx:313-314 and runner-daemon.mdx:155-158 and sandbox.mdx:364-365. Centralize the plist/lifecycle in this page and link from others.
- `launchctl load`/`unload` are deprecated on modern macOS in favor of `launchctl bootstrap`/`bootout gui/$(id -u)`. The legacy forms still work, but a note (or a tab) would future-proof the guide.

## Code UX opportunities
- **`pizzapi runner install` command**: Auto-detect `which pizzapi`/`which bun`, generate `~/Library/LaunchAgents/com.pizzapi.runner.plist` with `KeepAlive={SuccessfulExit:false}`, `mkdir -p ~/.pizzapi/logs`, and `launchctl bootstrap` it — eliminating every manual step (and every path/key-copy error) on this page. The infrastructure (config reading, default paths) already exists in daemon.ts/runner-state.ts.
- **Honorable exit code for `runner stop`**: Because the supervisor already exits 0 on clean stop and 42 for `/restart`, the plist generator should emit `KeepAlive` as a dict (`SuccessfulExit=false`, `Crashed=true`) so `pizzapi runner stop` "just works" under launchd and users never need `launchctl unload` for routine stops — directly resolving the AGENTS.md "never unload" tension.
- **`pizzapi runner status` / `doctor`**: A command that prints launchd load state, last exit code, log tail, and keychain reachability would replace the manual `launchctl list | grep pizzapi` + `tail` + `security find-generic-password` dance in the troubleshooting table.
- **Log directory auto-creation**: If the daemon/loggers created `~/.pizzapi/logs/` on first run, step 4 ("Create the log directory") and a class of "logs not written" support issues would disappear.
