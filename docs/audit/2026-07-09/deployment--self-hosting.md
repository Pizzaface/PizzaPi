# Audit: deployment/self-hosting.mdx
Verdict: MAJOR ISSUES
Claims checked: 44 | Failed: 9

## Findings

### [P1] Attachment upload limit stated as 50 MB and tied to wrong env var
- Claim (line ~"Request Body Size Limits"): "Attachment uploads: 50 MB maximum (configurable via `PIZZAPI_ATTACHMENT_MAX_FILE_SIZE_BYTES`)"
- Reality: Two distinct limits exist. `MAX_ATTACHMENT_BODY_SIZE = 50 * 1024 * 1024` (handler.ts:16) is the raw HTTP body ceiling and is NOT controlled by `PIZZAPI_ATTACHMENT_MAX_FILE_SIZE_BYTES`. The per-file limit checked in the upload route (`file.size > maxBytes`) defaults to **30 MB** via `DEFAULT_MAX_FILE_SIZE_BYTES = 30 * 1024 * 1024` and IS controlled by `PIZZAPI_ATTACHMENT_MAX_FILE_SIZE_BYTES` (attachments/store.ts:23,33; routes/attachments.ts:155). A single 40 MB file is rejected at 30 MB despite the 50 MB body ceiling. So both the "50 MB" number and the env-var association are wrong. (packages/server/src/handler.ts:13-16; packages/server/src/attachments/store.ts:23,33; packages/server/src/routes/attachments.ts:155)
- Fix: State "Attachment uploads: 30 MB per file by default (configurable via `PIZZAPI_ATTACHMENT_MAX_FILE_SIZE_BYTES`); multipart body ceiling 50 MB."

### [P1] Manual Docker Compose & "Running Without Docker" omit required `BETTER_AUTH_SECRET`
- Claim (line ~Manual Docker Compose / Running Without Docker): The manual compose path lists only `docker compose up -d` then "register an account"; the no-Docker path runs `bun run start` with only `PIZZAPI_REDIS_URL`. The Env Var table omits `BETTER_AUTH_SECRET` entirely.
- Reality: `docker/compose.yml`'s `server` service sets only `PORT`, `PIZZAPI_REDIS_URL`, `AUTH_DB_PATH`, and ntfy/proxy hints — no `BETTER_AUTH_SECRET`, no VAPID keys (docker/compose.yml:39-66). With it unset, `initAuth` logs "BETTER_AUTH_SECRET is not set. Sessions will be signed with an insecure key" and uses an ephemeral secret that invalidates all sessions on every restart (packages/server/src/auth.ts:332-339). `pizza web` generates and injects it (packages/cli/src/web.ts:493,804-808), but the manual paths documented here do not. (docker/compose.yml:39-66; packages/server/src/auth.ts:332-348)
- Fix: Add a step/env row for `BETTER_AUTH_SECRET` (min 32 chars, e.g. `openssl rand -hex 32`) for both manual compose and no-Docker, and note that without it sessions are wiped on restart.

### [P2] Manual Compose services table omits the `ntfy` service
- Claim (line ~"This starts:" table): lists only `redis`, `ui`, `server`.
- Reality: `docker/compose.yml` defines a fourth service `ntfy` (binwiederhier/ntfy:v2.25.0) that `server` depends on (`condition: service_started`), with its own `ntfy-data` volume and `NTFY_*` env (docker/compose.yml:75-126,150). `docker compose up -d` starts it. The doc never mentions it on this page (only mobile-push.mdx does). (docker/compose.yml:75-126)
- Fix: Add an `ntfy` row (port —, "Self-hosted push relay; optional, degrades gracefully") or note it is started and configured in mobile-push.mdx.

### [P2] "Development Stack" table invents separate `server (dev)` and `ui (dev)` services
- Claim (line ~Development Stack table): rows `server (dev)` port 7492 and `ui (dev)` port 5173.
- Reality: The `--profile dev` stack has a single combined `dev` service running `command: bun run dev` (which itself spawns server+UI via `concurrently`), exposing both 7492 and 5173 from one container (docker/compose.yml:128-145; root package.json:34). There is no separate `server`/`ui` dev service. Port numbers are correct; the service split is not. (docker/compose.yml:128-145)
- Fix: Replace the two rows with one `dev` row, ports `7492, 5173`, "Bun dev server (API + Vite UI via concurrently)".

### [P2] "Web Push configured automatically — no additional setup required" is false for manual compose
- Claim (line ~Web Push Notifications): "Push is configured automatically — no additional setup required."
- Reality: Only `pizza web` generates VAPID keys (packages/cli/src/web.ts:481,804-808). Manual `docker/compose.yml` does not set `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY`/`VAPID_SUBJECT`, so the server falls back to ephemeral keys regenerated each restart, breaking all subscriptions (packages/docs/.../web-ui/push-notifications.mdx:112 documents this exact failure). The ntfy native-push path additionally requires operator-provided `PIZZAPI_NTFY_PUBLIC_URL` + publish token (docker/compose.yml:51-53,93-118). (docker/compose.yml:39-66; packages/cli/src/web.ts:481)
- Fix: Qualify: "Push is configured automatically with `pizza web`. For manual compose/no-Docker, set VAPID keys (and `BETTER_AUTH_SECRET`) or push subscriptions will break on restart."

