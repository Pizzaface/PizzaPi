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

- **Granularity**: PizzaPi's gates are more granular than upstream's single
  yes/no — hooks, providers, and plugins are each independently *enforced*
  (each can be denied on its own). This granularity is a feature worth
  keeping — e.g. a user may want to run project hooks but never auto-load
  project-local providers. MCP is the exception: `allowProjectMcp` is a real,
  independent config key, but it does not gate loading (see next bullet and
  section 1) — project MCP servers always merge in regardless of its value,
  so MCP is not an example of enforced per-resource granularity today.
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

## 4. Why the two systems should NOT be merged by flag-remapping

An earlier draft of this ADR proposed a `project_trust` handler that, on
`trusted: "yes"`, would flip PizzaPi's `allowProjectHooks`,
`allowProjectProviders`, and `trustedPlugins` open. **That proposal is
wrong and is rejected.** Two upstream facts make it unworkable:

1. **The handler can't observe a resolved decision — it produces one.**
   `ProjectTrustHandler = (event: ProjectTrustEvent, ctx) => Promise<ProjectTrustEventResult> | ProjectTrustEventResult`.
   The event payload (`{ type: "project_trust", cwd }`) carries *only* the
   cwd; there is no persisted-trust lookup passed in. The handler runs
   *before* pi resolves `trust.json` / `defaultProjectTrust` — its job is to
   supply the decision (`trusted: "yes" | "no" | "undecided"`), not to react
   to one that already exists. A PizzaPi extension hooking this event has no
   way to say "only run my side effect when pi decided this project is
   trusted" — it would have to re-implement its own ask/persist/lookup logic
   just to get that information, duplicating `ProjectTrustStore`.
2. **PizzaPi's boolean gates are global, not per-directory.**
   `allowProjectHooks`, `allowProjectProviders`, and `allowProjectMcp` all
   live in `~/.pizzapi/config.json` with no cwd scoping (section 1). Setting
   any of them from a `project_trust` handler — which fires per-cwd — would
   trust *every* project globally the first time *any one* directory is
   trusted. That's a strict security regression versus today's
   already-global (but at least explicit, user-set) flags, not a migration.
   `trustedPlugins` is structurally different and does not have this
   failure mode the same way: it's a path allowlist (section 1), so wiring
   it to `project_trust` would add only the specific plugin root paths
   discovered under that one cwd, not flip a global switch open for every
   project. It would still bypass the explicit `pizza plugins trust` review
   step, which is its own regression — but "trusts every project" is not an
   accurate description of what auto-populating `trustedPlugins` would do.

### What's actually viable, in order of laziness

- **Recommended for now: don't adopt `project_trust` for these four gates.**
  Keep them independent, global, and explicitly user-set exactly as they are
  today. The granularity (hooks vs. providers vs. plugins independently
  enforced) is a real feature upstream's single yes/no doesn't offer, and
  `allowProjectMcp`'s warn-only UX (section 1) has no upstream equivalent to
  map onto. Simplest, safest, zero new code — this ADR's actual recommendation.
- **Future work, only if per-directory granularity is wanted:** give PizzaPi
  its own per-directory trust store mirroring upstream's `trust.json`
  (canonical path → decision, nearest-ancestor lookup) and gate resources by
  `(cwd, resource)` instead of by resource alone. That is new persistence and
  new call-site plumbing at every gate check — not a flag remap — and would
  need its own idea/PR with real tests. Out of scope here.
- **Where `project_trust` genuinely fits:** if/when PizzaPi introduces a
  resource that only makes sense as "is this cwd trusted at all" (mirroring
  upstream's `.pi/*` bundle), subscribing to `project_trust` to *supply* that
  per-cwd decision is legitimate — that's the event's actual contract. It is
  not a mechanism for retrofitting global flags.

## 5. Non-goals (this phase)

- No production behavior change. Zero lines of non-test, non-doc code
  changed in this PR.
- No change to any default value (`allowProjectHooks`, `allowProjectMcp`,
  `allowProjectProviders`, `trustedPlugins` all keep today's defaults).
- No adoption of `trust.json` or the upstream `ProjectTrustStore` in this
  phase — PizzaPi's `~/.pizzapi/config.json`-based gates remain the only
  persistence mechanism for now.
- No new extension registering `pi.on("project_trust", ...)` — section 4
  recommends against adopting it for the existing four gates at all, and
  scopes any future per-directory work as a separate, out-of-scope effort.
