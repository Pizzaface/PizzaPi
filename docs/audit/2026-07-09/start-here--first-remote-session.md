# Audit: start-here/first-remote-session.mdx
Verdict: MINOR ISSUES
Claims checked: 18 | Failed: 4

## Findings

### [P2] Setup wizard prompt list omits the "Your name" prompt
- Claim (line ~52): "The setup wizard will prompt for: Relay server URL — enter `http://localhost:7492`; Email and password — use the account you just created"
- Reality: `runSetup` prompts in this order: `Relay server URL` → `Your name (leave blank if account already exists):` → `Email:` → `Password:` (packages/cli/src/setup.ts:217-227). The name prompt is mandatory in the flow and the doc never mentions it. A user who created an account in the browser (step 2) must know to leave name blank, otherwise `/api/register` treats a non-blank name as a new-account signup attempt (packages/server/src/routes/auth.ts:117-120 requires `name` for new accounts).
- Fix: Add "Your name (leave blank if you already signed up in the browser)" to the prompt list.

### [P2] Setup example output is inaccurate and out of order
- Claim (line ~58): shows banner `│        PizzaPi — first-run setup        │` and only `Connecting to relay server… ✓` then `✓ API key saved to ~/.pizzapi/config.json`
- Reality: The banner actually renders `│     🍕 PizzaPi — first-run setup     │` over a 43-dash frame (packages/cli/src/setup.ts:200-204), and after connecting the wizard prints three lines: `✓ API key saved to ~/.pizzapi/config.json`, `✓ Relay: ws://localhost:7492`, and `✓ Theme set to pizzapi-dark` (packages/cli/src/setup.ts:264-274). The doc's example omits the emoji, the relay line, and the theme line.
- Fix: Replace the mock output with the real banner and include the relay + theme lines (or note they appear).

### [P3] "Redis (event buffer)" is a loose, unsupported description
- Claim (line ~30): "spins up a Docker Compose stack with Redis (event buffer) and the PizzaPi server (relay API + web UI)"
- Reality: The generated compose template (packages/cli/src/web.ts:597-606) defines a `redis` and a `server` service (plus an optional `ui` image service at web.ts:796). Redis is wired via `PIZZAPI_REDIS_URL=redis://redis:6379` and used by the relay for pub/sub and session state; calling it strictly an "event buffer" is imprecise. The doc also omits the separate `ui` image service that populates the `ui-dist` volume.
- Fix: Say "Redis (relay state/pub-sub) and the PizzaPi server (relay API + web UI), with the web UI assets served from a separate UI image."

### [P3] Missing prerequisite and missing first-run cost for `pizzapi web`
- Claim (line ~12): prerequisites list only Docker + Docker Compose; step 1 says "One command builds and starts everything"
- Reality: When run from an npm/global install, `pizzapi web` clones the PizzaPi repo into `~/.pizzapi/web/repo` via `git clone` (packages/cli/src/web.ts:549-574), then pre-builds the UI on the host with `bun` (web.ts:631-706) and builds Docker images. This requires `git` on PATH and can take several minutes on first run. Neither git nor the build time is mentioned.
- Fix: Add `git` to prerequisites and note that the first `pizzapi web` clones the repo and builds images (expect a few minutes).

### [P3] Default auth tab is "Sign in", not "Sign up"
- Claim (line ~40): "Click **Sign up** to create an account."
- Reality: `AuthPage` defaults to `tab = "signin"` (packages/ui/src/components/AuthPage.tsx:23); the Sign up tab is shown only when `/api/signup-status` returns `signupEnabled === true` (AuthPage.tsx:34-48). On a fresh relay signup is enabled, so the instruction works, but the doc implies Sign up is the landing view.
- Fix: Minor — say "Switch to the **Sign up** tab to create an account."

### [P3] `pizzapi` first-run auto-setup behavior not mentioned
- Claim (line ~66): step 4 just runs `pizzapi` after `pizzapi setup`
- Reality: If no API key is configured, running `pizzapi` with no args auto-invokes `runSetup()` (without `force`), which first asks "Skip setup and continue without relay? [y/N]" (packages/cli/src/index.ts:411-414, packages/cli/src/setup.ts:211-216). Because the tutorial already ran `pizzapi setup`, this won't trigger, but the doc never explains that `pizzapi` itself is setup-aware.
- Fix: Optional note that `pizzapi` will auto-prompt for setup if not yet configured.

## Redesign notes
- The tutorial duplicates the "navigate to :7492 → register → run `pizzapi setup` pointing at http://localhost:7492" sequence already covered in `deployment/self-hosting.mdx` (lines 95-99). Consider factoring the shared setup snippet into a shared include.
- The setup-wizard mock terminal block is the riskiest part of the page (hand-written, drifts from real output). Replace with a trimmed real transcript or a schematic "prompts: A, B, C" list rather than an ASCII mock.
- Prerequisites mix runtime needs (Docker) with provider needs (API key) but omit `git` and (for the build step) `bun`, which `pizzapi web` uses for host UI pre-build.
- "What's Next" is good and all four linked pages exist (verified via find).

## Code UX opportunities
- The setup wizard's `Your name (leave blank if account already exists)` prompt is a friction point for the documented flow (sign up in browser, then run `pizzapi setup` with those creds). The wizard could detect the existing account via `/api/register`'s existing-user branch and skip the name prompt, or pre-fill name from the relay profile.
- `pizzapi web`'s first-run (clone + UI prebuild + Docker build) produces a long log before the single `✅` success line; a progress/phase indicator ("Cloning repo… / Building UI… / Building image… / Starting stack…") would help users know it hasn't stalled.
- The setup success output omits the relay URL the wizard actually saved (`ws://localhost:7492`); surfacing the configured relay URL prominently would let users confirm they typed the right host.
