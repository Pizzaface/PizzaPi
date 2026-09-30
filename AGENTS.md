# PizzaPi: agent guide

PizzaPi is a self-hosted browser/mobile interface and relay for the pi coding
agent. Read [CONTRIBUTING.md](CONTRIBUTING.md) before changing code. Its review,
testing, security, and delivery requirements apply to agents and humans alike.

## Start here

1. Read the request and inspect the working tree. Preserve unrelated changes.
2. Read the affected implementation, nearby tests, and relevant docs before
   proposing a fix. Reproduce reported failures where practical.
3. Trace the change across the runner, relay, protocol, and UI when applicable.
   State the expected behavior and how it will be verified.
4. Make the smallest complete change. Do not mix unrelated refactors or silently
   broaden the task. Follow explicit user constraints on tools and delegation.
5. Verify the final diff and report results using the completion checklist in
   [CONTRIBUTING.md](CONTRIBUTING.md#definition-of-done).

## Repository map

| Location | Responsibility |
| --- | --- |
| `packages/protocol` | Shared wire types and contracts |
| `packages/extension-sdk` | Public overlay-package authoring and host/service contracts |
| `packages/tunnel` | Streaming HTTP/WebSocket transport between runner and relay |
| `packages/tools` | Shared tools, sandbox enforcement, and utilities |
| `packages/server` | Authentication, HTTP/Socket.IO relay, persistence, events, attachments |
| `packages/ui` | React web UI/PWA, session state, settings, and service panels |
| `packages/cli` | pi integration, session host, runner, plugins, overlays, and CLI |
| `packages/docs` | Starlight documentation and MDX content bundled with the CLI |
| `packages/npm` | npm distribution and publishing tooling |
| `mobile`, `android`, `ios` | Capacitor wrapper and native projects |
| `patches` | Bun-managed patches to dependencies |
| `scripts` | Workspace setup, test isolation, builds, and release helpers |
| `docker` | Deployment and runner containers |

The application uses Bun, strict TypeScript/ESM, React, better-auth,
Kysely/SQLite, and Redis. Read the manifests for current dependency versions.

## Commands and sources of truth

Use **Bun** for workspace installation, builds, and tests. Do not substitute
npm/yarn/pnpm for the workspace workflow; npm distribution tests are separate.

- Install: `bun install --frozen-lockfile`
- Application build: `bun run build`
- Lint: `bun run lint`
- Typecheck (including prompt generation and selected test projects): `bun run typecheck`
- Full test orchestration: `bun run test`
- Development server and UI: `bun run dev`
- Documentation build: `bun run build:docs`
- Database migrations, on an isolated development database: `bun run migrate`

The root `package.json` defines the application build order:
`protocol` → `extension-sdk` → `tunnel` → `tools` → `server` → `ui` → `cli`.
Docs, distribution builds, and mobile builds have separate scripts.

Use the root test command rather than replacing it with a blanket `bun test`:
it intentionally isolates stateful server and CLI suites. For a focused
stateful suite, use `bun scripts/test-isolated.ts <test-file-or-directory>`.
Read the suite's setup before running it; test preload and integration fixtures
can start infrastructure. See [CONTRIBUTING.md](CONTRIBUTING.md#verification).

Treat manifests, workflow files, and executable configuration as the source of
truth for commands and automation. Do not maintain static test counts here.
Documentation drift should be corrected, not used to excuse missing checks.

## PizzaPi-specific invariants

### Session lifecycle and delivery

- Use `packages/cli/src/runner/session-host.ts` for remote session control.
  Do not restore upstream patches merely to widen pi's `ExtensionAPI` when a
  supported host/runtime API already provides the capability.
- Preserve steering vs follow-up semantics, queue ordering, cancellation,
  and already-expanded prompt contents.
- When changing tools, prompts, models, or session state, verify exactly when
  the change becomes visible to the next assistant response. Add tests that
  cross that lifecycle boundary; a setter assertion alone is insufficient.
- Exercise reconnects, duplicate/replayed events, stale responses, session
  switches, snapshot hydration, and pagination when the affected path uses
  them. Preserve ordering and avoid losing or rendering messages twice.

### Events, services, and isolation

- Read [CONTEXT.md](CONTEXT.md) for event-system terminology and contracts.
  Events, routes, runtime status, deliveries, and response contracts are
  different concepts. A saved route is not proof that a service has armed it.
- Preserve authenticated ownership across HTTP, Socket.IO, webhooks, tunnel
  traffic, and runner services. Never trust a caller-supplied owner/session ID
  without checking its authorization in the affected boundary.
- Treat reconnection and retry paths as normal operation. Define deduplication,
  expiration, cleanup, and recovery behavior for new asynchronous work.
- Never point a sandbox or test harness at a user's or production Redis,
  SQLite database, config directory, credentials, or session history. Use
  disposable fixtures and dedicated infrastructure. The `dev:redis` helper
  may reuse a listener on port 6379; it is not proof of isolation.

### Features and configuration

- User-facing capabilities need an appropriate web UI and CLI/TUI path, or
  an explicit explanation of why a surface does not apply. Include loading,
  empty, error, cancellation, and recovery states where relevant.
- New PizzaPi-specific environment variables use `PIZZAPI_`; preserve upstream
  names and existing compatibility aliases. Document defaults and validation.
- Prefer Claude-compatible `mcpServers` configuration. Preserve supported
  legacy inputs unless the change includes an explicit migration decision.
- Follow overlay trust/grant checks; package discovery is not permission to
  execute services or expand access. Keep security-sensitive approvals fail-closed.

### Patches, prompts, and documentation

- Keep dependency changes reproducible in manifests, `bun.lock`, and
  `patchedDependencies`. Use Bun's patch workflow; never leave a fix only in
  `node_modules`. Read the actual patch files and `patches/README.md`.
- On upstream upgrades, reassess every affected patch and run
  `bun test packages/cli/src/patches.test.ts` in addition to the required gates.
- Edit prompt sources in `packages/cli/src/config/templates/` and composition
  in `packages/cli/src/config/system-prompt.ts`. Do not hand-edit generated
  `system-prompt.precompiled.ts`; regenerate through the typecheck/build workflow.
- User-facing docs live under `packages/docs/src/content/docs/`. Update the
  relevant existing page when changing behavior, commands, config, permissions,
  or installation. Read `reference/agent-facing-docs.mdx` for bundled-doc rules.
- Keep README concise. Link detailed guidance instead of duplicating it.

## Safe delivery

Work on a feature branch. Do not commit directly to `main`, bypass checks to
hide failures, revert others' work, or run destructive cleanup without approval.
Do not infer permission to publish, merge, release, or deploy from a request to
inspect or edit code. `pizza web` can rebuild/restart a deployment; it is not a
verification command.

When a push or PR is requested, verify the target branch and resulting commit.
Use a draft PR unless instructed otherwise. Report passed, failed, blocked, and
not-run checks separately. A timeout, skipped job, or cancelled test is not a
pass. Leave an accurate handoff even when verification is blocked.
