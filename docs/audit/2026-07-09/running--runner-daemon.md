# Audit: running/runner-daemon.mdx

Verdict: MAJOR ISSUES
Claims checked: 29 | Failed: 7

## Findings

### [P1] runner.json schema is fabricated
- Claim (line 71): `// ~/.pizzapi/runner.json (auto-generated, do not edit)` followed by `{ "id": "runner_a1b2c3d4e5f6", "name": "my-macbook" }`
- Reality: The actual schema is `{ pid, supervisorPid, startedAt, runnerId, runnerSecret }`. `runnerId` is a `randomUUID()` and `runnerSecret` is `randomBytes(32).toString("hex")`. There is no `id` or `name` key in the file (packages/cli/src/runner/runner-state.ts:11-20, 78-88). The `name` value is sent at registration time from `PIZZAPI_RUNNER_NAME` or `hostname()`, not persisted in runner.json (packages/cli/src/runner/daemon.ts:399, 791).
- Fix: Replace the example with the real schema (`runnerId` UUID, `runnerSecret`, `pid`, `supervisorPid`, `startedAt`) and document `PIZZAPI_RUNNER_NAME`.

### [P1] runnerId example format is wrong
- Claim (line 72, 93): `"runner_a1b2c3d4e5f6"` shown as the runner ID, and used as `runnerId: "runner_a1b2c3d4e5f6"` in the spawn_session example.
- Reality: `runnerId` is generated via `randomUUID()` (packages/cli/src/runner/runner-state.ts:82), producing a canonical UUID like `"a1b2c3d4-e5f6-..."`, not a `runner_`-prefixed token.
- Fix: Use a UUID-shaped example (e.g. `"runnerId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890"`).

### [P2] "Active session workers are allowed to finish before the daemon exits" is inaccurate
- Claim (line 165): "This sends a graceful shutdown signal. Active session workers are allowed to finish before the daemon exits."
- Reality: `runner stop` sends SIGTERM to the supervisor and polls for up to 10s, then force-kills with SIGKILL (packages/cli/src/runner/stop.ts:79-99). The daemon's `shutdown()` does not wait for worker processes — it clears intervals, disconnects the socket, releases the lock, and resolves immediately (packages/cli/src/runner/daemon.ts:755-773). Workers are separate spawned processes (packages/cli/src/runner/session-spawner.ts:158); the daemon does not join or await them.
- Fix: State that the daemon disconnects and exits; workers are independent processes that may continue or be reaped, and `runner stop` force-kills after a 10s grace window.

### [P2] runnerSecret field undocumented (security-relevant)
- Claim (line 71): The runner.json example omits `runnerSecret` entirely.
- Reality: `runnerSecret` (32-byte hex) is stored in runner.json and used to re-authenticate the runner with the relay (packages/cli/src/runner/runner-state.ts:16, 84-86; sent in `register_runner` at packages/cli/src/runner/daemon.ts:789). Users who treat the file as containing only an ID may unknowingly back it up/share it.
- Fix: Document `runnerSecret` and warn that runner.json is a credential — treat like a secret, do not commit or share.

### [P2] PIZZAPI_RUNNER_NAME env var not mentioned
- Claim (line 72): The runner "name" appears as a stored field `"name": "my-macbook"`.
- Reality: The display name comes from `process.env.PIZZAPI_RUNNER_NAME?.trim() || hostname()` and is only sent during `register_runner` (packages/cli/src/runner/daemon.ts:399, 791). There is no persisted name field. Operators have no documented way to set a friendly runner name.
- Fix: Document the `PIZZAPI_RUNNER_NAME` env var (used by systemd/launchd/pm2 unit files) and remove the fictional `name` from the runner.json example.

### [P3] "Appears in the web UI under its ID" is mildly misleading
- Claim (line 79): "The runner appears in the web UI under its ID and can be targeted by `spawn_session` calls."
- Reality: The UI keys runners by `runnerId` but displays the human-readable `runnerName` (packages/ui/src/lib/types.ts:46-48; packages/ui/src/components/HistoryCommandPalette.tsx:380-382). The runner is shown by name, with the ID used as the internal key/target.
- Fix: Say the runner appears under its display name (from `PIZZAPI_RUNNER_NAME`/hostname) and is targeted by `runnerId`.

