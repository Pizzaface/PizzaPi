# Audit: start-here/getting-started.mdx

Verdict: MINOR ISSUES

Claims checked: 39 | Failed: 6

## Findings

### [P1] Verification checklist misstates what `pizzapi setup` does
- Claim (line ~150): "Relay configured | `pizzapi setup` | Shows saved API key + relay URL"
- Reality: `runSetup({ force: true })` always re-runs the interactive wizard from scratch — it prompts for relay URL, name, email, password and re-registers a NEW account/API key. It never displays the existing saved config. (packages/cli/src/setup.ts:176-269; packages/cli/src/index.ts:81-82)
- Fix: Replace with a command that actually shows config, e.g. `pizzapi setup` → "Re-runs the setup wizard" or point users at `cat ~/.pizzapi/config.json`.

### [P2] Manual Docker setup omits required `BETTER_AUTH_SECRET` (and VAPID) env vars
- Claim (line ~130): `docker compose -f docker/compose.yml up -d` is presented as a complete manual setup, with the web UI "now live".
- Reality: `docker/compose.yml`'s `server` service does NOT set `BETTER_AUTH_SECRET` or VAPID keys (only `PORT`, `PIZZAPI_REDIS_URL`, `AUTH_DB_PATH`, ntfy/proxy hints). The server then logs "BETTER_AUTH_SECRET is not set. Sessions will be signed with an insecure key" and uses an ephemeral secret that invalidates sessions on restart. `pizza web` avoids this by generating `betterAuthSecret`/VAPID keys into its own compose (packages/cli/src/web.ts:804-808). (docker/compose.yml:39-66; packages/server/src/auth.ts:332-339; packages/cli/src/web.ts:760-810)
- Fix: Add a step to set `BETTER_AUTH_SECRET` (and optionally VAPID keys) before `docker compose up`, or note that `pizza web` is the only supported turnkey path and manual compose is for dev only.

### [P2] Manual compose service table is incomplete and implies host-accessible Redis
- Claim (line ~135): table lists only `redis` (6379) and `server` (7492).
- Reality: `docker/compose.yml` defines four services by default: `redis`, `ui` (ghcr.io/pizzaface/pizzapi-ui), `server`, and `ntfy` (plus a `dev` profile). Redis's host port mapping is commented out — it is only reachable on the internal Docker network; the compose file explicitly says "Uncomment the ports mapping below if you need direct host access." (docker/compose.yml:4-21, 24-37, 69-101)
- Fix: Add `ui` and `ntfy` rows, and clarify Redis 6379 is internal-only (not published to the host) unless uncommented.

### [P3] First-run wizard output box omits the "Skip setup?" prompt and theme line
- Claim (line ~58): the depicted first-run wizard output starts directly at "Relay server URL [...]:" and ends at "✓ Relay: wss://...".
- Reality: When launched via bare `pizzapi` (force=false), the wizard first asks "Skip setup and continue without relay? [y/N] " (setup.ts:202-207), prints a header box with "🍕 PizzaPi — first-run setup" and an intro line "Connect this node to a PizzaPi relay server..." (setup.ts:184-195), and after success prints an extra "✓ Theme set to pizzapi-dark" line (setup.ts:257-268). The box also uses 43 dashes with a 🍕 emoji, not the plain 41-dash box shown.
- Fix: Either note the output is abbreviated, or add the skip prompt, intro line, and theme line; correct the box width/emoji.

### [P3] Prerequisite wording for Docker is too narrow
- Claim (line ~25): "Docker + Docker Compose — only if you self-host with `pizzapi web`"
- Reality: The "Manual Setup" path in Option B also requires Docker Compose (`docker compose -f docker/compose.yml up -d`). (docker/compose.yml; getting-started.mdx ~line 130)
- Fix: Say "only if you self-host (via `pizza web` or the manual Docker path)".

### [P3] "Todo List … in the sidebar" placement is unverified / likely wrong
- Claim (line ~178): "it appears as a live-updating todo list in the sidebar"
- Reality: The UI renders todos via `TodoCard` as a card in the message stream (packages/ui/src/components/session-viewer/tool-rendering.tsx:698-703; cards/TodoCard.tsx), and `todoList` state is surfaced through the session viewer. No sidebar-specific todo widget was found; the sidebar is session-list/navigation. (packages/ui/src/App.tsx:5353; components/SessionViewer.tsx:161)
- Fix: Change "in the sidebar" to "as a card in the session stream" (or verify and cite the sidebar component if one exists).

## Redesign notes
- The page duplicates install/first-run content already covered in `start-here/installation.mdx` (First-Run Setup, Resetting Configuration) and self-host content in `deployment/self-hosting.mdx`. Consider trimming Option B to a one-liner that links out, keeping this page a true 5-minute quickstart.
- The verification checklist mixes CLI checks and in-session checks (`/login`, `/model`) without saying when to run which; a user who just finished setup has not yet started a session, so `pizzapi models` will print "No configured models found." until auth exists. Reorder or annotate.
- The wizard output block is presented as literal transcript but is actually paraphrased; mark abbreviated blocks clearly or paste verbatim output.
- The "What You'll See" cards are marketing-style and unauditable here; consider screenshots with captions instead of prose claims.

## Code UX opportunities
- `pizzapi setup` has no `--show` / read-only mode to display current config; the docs had to invent one. A `pizzapi config show` (or `pizzapi setup --status`) would give users a real verification command.
- `docker/compose.yml` silently starts the server with an insecure ephemeral `BETTER_AUTH_SECRET`; consider failing fast (or generating and writing a persisted secret on first run) so manual-compose users don't end up with signed-but-invalidated sessions.
- The first-run wizard's skip prompt ("Skip setup and continue without relay? [y/N]") only appears when `force=false`, but `pizzapi setup` (force=true) skips it — making the "escape hatch" behavior depend on invocation form. Surfacing `--no-relay` as an explicit first-class flag in the wizard help would be clearer than the implicit y/N branch.
- Manual `docker compose -f docker/compose.yml up -d` requires users to know about `ui` and `ntfy` services that aren't documented here; a commented banner in the compose file or a `pizza web --manual` guide would reduce surprise.
