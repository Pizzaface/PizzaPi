# Contributing to PizzaPi

These requirements apply to human and agent-assisted contributions. A change
should solve a stated problem, preserve PizzaPi's security and lifecycle
contracts, and carry enough evidence for another person to review it.

## Scope and workflow

- Use a feature branch and keep each PR focused on one coherent outcome.
  Separate unrelated cleanup, generated churn, and dependency upgrades.
- Describe the problem, expected behavior, and affected surfaces before a large
  change. Discuss breaking contracts, new dependencies, and persistence or
  security changes with the maintainer before committing to the design.
- Read [AGENTS.md](AGENTS.md) for the repository map and operational invariants.
  Preserve unrelated working-tree changes.
- Prefer established abstractions. Add a new abstraction when it removes real
  duplication or enforces a clear contract, not merely to wrap one function.
- Commit messages should identify intent, for example `fix(relay): preserve
  event order during reconnect`. Use the PR description for the evidence.

## Code requirements

### Correctness and maintainability

- Use strict TypeScript and ESM; match the affected module's conventions.
  Give exported APIs clear parameter and return types. Validate untrusted data
  at runtime; TypeScript types and casts are not validation.
- Avoid unexplained `any`, non-null assertions, ignored errors, and lint/type
  suppressions. A necessary exception needs a narrow scope and a reason.
- Keep UI state, transport, persistence, and agent execution responsibilities
  distinct. Put shared wire contracts in `packages/protocol`; keep the public
  extension contract in `packages/extension-sdk`.
- Make failure paths explicit. Do not silently swallow unexpected errors,
  fabricate success, or log secrets. Error messages should help locate the
  failing operation without exposing sensitive payloads.
- Bound memory, queues, payloads, and retries where external input can grow
  them. Release listeners, timers, sockets, and child processes on teardown.
- Preserve supported platforms. Explain platform-specific behavior and test
  it on the affected platform when possible; cross-compilation is not runtime
  verification.

### Security and compatibility

- Authenticate the transport and authorize access to the actual resource.
  Test cross-user/resource denial for ownership-sensitive changes.
- Preserve sandbox boundaries, overlay trust/grants, and approval enforcement.
  Missing or disconnected approval UI must not become implicit approval.
- Treat paths, URLs, webhook bodies, uploaded files, and extension messages as
  untrusted. Validate the relevant traversal, origin, size, and schema limits.
- Never commit credentials, real user fixtures, private session transcripts,
  database dumps, or production configuration. Use synthetic test data.
- For wire, persistence, config, or public SDK changes, document compatibility
  with existing clients/data. Add migrations and migration tests when needed;
  explain rollback or irreversible consequences.
- Dependency additions need a concrete purpose. Review their license, execution
  hooks, maintenance, and bundle/runtime impact. Commit intentional lockfile
  changes; use the existing Bun patch mechanism for dependency fixes.

### User-facing completeness

- Include the applicable web UI and CLI/TUI paths. Explain intentional surface
  exclusions; backend plumbing alone is not a complete user-facing feature.
- Cover loading, empty, error, cancellation, retry, and disconnected states as
  applicable. Preserve keyboard access, focus, labels, and mobile usability.
- For UI changes, provide screenshots or a short recording and reproduction
  steps. Exercise repeated actions and interrupted flows, including navigation
  and session switches when relevant.
- Keep performance evidence proportional to the change: payload/buffer sizes
  for streaming work, cold and warm paths for session loading, and bundle size
  for UI dependencies. The UI build includes its bundle-budget check.

## Test requirements

- Behavior changes require tests for the changed contract. Bug fixes need a
  regression test that fails for the original defect and passes with the fix
  where practical. If reproduction is not automatable, document why and give
  repeatable manual evidence; do not invent an automated guarantee.
- Co-locate unit tests with source; use package test directories for integration
  and harness tests. Follow adjacent `bun:test` conventions and setup.
- Test outcomes and boundaries, not only implementation details or mocks. Cover
  the normal case plus relevant invalid input and failure/recovery paths.