### [P2] "Always run `bun run migrate` before starting the server" is redundant
- Claim (line ~Database / Running Migrations): "After upgrading PizzaPi, always run migrations before starting the server: `bun run migrate`" and "Always run `bun run migrate` if you're running without Docker."
- Reality: The server runs `runAllMigrations(authContext)` on every boot (packages/server/src/index.ts, top-level `await runAllMigrations(authContext)`), which is identical to what `bun run migrate` (packages/server/src/migrate.ts) does. Migrations are idempotent and auto-applied on startup for both Docker and no-Docker paths. The manual step is unnecessary. (packages/server/src/index.ts; packages/server/src/migrate.ts:1-4; packages/server/src/migrations.ts:42-46)
- Fix: Replace with "Migrations run automatically on server startup; `bun run migrate` is optional for manual inspection."

### [P2] Database path `packages/server/auth.db` is only the non-Docker default
- Claim (line ~Database): "The database file lives at `packages/server/auth.db`."
- Reality: `dbPath` defaults to `AUTH_DB_PATH` env or `"auth.db"` relative to CWD (packages/server/src/auth.ts:330). For the manual Docker compose, `AUTH_DB_PATH=/app/data/auth.db` on a named volume `pizzapi-data` (docker/compose.yml:40,67); for `pizza web`, `/app/data/auth.db` bind-mounted to `~/.pizzapi/web/data/` (packages/cli/src/web.ts:748,804). The stated path is correct only for `cd packages/server && bun run start`. (packages/server/src/auth.ts:330; docker/compose.yml:40,67; packages/cli/src/web.ts:748)
- Fix: "Lives at `packages/server/auth.db` by default (non-Docker); Docker uses `/app/data/auth.db` (named volume `pizzapi-data`, or `~/.pizzapi/web/data/` for `pizza web`)."

### [P3] "Refreshes the configured UI image tag before startup" is vague
- Claim (line ~Quickest pizza web): "On subsequent runs, it pulls the latest repo changes and refreshes the configured UI image tag before startup."
- Reality: Repo pull is real (`git pull --rebase`, packages/cli/src/web.ts:555-561). The compose file is regenerated with the configured tag and `docker compose pull ui` runs (packages/cli/src/web.ts:1188-1190). The tag itself is not "refreshed" — it is regenerated from config/CLI version each run (web.ts:1153-1163). Minor imprecision, not wrong. (packages/cli/src/web.ts:545-561,1188)
- Fix: "On subsequent runs, it pulls latest repo changes, regenerates the compose file with the configured UI tag, and pulls the UI image before startup."

### [P3] "GHCR UI image by default" understates the actual default tag
- Claim (line ~Quickest pizza web / Aside): "Uses the GHCR UI image by default" and "`pizzapi web --tag main` to pull a specific GHCR UI tag."
- Reality: `parseArgs` defaults `tag: "latest"`, but when not running from a local repo the code overrides it with the installed CLI version (`parsed.tag = cliVersion`, packages/cli/src/web.ts:1153-1163). So the real default tag is the CLI version, not `latest`. Accurate enough for users but the doc's `--tag main` example implies `latest` is the default. (packages/cli/src/web.ts:890,1153-1163)
- Fix: Note the default tag matches the installed CLI version (falling back to `latest`).

## Redesign notes
- The page mixes the turnkey `pizza web` flow with the manual compose flow but only generates secrets for the former; the manual section silently inherits an insecure config. Consider a single "you MUST set `BETTER_AUTH_SECRET`" callout shared by both manual paths.
- The Env Var table is incomplete relative to what `pizza web` actually injects (`BETTER_AUTH_SECRET`, `VAPID_*`, `AUTH_DB_PATH`, `PIZZAPI_NTFY_URL`). Either link prominently to environment-variables.mdx or include the security-critical ones inline.
- The reverse-proxy section is excellent and code-accurate; consider promoting its structure (loopback auto-detect / CIDR / TRUST_PROXY / PROXY_DEPTH) as the model for other pages.
- The Development Stack and manual compose tables could be generated from `docker/compose.yml` facts to avoid the ntfy/dev-service drift found here.
- "Web Push Notifications" duplicates content better covered in web-ui/push-notifications.mdx and mobile-push.mdx; this page should only summarize and link.

## Code UX opportunities
- `docker/compose.yml` starts the server with no `BETTER_AUTH_SECRET`, producing only a console warning and silently-insecure ephemeral sessions. A fail-fast on first run (or auto-generation of a persisted secret into a bind-mounted file) would prevent manual-compose users from running production with invalidatable sessions — the doc has to paper over this with warnings.
- The attachment limit has two independent ceilings (`MAX_ATTACHMENT_BODY_SIZE` vs `attachmentMaxFileSizeBytes()`) with different defaults (50 MB vs 30 MB) and only one is env-configurable; surfacing a single configurable limit (or making the body ceiling track the configured file limit) would remove the doc confusion.
- `pizza web` persists `PIZZAPI_TRUST_PROXY`/`PIZZAPI_PROXY_DEPTH` from env into config.json (web.ts:766-786), but the manual compose user has no equivalent persistence and must hand-edit overrides. A `pizza web config set trustProxy true` key (it is not in `SETTABLE_KEYS`, web.ts:985) would close the gap.
