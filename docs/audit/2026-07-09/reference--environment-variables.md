# Audit: reference/environment-variables.mdx
Verdict: MINOR ISSUES
Claims checked: 51 | Failed: 2

## Findings

### [P1] PIZZAPI_ATTACHMENT_MAX_FILE_SIZE_BYTES default is wrong (20 MB vs 30 MB)
- Claim (line 105): "`PIZZAPI_ATTACHMENT_MAX_FILE_SIZE_BYTES` ... Default: `20971520` (20 MB)"
- Reality: `DEFAULT_MAX_FILE_SIZE_BYTES = 30 * 1024 * 1024` = 31457280 (30 MB). `attachmentMaxFileSizeBytes()` falls back to this when the env var is unset/invalid (packages/server/src/attachments/store.ts:24,31-35). The doc understates the real limit by 10 MB.
- Fix: Change the default to `31457280` (30 MB).

### [P2] PIZZAPI_REDIS_URL default documented as 127.0.0.1, code uses localhost
- Claim (line 86): "`PIZZAPI_REDIS_URL` ... Default: `redis://127.0.0.1:6379`"
- Reality: Every fallback in the server is `redis://localhost:6379`, not `redis://127.0.0.1:6379` (packages/server/src/index.ts:192, packages/server/src/ws/sio-state.ts:27, packages/server/src/ws/sio-state/client.ts:11, packages/server/src/redis-client.ts:28-33). Functionally equivalent but the documented string does not match what an operator would see if they printed the resolved URL.
- Fix: Change default to `redis://localhost:6379`.

### [P3] Missing server-side env vars that operators would want
- Claim: The page intro says it "lists every variable recognized by the CLI runner and the server."
- Reality: Several user-facing server env vars are read from `process.env` but absent from the doc:
  - `PIZZAPI_DISABLE_SIGNUP_AFTER_FIRST_USER` (default `true`) — packages/server/src/auth.ts:354
  - `PIZZAPI_TRUST_MOBILE_ORIGINS` (disable Capacitor origins with `false`) — packages/server/src/auth.ts:374
  - `PIZZAPI_RELAY_SNAPSHOT_SCAN_CHUNK_SIZE` (Redis SCAN tuning) — packages/server/src/sessions/redis.ts:52
- Fix: Add rows for these three under Server (Auth / Rate Limiting / Relay sections respectively).

### [P3] Missing CLI/runner env vars
- Claim: The page lists "every variable recognized by the CLI runner."
- Reality: These runner/CLI env vars are read from `process.env` and have user-visible effects but are undocumented:
  - `PIZZAPI_WORKER_AUTO_CLOSE` (auto-close worker on `completed`) — packages/cli/src/extensions/remote/lifecycle-handlers.ts:446
  - `PIZZAPI_SOCKETIO_URL` (explicit Socket.IO URL override) — packages/cli/src/extensions/remote/connection.ts:107
  - `PIZZAPI_MCP_AUTH_DIR` (MCP OAuth token dir, default `~/.pizzapi/mcp-auth`) — packages/cli/src/extensions/mcp-oauth.ts:44
  - `PIZZAPI_DISABLED_RUNNER_SERVICES` (comma-separated service skip list) — packages/cli/src/runner/daemon.ts:99
  - `PIZZAPI_PREBUILD_UI` (controls `pizza web` host prebuild, default true) — packages/cli/src/web.ts:1174
  - `PIZZAPI_HIDDEN_MODELS` (hide models from spawn-session picker) — packages/cli/src/extensions/spawn-session.ts:281
  - `PIZZAPI_ALLOW_PROJECT_HOOKS` / `PIZZAPI_ALLOW_PROJECT_MCP` (`1` to permit project-local hooks/MCP) — packages/cli/src/config/io.ts:99,109
  - `PIZZAPI_SESSION_PROVIDER` (session model provider override) — packages/cli/src/config/io.ts:333
  - `PIZZAPI_OLLAMA_WEB_FETCH_MAX_CONTENT_CHARS` / `PIZZAPI_OLLAMA_WEB_FETCH_MAX_LINKS` (Ollama web_fetch tuning) — packages/cli/src/extensions/ollama-web-tools.ts:48,52; packages/cli/src/config/io.ts:545-549
  - Worker spawn vars set by the daemon: `PIZZAPI_WORKER_INITIAL_MODEL_PROVIDER`, `PIZZAPI_WORKER_INITIAL_MODEL_ID`, `PIZZAPI_WORKER_AGENT_NAME`, `PIZZAPI_WORKER_AGENT_SYSTEM_PROMPT`, `PIZZAPI_WORKER_AGENT_TOOLS`, `PIZZAPI_WORKER_AGENT_DISALLOWED_TOOLS`, `PIZZAPI_WORKER_RESUME_PATH` — packages/cli/src/extensions/initial-prompt.ts:30-36
- Fix: Either add rows for the user-facing ones or add a sentence acknowledging internal/auto-set vars are excluded so the "every variable" claim is not overreading.

### [P3] BETTER_AUTH_BASE_URL default wording slightly imprecise
- Claim (line 96): "`BETTER_AUTH_BASE_URL` ... Default: `http://localhost:<PORT>`"
- Reality: `config.baseURL ?? process.env.BETTER_AUTH_BASE_URL ?? \`http://localhost:${process.env.PORT ?? "7492"}\`` (packages/server/src/auth.ts:331). The `<PORT>` placeholder is accurate and resolves to the live PORT, but the doc does not note PORT defaults to 7492, so the literal default is `http://localhost:7492`. Minor.
- Fix: Either keep as-is (clear enough) or note it expands to `http://localhost:7492` by default.

## Redesign notes
- The page mixes user-set and daemon-auto-set vars under "Worker Session Variables" with a "Do not set manually" note for only one of them. Consider splitting into "Set by the daemon (informational)" vs "Operator-set" so the table semantics are unambiguous.
- Defaults that are computed (`Config value`, `unset`, `auto-detect`) are good; consider also marking which server vars are read once at module load vs lazily — e.g. VAPID keys are read at module load (packages/server/src/push.ts:12-13) while ntfy vars are read lazily at call time (packages/server/src/push.ts:215-222), which matters for hot-reload expectations.
- The "Attachments" pipeline paragraph duplicates content that belongs in the attachments/self-hosting doc; the env-var table itself is the reference value here.
- Consider a single consolidated "PIZZAPI_ prefix" note: every PizzaPi var uses the prefix, but `PORT`, `AUTH_DB_PATH`, `BETTER_AUTH_*`, `VAPID_*`, `OLLAMA_API_KEY`, `NODE_ENV` do not — a one-line callout would prevent operators from assuming a consistent prefix.

## Code UX opportunities
- `PIZZAPI_ATTACHMENT_MAX_FILE_SIZE_BYTES` falling back silently to a different default than documented is exactly the kind of mismatch a startup log line ("max upload size: 30 MB") would surface — emit the resolved limit at boot so mismatches are self-evident.
- `PIZZAPI_REDIS_URL` default divergence (`localhost` vs `127.0.0.1`) suggests centralizing the default in one constant instead of repeating the literal across 4 files (index.ts, sio-state.ts, sio-state/client.ts, redis-client.ts) — a single `DEFAULT_REDIS_URL` export would guarantee doc/code agreement.
- `PIZZAPI_DISABLE_SIGNUP_AFTER_FIRST_USER` and `PIZZAPI_TRUST_MOBILE_ORIGINS` are security-relevant booleans read only from env (no config.json path); exposing them in config.json or a `pizza web` settings page would make them discoverable, matching the AGENTS.md "UI + TUI for every feature" rule.