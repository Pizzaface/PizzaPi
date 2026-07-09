# Audit: index.mdx
Verdict: MINOR ISSUES
Claims checked: 22 | Failed: 0

## Findings

### [P3] "Offline support" PWA claim is mildly overstated
- Claim (line 73): "Install PizzaPi as a Progressive Web App on your phone or tablet. Get a native app experience with offline support and home screen access."
- Reality: The PWA config precaches only the app shell (`globPatterns: ["**/*.{css,html,ico,png,svg,woff,woff2}"]`) and SWR-caches JS chunks; all `/api/` calls are `NetworkOnly` and WebSocket live data requires the relay (packages/ui/vite.config.ts:90-138). The app *opens* offline but cannot stream or interact without the relay. "Offline support" implies more than app-shell caching.
- Fix: Say "home-screen installable with cached app shell" instead of "offline support".

### [P3] Native mobile app (Capacitor) is omitted
- Claim (lines 70-77): The "Why PizzaPi?" section lists only an installable PWA for mobile.
- Reality: The repo ships a full native mobile build — Capacitor 8 deps, `build:mobile`, `build:mobile:android`, `build:mobile:android:release`, `build:mobile:ios` scripts, a `mobile/` workspace and `android/` project (package.json:11-19, 26-30). The landing page never mentions native Android/iOS apps.
- Fix: Add a card or note that native Android/iOS apps are also available alongside the PWA.

### [P3] Setup-wizard description omits QR-code path
- Claim (line 102): "On first run, the setup wizard asks for your relay URL and credentials."
- Reality: `runSetup` supports a QR-code setup-claim flow in addition to manual relay URL/email/password entry (packages/cli/src/setup.ts:179-236, `/api/setup-claim` token at setup.ts:83-115). The description flattens this to one path.
- Fix: "asks for your relay URL and credentials (or scans a QR code)".

### [P3] "How It Works" step 1 command slightly inconsistent with Quick Install
- Claim (line 98): "Run `npx @pizzapi/pizza` (or install globally)."
- Reality: Both forms are correct — the published npm package is `@pizzapi/pizza` with `bin: { pizza, pizzapi }` (packages/npm/build-npm.ts:212-223). No factual error, but the Quick Install block below (lines 113-118) shows the global install invoking `pizzapi` while the CLI help itself leads with `pizza web` / `pizza runner` (packages/cli/src/index.ts:332-337). The two command names (`pizza` vs `pizzapi`) appear without explanation, which can confuse new users.
- Fix: Note once that `pizza` and `pizzapi` are aliases for the same binary.

### [P3] Verbosity / duplication between README and landing page
- Claim (lines 113-126): The Quick Install + first-run Aside duplicates the README "Quick Start" almost verbatim (README.md:7-16).
- Reality: AGENTS.md instructs "Do not duplicate detailed docs in the README" — the landing page is fine, but the near-identical phrasing in both places means updates must be made in two spots.
- Fix: Keep the canonical install snippet in one place and link from the other.

## Redesign notes
- The page is a splash/landing page and is largely accurate; every feature card maps to real code (WebSocket streaming, `spawn_session`/`respond_to_trigger`/`tell_child` triggers, web-push VAPID, multi-runner registration, Docker Compose self-host, PWA).
- "Built With" table is correct: Bun runtime, better-auth, Kysely + SQLite (`kysely-bun-sqlite`), Redis, web-push, React 19, Vite 6, TailwindCSS v4, Radix/shadcn all match package.json deps.
- All internal doc links resolve (`/PizzaPi/start-here/getting-started/`, `/start-here/installation/`, `/deployment/self-hosting/`) against astro.config.mjs sidebar + files present in `start-here/`.
- Hero `image.file: ../../assets/logo.svg` resolves (packages/docs/src/assets/logo.svg exists).
- GitHub URL `https://github.com/Pizzaface/PizzaPi` matches astro.config.mjs social/editLink and `REPO_URL` in web.ts.
- Consider adding the native mobile app and the `pizza web` one-command self-host flow (prominent in README) to the landing page since they are headline features.

## Code UX opportunities
- The CLI exposes two binary names (`pizza` and `pizzapi`) without a clear primary; picking one as canonical would reduce doc confusion and let the other be a documented alias.
- `pizza web` prints its URL only after starting (`http://localhost:${config.port}`) — the landing page could link this directly, and the CLI could surface a "open in browser" shortcut for first-time users.
- The setup wizard's QR-code path is a strong UX feature invisible in the landing-page narrative; surfacing it would strengthen the "from your phone" pitch.
