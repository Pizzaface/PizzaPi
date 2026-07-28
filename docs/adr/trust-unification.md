# ADR: Trust-gate unification (Phase 2 — characterization only)

- Status: Proposed (no code change in this phase)
- Related: `packages/cli/src/config/trust-gates.test.ts` (source of truth for current behavior)

## 1. Current state: four gates, inconsistent enforcement

PizzaPi has four independent trust gates, all reading `~/.pizzapi/config.json`
(global config) plus env-var overrides. None of them consult project config —
that would be self-authorization.

| Gate | Enforced? | Config key | Env override | Code |
|---|---|---|---|---|
| Project hooks | **Yes** — dropped (warn) unless trusted | `allowProjectHooks` | `PIZZAPI_ALLOW_PROJECT_HOOKS=1` | `config/io.ts` `isProjectHooksTrusted` / `loadConfig` |
| Project MCP servers | **No — warn-only** | `allowProjectMcp` | `PIZZAPI_ALLOW_PROJECT_MCP=1` | `config/io.ts` `isProjectMcpTrusted` / `loadConfig` |
| Project providers (`.pizzapi/providers/`) | **Yes** — excluded unless trusted | `allowProjectProviders` | none | `providers/loader.ts` `discoverProviders({allowProject})`, wired in `extensions/providers/extension.ts` |
| Claude-Code plugins | **Yes** — path allowlist, no global on/off switch | `trustedPlugins: string[]` | none | `config/io.ts` `isPluginTrusted`/`trustPlugin`/`untrustPlugin` |

The MCP gate is the outlier: `loadConfig` always merges `mcpServers` /
`mcp.servers` from the project config into the effective config regardless of
`allowProjectMcp`. The flag only silences a one-time warning
(`"project-mcp-untrusted"`). This is intentional per the code comment ("P0
fix: warn-and-load by default") — not a bug, but a deliberately looser gate
than the other three. Part 1 tests (`trust-gates.test.ts`, "warn-only gate"
describe block) pin this exact behavior so it isn't silently "fixed" by a
future refactor without a conscious decision.

The plugin gate is also structurally different: it's a path allowlist
(`trustPlugin`/`untrustPlugin`), not a boolean flag — a plugin is trusted
per-install, not per-project.

## 2. Upstream: pi 0.82.1's `project_trust` event

Verified against `@earendil-works/pi-coding-agent@0.82.1`
(`dist/core/trust-manager.d.ts`, `dist/core/project-trust.d.ts`,
`dist/core/extensions/types.d.ts`, `docs/security.md`).

Upstream pi has a single, binary, per-directory trust decision:

- **Event**: extensions can register `pi.on("project_trust", handler)`.
  `ProjectTrustEvent = { type: "project_trust", cwd }`. The handler returns
  `ProjectTrustEventResult = { trusted: "yes" | "no" | "undecided", remember?: boolean }`.
  The first extension to return a non-`"undecided"` decision owns the
  outcome (`extensions.md`/`types.d.ts` comment).
- **Persistence**: `ProjectTrustStore` (`core/trust-manager.ts`) reads/writes
  `~/.pi/agent/trust.json` — a flat map of canonical directory path →
  `true | false | null`, with nearest-ancestor lookup (`findNearestTrustEntry`)
  so trusting a parent folder covers subdirectories. Writes are file-locked
  (`proper-lockfile`).
- **Default policy**: `defaultProjectTrust: "ask" | "always" | "never"`
  (`settings-manager.d.ts`). `"ask"` prompts interactively when UI is
  available; non-interactive modes (`-p`, `json`, `rpc`) without a saved
  decision treat `"ask"`/`"never"` as untrusted and `"always"` as trusted.
  `--approve`/`--no-approve` override for a single run.
- **Scope gated**: trusting a project unlocks `.pi/settings.json`,
  `.pi/extensions`, `.pi/skills`, `.pi/prompts`, `.pi/themes`,
  `.pi/SYSTEM.md`, `.pi/APPEND_SYSTEM.md`, and project-local `.agents/skills`
  (`TRUST_REQUIRING_PROJECT_CONFIG_RESOURCES` in `trust-manager.ts`,
  confirmed in `docs/security.md`). `AGENTS.md`/`CLAUDE.md` load regardless.

So upstream trust is **one binary decision per directory** that gates a
fixed bundle of `.pi/*` resources — a different shape from PizzaPi's four
independent per-resource-type gates over `.pizzapi/*`.

## 3. Gap analysis

- **Granularity**: PizzaPi's gates are more granular (hooks, MCP, providers,
  plugins can each be trusted independently) than upstream's single yes/no.
  This granularity is a feature worth keeping — e.g. a user may want to run
  project hooks but never auto-load project MCP servers.
- **MCP is deliberately looser**: `allowProjectMcp` is warn-only by design
  (see code comment history — "P0 fix: warn-and-load by default"). This is
  not something upstream's binary trust model has an equivalent for, and
  this ADR does not propose changing it.
- **No overlap today**: PizzaPi does not currently subscribe to
  `project_trust` or read/write `~/.pi/agent/trust.json` anywhere in
  `packages/cli/src` (verified by grep). The two trust systems are
  completely separate; nothing currently double-gates.
- **Persistence shape differs**: PizzaPi stores gates as flags/allowlists in
  `~/.pizzapi/config.json`; upstream stores a directory→decision map in a
  dedicated `trust.json`. Adopting `trust.json` would mean a second
  persistence format to keep in sync.

## 4. Proposed migration (future phase, not this one)

Add a PizzaPi extension that registers a `project_trust` handler and maps
the resulting binary decision onto the existing per-resource gates, without
replacing them:

- On `project_trust` with `trusted: "yes"` (and `remember: true`): set
  `allowProjectHooks: true`, `allowProjectProviders: true`, and add the
  project's plugin root(s) to `trustedPlugins` in the global config —
  effectively "trusting a project" flips PizzaPi's independent gates open,
  matching the granularity users already rely on today rather than
  collapsing it.
- On `trusted: "no"`: leave existing gates as-is (default closed);
  optionally set them `false` explicitly if a per-directory decision needs
  to be recorded.
- `allowProjectMcp` / MCP loading stays warn-only and is **not** touched by
  this handler — MCP always loads, project_trust only affects whether the
  warning is silenced (i.e. the handler could set `allowProjectMcp: true`
  as a side effect of "yes", but never gates the load itself).
- The handler is additive: an extension providing `project_trust` is
  optional infrastructure that a user session may or may not load. Without
  it, PizzaPi's current per-flag gates behave exactly as documented in
  section 1 — nothing about upstream's `project_trust` event is required
  for PizzaPi to function.

This mapping needs its own idea/PR with real tests before implementation;
it is out of scope here.

## 5. Non-goals (this phase)

- No production behavior change. Zero lines of non-test, non-doc code
  changed in this PR.
- No change to any default value (`allowProjectHooks`, `allowProjectMcp`,
  `allowProjectProviders`, `trustedPlugins` all keep today's defaults).
- No adoption of `trust.json` or the upstream `ProjectTrustStore` in this
  phase — PizzaPi's `~/.pizzapi/config.json`-based gates remain the only
  persistence mechanism for now.
- No new extension registering `pi.on("project_trust", ...)` yet — section 4
  is a proposal, not an implementation plan for this PR.