- Lifecycle changes need tests across the boundary: next assistant response,
  queued delivery, abort/restart, reconnect, duplicate event, stale response,
  or session switch. Select the cases affected by the change.
- Keep tests deterministic and isolated. Avoid live providers, paid model calls,
  production services, and shared personal infrastructure. Do not make tests
  pass by weakening assertions, skipping coverage, or extending timeouts without
  diagnosing the underlying issue.
- Do not claim a coverage percentage or file count as proof of correctness.
  Explain which behavior the tests establish and what remains unverified.

## Verification

The root scripts and `.github/workflows/ci.yml` define the executable gates.
The main CI workflow currently pins Bun **1.3.10**; check that file when updating
this requirement. Install the matching Bun release before working locally.

```sh
bun install --frozen-lockfile
bunx playwright install --with-deps chromium
bun run lint
bun run typecheck
bun run build
bun run test
```

Playwright's command installs browser/system dependencies; use an appropriate
isolated development environment. Server/integration suites also need the
infrastructure declared by their setup and harness. CI supplies disposable
Redis. Never aim tests at an existing user or production Redis instance.
`bun run dev:redis` can reuse port 6379 and must not be assumed isolated.

Run focused checks while iterating, then the full gates against the final code
before requesting merge. The root test script intentionally separates suites
into processes to prevent module/mock state leakage. Do not substitute a single
unscoped `bun test` and report it as equivalent. For focused stateful server/CLI
suites use `bun scripts/test-isolated.ts <test-file-or-directory>`.

Additional checks depend on the change:

| Change | Additional evidence |
| --- | --- |
| Dependency patches or pi upgrade | Patch regression tests and affected lifecycle/provider tests |
| MDX/docs-site content | `bun run build:docs`; check links, commands, frontmatter, and bundled-agent readability |
| CLI packaging/assets | Relevant compiled-binary/install smoke checks; verify bundled assets |
| Mobile wrapper/native behavior | Relevant Android/iOS build and device/simulator behavior; distinguish sync from an actual native build |
| Runner container/deployment | Isolated container checks; use a disposable relay for integration exercises |
| Database/auth/wire contracts | Migration/compatibility checks and negative authorization cases |

For prose-only repository Markdown changes, validate links, referenced scripts,
and the diff; application tests need not be run unless behavior or generated
inputs are affected. Main CI currently ignores Markdown and docs-only changes;
absence of a CI run is not passing CI. The docs deployment workflow runs on
matching pushes to `main`, not as a general PR validation gate.

If a required check cannot run, state the command, reason, and remaining risk.
A failed, cancelled, hung, skipped, or partially executed check is not a pass.
Mark the PR as needing verification rather than claiming merge readiness.

## Documentation and review

- Update the relevant MDX docs for changed behavior, flags, defaults, config,
  permissions, APIs, setup, and operational recovery.
- Update prompt templates when agent-facing tools or behavior change; regenerate
  generated prompt code through the existing scripts.
- Keep volatile versions and counts in their authoritative manifests/config,
  or identify the source when documenting them. Do not copy stale inventories.
- Use the [PR template](.github/pull_request_template.md). Include the problem,
  change, risks, compatibility, and exact verification evidence. Mark genuinely
  inapplicable checklist items with an explanation.
- A maintainer should review correctness, scope, security, and evidence before
  merging. Green CI supports review; it does not replace it.

## Definition of done

1. The requested behavior is implemented and the diff contains no unrelated work.
2. Relevant regression and boundary tests are present, with required checks
   passing against the final code or explicit blockers recorded for review.
3. Applicable UI/CLI surfaces, documentation, compatibility, and recovery are
   addressed.
4. The handoff identifies changes, verification results, and known limitations.
5. If publication was requested, the branch/PR and pushed commit are verified.
   If deployment or merging was requested, verify that separately.

These are contribution requirements, not permission to publish or deploy.
Do not force-push, merge, release, restart production, or file unrelated issues
without appropriate authorization. Git hooks are local safeguards; a checklist
is review guidance. Branch protection and required CI checks must be configured
separately to enforce merge policy on GitHub.