### [P3] Trigger/linking section duplicates multi-agent.mdx and subagents.mdx
- Claim (lines 183-211): "Session Linking & Triggers" restates the trigger types, parent tools, and Socket.IO events already covered in features/multi-agent.mdx and customization/subagents.mdx.
- Reality: multi-agent.mdx lines 85-208 and subagents.mdx lines 239-259 cover the same `ask_user_question`/`plan_review`/`session_complete`/`session_error` triggers, `respond_to_trigger`/`escalate_trigger`/`tell_child`, and the `session_trigger`/`trigger_response` Socket.IO events (confirmed: packages/cli/src/extensions/triggers/registry.ts:220-223; packages/protocol/src/relay.ts:60,77,187,205).
- Fix: Replace the duplicated table with a one-line summary and a link to features/multi-agent.mdx.

### [P3] macOS launchctl commands duplicate deployment/mac-setup.mdx
- Claim (lines 143-159): The page reproduces the LaunchAgent guidance and `launchctl load/unload ~/Library/LaunchAgents/com.pizzapi.runner.plist` commands.
- Reality: deployment/mac-setup.mdx:64-228 already contains the full plist contents, load/unload commands, and the LaunchAgent-vs-LaunchDaemon keychain rationale. The runner-daemon page already links to it (line 144) but then duplicates the commands.
- Fix: Keep only the link to mac-setup.mdx and drop the inline launchctl commands.

### [P3] spawn_session example omits the `model` parameter
- Claim (lines 87-94): The spawn_session example shows only `prompt`, `cwd`, `runnerId`.
- Reality: The tool also accepts an optional `model: { provider, id }` (packages/cli/src/extensions/spawn-session.ts:84-92). The example would be more useful showing it, and the `runnerId` comment "defaults to current runner" is correct (packages/cli/src/extensions/spawn-session.ts:135-140).
- Fix: Add an optional `model` line to the example or note that model selection is supported.

### [P3] systemd API key placeholder `pk_live_` is not a real key format
- Claim (line 132): `Environment=PIZZAPI_API_KEY=pk_live_abc123...`
- Reality: API keys are generated as `randomBytes(32).toString("hex")` with no `pk_live_` prefix (packages/server/src/routes/auth.ts:134-135; packages/server/src/routes/utils.ts:77-78). The `pk_live_` placeholder is used consistently across docs but may imply a prefixed key format that doesn't exist.
- Fix: Use a clearly fake hex placeholder like `your-64-char-hex-api-key` or keep `pk_live_` but label it as illustrative only.

## Redesign notes
- Lead with the real runner.json schema (lock + identity + secret) so operators understand what they're protecting.
- Split "How It Works" into a terse data-flow diagram and move the trigger/linking detail entirely to multi-agent.mdx; this page should only describe the daemon lifecycle.
- Consolidate the three "Running as a System Service" subsections: systemd gets a full unit file, macOS defers entirely to mac-setup.mdx, pm2 stays as a snippet.
- Add an "Environment variables" mini-table (PIZZAPI_API_KEY, PIZZAPI_RELAY_URL, PIZZAPI_RUNNER_NAME, PIZZAPI_RUNNER_STATE_PATH) instead of burying them in service files.

## Code UX opportunities
- `runner.json` mixes a process lock (pid) with a long-lived credential (runnerSecret) in one world-readable-by-default path; the daemon could write it to a separate secrets location or `0o600` is already set (it is — runner-state.ts:88) but docs should surface this.
- `runner stop` silently force-kills after 10s with no indication of which workers were affected; a `--wait` flag or a summary of orphaned workers would reduce surprise.
- The runner `name` is only settable via an undocumented env var (`PIZZAPI_RUNNER_NAME`); exposing it as a `config.json` key (e.g. `runner.name`) would be more discoverable than an env var.
- The supervisor prints no runner ID on startup; logging the resolved `runnerId`/`name` would help users target `spawn_session` without inspecting runner.json.
