# Audit: running/standalone-mode.mdx

Verdict: MAJOR ISSUES
Claims checked: 22 | Failed: 5

## Findings

### [P1] "run setup which will overwrite the relevant keys" is false
- Claim (line ~129): "— or — run setup which will overwrite the relevant keys: `pizzapi setup`"
- Reality: `runSetup({ force: true })` only calls `saveGlobalConfig({ apiKey: result.key })`; it never writes `relayUrl`. A pre-existing `"relayUrl": "off"` survives setup unchanged, so the next `pizzapi` run stays relay-disabled even though the user just configured a relay (packages/cli/src/setup.ts:257-268; packages/cli/src/config/io.ts:343-355 `saveGlobalConfig` merges only the passed fields). The Aside tip immediately below contradicts this line and is the correct version.
- Fix: Delete the "— or — run setup which will overwrite the relevant keys" line; tell users to manually delete the `relayUrl` line, since setup will not do it.

### [P1] Per-project `relayUrl` does NOT override the global config
- Claim (line ~157): "Project-level config overrides the global one, so this disables the relay only for sessions started in that directory."
- Reality: For `relayUrl` the global config always wins when both are set — `if (global.relayUrl !== undefined) { ... config.relayUrl = global.relayUrl; }` (packages/cli/src/config/io.ts:186-196). So a global relay URL cannot be disabled per-project via `.pizzapi/config.json`; the project value is only honored when the global is absent (and even then it emits a warning). The documented "per-project relay-free" use case does not work.
- Fix: State that project `relayUrl` only takes effect when no global `relayUrl` is set; otherwise use `PIZZAPI_RELAY_URL=off pizzapi` or `--no-relay` per invocation.

### [P2] Env-var form under "Permanently Disable" is not permanent
- Claim (line ~73): Under "Method 2: Permanently Disable the Relay", "Or pass it as an environment variable: `PIZZAPI_RELAY_URL=off pizzapi`".
- Reality: An inline `VAR=val cmd` assignment only affects that single process invocation; it is not persisted across future sessions (packages/cli/src/index.ts:408 reads `process.env.PIZZAPI_RELAY_URL` per run). To make it permanent it must be `export`ed in a shell rc. Method 3 then reuses the exact same command for "one session", directly contradicting Method 2's "permanently" framing.
- Fix: Remove the env-var bullet from Method 2 (it belongs only in Method 3), or clarify that persistence requires `export` in `~/.zshrc`/`~/.bashrc`.

### [P2] `--no-relay` / `PIZZAPI_NO_RELAY` / `--safe-mode` not mentioned
- Claim (line ~60-94): The page presents `relayUrl: "off"` and `PIZZAPI_RELAY_URL=off` as the only ways to disable the relay.
- Reality: The CLI also supports `--no-relay`, `PIZZAPI_NO_RELAY=1`, and `--safe-mode` (which disables relay along with MCP/plugins/hooks): `const noRelay = safeMode || args.includes("--no-relay") || process.env.PIZZAPI_NO_RELAY === "1";` then `if (noRelay) process.env.PIZZAPI_RELAY_URL = "off";` (packages/cli/src/index.ts:365, 443-446). These are documented in `running/cli-reference.mdx` and `security/sandbox.mdx` but omitted here.
- Fix: Add a short note listing `--no-relay` / `PIZZAPI_NO_RELAY=1` as per-invocation alternatives (and `--safe-mode` for disabling everything).

### [P3] Heavy duplication with other docs pages
- Claim: The relay-free recipes (`relayUrl: "off"`, `PIZZAPI_RELAY_URL=off pizzapi`, the "setup doesn't persist relay URL" note) appear in `start-here/installation.mdx:195-198`, `customization/configuration.mdx:279-316` (including a near-identical "Relay URL is not saved by pizzapi setup" Aside), and `start-here/getting-started.mdx:222`.
- Reality: Confirmed via grep — at least four pages carry the same snippets.
- Fix: Make this page the canonical source and have the others link here; or trim this page to a brief pointer.

## Redesign notes
- Methods 2 and 3 overlap: Method 2's env-var bullet and Method 3 are the same command with contradictory permanence claims. Merge into one "disable relay" section with three clearly-scoped options: config key (permanent), `export PIZZAPI_RELAY_URL=off` (permanent per-shell), inline `PIZZAPI_RELAY_URL=off pizzapi` / `--no-relay` (per-invocation).
- The "Reconnecting to a Relay" section is internally contradictory in three lines: it says remove the `off` line, then says setup will overwrite it, then the Aside says setup does NOT persist the relay URL. Pick one accurate story.
- The "What Still Works" table lists `spawn_session`/remote spawn/web push as "❌ No relay" — accurate, but worth one sentence explaining that `spawn_session` returns an explicit "Relay is disabled" error (packages/cli/src/extensions/spawn-session.ts:30, 105-108) so users recognize the message.
- The per-project config snippet should be removed or rewritten given the global-wins behavior; as written it describes a feature that does not work.

## Code UX opportunities
- `pizzapi setup` should clear an existing `"relayUrl": "off"` (or write the entered relay URL) on success, so users are not left in a state where they "configured a relay" but relay stays disabled. The doc currently has to paper over this footgun with an Aside — a sign the code should fix it.
- Consider making project-level `relayUrl: "off"` actually disable relay per-project (e.g., special-case `"off"` in the global-wins merge), since the documented use case is reasonable but unsupported by io.ts.
- Emit a one-line warning when `pizzapi setup` finishes but `relayUrl` is still `"off"` in config, pointing the user at the stale value.
