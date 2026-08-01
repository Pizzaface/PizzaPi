# Spec: `pi.pizzapi` Package Overlay

**Status:** Proposed — authoritative for epic `DhWdOOgEhNpMpEd2Ohv1y` once merged  
**Schema version:** 1  
**Compatibility baseline:** PizzaPi on `@earendil-works/pi-coding-agent` 0.82.1  
**Godmother idea:** `x1FRkyPU`

This specification defines how one pi package can carry both ordinary pi resources and PizzaPi-only capabilities without patching or forking pi.

Normative terms **MUST**, **MUST NOT**, **SHOULD**, and **MAY** are used as in RFC 2119.

## 1. Objective

A PizzaPi extension is a normal pi package whose `package.json` has:

- pi-native resources under `pi.extensions`, `pi.skills`, `pi.prompts`, and `pi.themes`; and
- optional PizzaPi-only declarations under `pi.pizzapi`.

The same package MUST:

1. install through pi's npm/git/local package machinery;
2. retain its pi-native behavior in vanilla pi;
3. gain runner services, iframe panels, triggers, sigils, agent definitions, rules, and MCP servers in PizzaPi;
4. require an explicit grant before daemon-side code runs; and
5. degrade by omission, not by throwing, when PizzaPi is absent.

The end state is one package format and one install/update path. The overlay is a host extension of pi's package manifest, not a second package manager.

## 2. Verified foundation

This design is grounded in the installed 0.82.1 implementation and official pi documentation:

- Pi packages declare resources in the `pi` object and support npm, git, and local sources. Project entries override user entries for the same package identity. See the official [Pi Packages documentation](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/docs/packages.md).
- Pi extensions run arbitrary TypeScript/JavaScript, may use async factories, and should start long-lived resources at `session_start` and clean them at `session_shutdown`. See the official [Extensions documentation](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/docs/extensions.md).
- `readPiManifest()` in pi 0.82.1 returns the whole `pkg.pi` object. Package consumers enumerate only `extensions`, `skills`, `prompts`, and `themes`; unknown keys are not rejected. Therefore `pi.pizzapi` is inert in vanilla pi.
- Project-local pi packages are loaded only after pi's project-trust decision. `--approve` and `--no-approve` are one-run overrides; they are not PizzaPi daemon grants.
- `pi.events` is the documented shared event bus for communication between extensions.
- PizzaPi's existing `ServiceHandler` registry and `service_announce` protocol already carry panels, triggers, and sigils without caring where a service was discovered.

Local source references for implementation work:

- pi 0.82.1: `dist/core/extensions/loader.js`, `dist/core/package-manager.js`, `docs/packages.md`, `docs/extensions.md`
- PizzaPi: `packages/cli/src/runner/service-handler.ts`, `service-loader.ts`, `daemon.ts`
- PizzaPi: `packages/cli/src/extensions/factories.ts`, `mcp-extension.ts`, `providers/extension.ts`
- Protocol: `packages/protocol/src/shared.ts`

## 3. Non-goals

Version 1 does **not**:

- patch pi's manifest reader or package manager;
- define native React/web-bundle extensions (`componentUrl` remains security-gated and deferred);
- add a `providers` overlay key — model providers use `pi.registerProvider()`, and legacy `ExtensionProvider` implementations migrate to plain `pi.extensions`;
- change `ServiceAnnounceData` or any relay/viewer protocol;
- mount project-local daemon services in the runner-wide service registry;
- make temporary `pi -e` extension sources daemon-discoverable;
- replace the external Claude Code marketplace compatibility reader; or
- promise transactional rollback of an upstream package installation when only its overlay is invalid.

## 4. Package manifest schema

### 4.1 Canonical TypeScript shape

The public contract belongs in the future `@pizzapi/extension-sdk` package.

```ts
export interface PizzaPiOverlayV1 {
  schemaVersion: 1;
  services?: PizzaPiServiceDeclaration[];
  agents?: string[];
  rules?: string[];
  mcp?: string;
}

export interface PizzaPiServiceDeclaration {
  id: string;
  label: string;
  entry: string;
  icon?: string;
  panel?: {
    dir: string;
    requires?: PanelVariable[];
  };
  triggers?: string | ServiceTriggerDef[];
  sigils?: string | ServiceSigilDef[];
}

export type PanelVariable =
  | "PWD"
  | "SESSION_ID"
  | "HOME"
  | "USER"
  | "PROJECT_DIR";
```

`ServiceTriggerDef` and `ServiceSigilDef` are the existing protocol declarations. They are re-exported by `@pizzapi/extension-sdk`; the wire types do not move or fork.

No other top-level version-1 keys are valid. In particular, `providers` and `webui` are not version-1 keys.

### 4.2 Complete example

```jsonc
{
  "name": "@acme/pi-github",
  "version": "1.2.0",
  "keywords": ["pi-package"],
  "dependencies": {
    "@pizzapi/extension-sdk": "^1.0.0"
  },
  "peerDependencies": {
    "@earendil-works/pi-coding-agent": "*"
  },
  "pi": {
    "extensions": ["./src/extension.ts"],
    "skills": ["./skills"],
    "prompts": ["./prompts"],
    "pizzapi": {
      "schemaVersion": 1,
      "services": [
        {
          "id": "github",
          "label": "GitHub",
          "icon": "github",
          "entry": "./src/service.ts",
          "panel": {
            "dir": "./panel",
            "requires": ["PROJECT_DIR", "SESSION_ID"]
          },
          "triggers": "./triggers.json",
          "sigils": "./sigils.json"
        }
      ],
      "agents": ["./agents"],
      "rules": ["./rules"],
      "mcp": "./.mcp.json"
    }
  }
}
```

The package's normal pi resources work in vanilla pi. Vanilla pi ignores `pizzapi` because it does not consume that key.

### 4.3 Overlay field semantics

#### `schemaVersion`

- Required and exactly `1` for this schema.
- A loader that sees a newer version MUST warn and skip the whole overlay.
- A loader MUST NOT guess at newer-version semantics.

#### `services`

Each declaration describes one daemon-side `ServiceHandler` plus optional announce metadata.

- `id`, `label`, and `entry` are required.
- `id` MUST match `^[a-z][a-z0-9-]{0,63}$`.
- `entry` MUST resolve to a `.ts`, `.js`, `.mts`, or `.mjs` file inside the package root.
- The loaded handler's `id` MUST equal the declaration's `id`; a mismatch is invalid rather than silently wrapped.
- `icon` defaults to `"square"`.
- `panel.dir` is required when `panel` exists and MUST resolve to a directory inside the package root.
- `panel.requires` accepts only the five existing `PanelVariable` values.
- `triggers` and `sigils` MAY be inline arrays or one explicit JSON path. A service does not implicitly scan `triggers.json` or `sigils.json`.
- Trigger and sigil definitions retain their current protocol shapes.
- Service IDs MUST be unique within a package.

A service with triggers or sigils but no `panel` is valid. It may call `announceSigilServer()` and remains absent from the panel grid, matching today's panel-less service behavior.

#### `agents`

Pi 0.82.1 has no native `pi.agents` package resource, while PizzaPi's subagent runtime consumes Markdown agent definitions. Agents therefore belong in the overlay.

- Each entry is an explicit package-relative Markdown file or directory.
- Directories are traversed for agent-definition `.md` files using PizzaPi's existing agent parser.
- User-package agents mount as `user` scope through the existing `extraUserDirs` input.
- Project-package agents mount as `project` scope through a new required `extraProjectDirs` input. They MUST NOT be reachable through the subagent tool's default `agentScope: "user"`.
- Project-package agents inherit the existing `confirmProjectAgents` gate unchanged. Pi project-package approval does not bypass that second confirmation.
- Project-package definitions override user-package definitions with the same agent name only when `agentScope: "both"` is selected; stable settings order breaks ties within one scope, with later duplicates warned and skipped.
- Agent definitions do not require a daemon-service grant.
- Version 1 has no separate agent toggle; remove the package to remove its agents.

#### `rules`

- Each entry is an explicit package-relative Markdown file or directory.
- Directories are traversed recursively for `.md` files only.
- Rules are mounted by PizzaPi's session-side rules extension and injected through `before_agent_start`.
- User-package rules are injected before project-package rules; settings order is preserved within each scope.
- Rules do not load in vanilla pi because vanilla pi ignores the overlay.
- Version 1 has no separate rules toggle. Removing the package disables them; a later schema may add filtering if a demonstrated need appears.

#### `mcp`

- One explicit package-relative JSON path.
- The file uses PizzaPi's existing preferred `mcp.servers` array or compatibility `mcpServers` object format.
- One file can declare multiple servers; an array of config paths is unnecessary in version 1.
- Explicit user/project PizzaPi config wins a server-name collision over package MCP config.
- Between packages, project scope wins user scope, then settings order wins; later duplicates are warned and skipped.
- Existing `disabledMcpServers` behavior applies by server name.

A package extension already has arbitrary session-process execution rights. Package agents, MCP, and rules therefore remain session-side capabilities and do not require the separate daemon-service grant described below; agent scope/confirmation rules still apply.

## 5. Validation and path safety

### 5.1 Strict author/install validation

The overlay schema is closed:

- unknown version-1 keys are errors;
- wrong types, missing required fields, duplicate IDs, and invalid sidecar definitions are errors;
- absolute paths and paths containing `..` segments are errors;
- after filesystem resolution, every declared file/directory MUST remain inside the package root;
- symlinks that resolve outside the package root are rejected; and
- overlay sidecar files use the existing 2 MiB per-file cap.

`pizza install` and author-facing validation MUST report all overlay errors together and exit non-zero. The upstream pi-native package may remain installed because upstream installation is not transactional; the invalid overlay receives no grant and MUST NOT mount. The command output MUST state this partial outcome and show `pizza remove <source>` as remediation.

### 5.2 Resilient runtime validation

Daemon/session startup MUST NOT crash because one package has a malformed overlay.

At runtime PizzaPi:

1. validates the whole overlay;
2. logs one provenance-rich warning per package;
3. skips the whole invalid overlay; and
4. continues loading that package's valid pi-native resources through pi.

Runtime does not partially mount an invalid overlay. This avoids surprising half-services and keeps install-time and runtime meaning aligned.

## 6. Package resolution and scope

### 6.1 Configured packages only

PizzaPi MUST inspect only packages configured through pi settings/package commands. It MUST NOT crawl every directory under `.pizzapi/npm` or `.pizzapi/git` looking for manifests.

Observable resolution MUST match pi 0.82.1:

- sources are npm, git, or local package directories;
- npm identity is `npm:<package-name>` without version;
- git identity is normalized `git:<host>/<path>` without ref;
- local identity is `local:<canonical-absolute-path>`;
- project entries override user entries for the same identity;
- a project `autoload:false` entry remains a delta over its user package rather than a second package instance; and
- explicit package order is stable.

Implementation SHOULD reuse upstream settings and package-manager APIs. If an upstream API does not expose the required package roots, PizzaPi MAY implement a small resolver, but characterization tests MUST pin the rules above. It MUST NOT add a pi patch.

Daemon-side resolution MUST pass a non-interactive `onMissing` callback to pi's package manager. A configured-but-missing source is skipped with one provenance-rich warning; the daemon MUST NOT install packages or prompt.

Version-1 overlay mounting is independent of pi's native resource filters (`extensions`, `skills`, `prompts`, and `themes`, including `!pattern`, `+path`, and `-path`). Filtering every native extension does not disable a package's overlay. Overlay services use grants and `disabledRunnerServices`; MCP uses `disabledMcpServers`; agents/rules remain enabled while the package is configured.

### 6.2 User scope

User-configured packages are eligible for every overlay capability. Their daemon services still require a separate grant. Daemon service resolution reads user package entries only; a project entry for the same package identity does not replace or suppress an already configured runner-global service.

### 6.3 Project scope

Project-configured packages:

- require pi project trust before any pi-native or session-side overlay resource loads;
- may contribute rules and MCP after that trust decision; and
- do **not** mount daemon services in schema version 1.

The runner daemon has one global `ServiceRegistry` across many workspaces, while project packages are cwd-scoped. Mounting project code globally would erase that scope and leak project behavior into unrelated sessions. A project package that declares services is installed normally, but PizzaPi warns that those services are inactive in version 1.

Supporting project-scoped daemon services requires a separate design with scoped registry instances, canonical project ownership, and lifecycle isolation. A global grant is not an acceptable shortcut.

### 6.4 Temporary sources

`pi -e` and other temporary extension sources are session-only. They do not appear in package settings and MUST NOT mount daemon overlay capabilities.

## 7. Trust model

### 7.1 Two distinct decisions

Pi project trust and PizzaPi daemon-service trust solve different problems and MUST remain separate.

| Capability | Gate |
|---|---|
| Pi extensions/skills/prompts/themes | pi package + project trust |
| User-package overlay agents | pi package trust; mounted as agent scope `user` |
| Project-package overlay agents | pi project trust + existing `confirmProjectAgents`; mounted as scope `project` |
| Overlay rules/MCP | same pi package + project trust |
| Overlay runner services | explicit PizzaPi service grant |
| Legacy local plugins/providers | existing legacy gates during migration |

`--approve`/`--no-approve` controls pi project trust only. It MUST NOT grant daemon service execution.

### 7.2 Persistent service grants

PizzaPi stores grants in global `~/.pizzapi/config.json`:

```ts
interface OverlayServiceGrant {
  package: string;      // normalized package identity
  services: string[];  // exact granted service ids
}

interface PizzaPiConfig {
  overlayServiceGrants?: OverlayServiceGrant[];
}
```

Rules:

- Grants are keyed by normalized package identity, not a mutable install path or display name.
- A grant covers only listed service IDs. A package update that adds a service does not auto-grant it.
- Updating code for an already-granted service ID retains the grant; package updates already carry the source-level trust risk of arbitrary pi extension code.
- At daemon start/reconciliation, grants whose normalized identity is absent from resolved user packages are removed. This is authoritative even when bare `pi remove` bypasses PizzaPi's wrapper.
- Moving or re-cloning a local package changes its `local:<canonical-absolute-path>` identity and intentionally requires a fresh grant. Reconciliation logs removal of the stale identity; `pizza list` shows the new identity as `untrusted`.
- Existing `disabledRunnerServices` remains an operational on/off switch after trust. Trust answers "may run"; disablement answers "should run now."
- `trustedPlugins` remains a legacy plugin-path allowlist and MUST NOT be repurposed.

### 7.3 Install and config UX

PizzaPi's package command remains an upstream wrapper. It pre-parses and strips `--allow-daemon-services` / `--no-allow-daemon-services` before calling upstream `handlePackageCommand()` (as the wrapper already does for `--cwd`), then diffs global package settings after install/update to resolve newly added identities and validate/apply grants. Overlay flags MUST NOT reach upstream's argument parser.

Bare `pi install` and `pi update` remain valid. They bypass grant UX, so the daemon's fail-closed loader leaves newly declared services `untrusted`; `pizza list` exposes that state. Orphan-grant cleanup happens during daemon reconciliation rather than depending on a `pizza remove` hook.

For a user-scoped package declaring services:

- interactive `pizza install` displays package identity plus service IDs/labels and asks for an explicit grant;
- `--allow-daemon-services` grants the currently declared IDs;
- `--no-allow-daemon-services` installs the package but leaves services inactive;
- non-interactive installation without either explicit flag installs the pi/session surface, leaves services inactive, and exits successfully with a warning;
- `pizza list` shows overlay capabilities and each service's `granted`, `disabled`, or `untrusted` state; and
- `pizza config` can add/revoke service grants without reinstalling.

Grant changes SHOULD trigger service reconciliation in a running daemon through the existing runner-control path. If no daemon is running, they apply at next daemon start. The implementation MUST NOT invent a second updater.

## 8. Collision and precedence rules

Service identity is global inside one runner daemon.

Precedence, highest first:

1. built-in service IDs (`terminal`, `file-explorer`, `git`, `memory`, `process`, `time`, `tunnel`) are reserved and cannot be overridden;
2. trusted user-scoped package services;
3. legacy global/project service directories and legacy plugin-manifest services during migration.

Consequences:

- The daemon MUST export one `BUILTIN_SERVICE_IDS` set derived from the same registrations that create built-in services; loaders and tests MUST NOT maintain an independent literal list. A characterization test asserts every built-in service constructor registered by `daemon.ts` is represented.
- Before any package registration, the loader MUST call `registry.has(id)` and skip with a provenance-rich warning. It MUST NOT rely on `ServiceRegistry.register()` throwing for duplicates.
- Package overlay discovery and registration MUST be awaited before legacy `discoverServices()` registration. The legacy registration loop MUST also check `registry.has(id)` and skip duplicates, making package-over-legacy precedence deterministic rather than dependent on async completion order.
- Package-origin services intentionally win legacy collisions so migration can install the new package before deleting the old copy.
- Among distinct configured packages with the same service ID, the first package in stable settings resolution order wins; later services are skipped with both package identities in the warning.
- Duplicate service IDs inside one package invalidate that overlay.
- The same normalized package identity is deduplicated using pi's project-over-user rules before collision handling.
- Trigger and sigil definitions are emitted only for the winning, active service.

Built-ins remain reserved even if disabled; disabling a built-in MUST NOT let a package impersonate its ID.

## 9. Runtime mounting

### 9.1 Session-side resources

Pi continues to mount `pi.extensions`, `skills`, `prompts`, and `themes` itself.

Built-in PizzaPi overlay extensions mount package agents, rules, and MCP declarations after upstream package resolution and trust. They MUST use the same package provenance/scope ordering described above.

Legacy `ExtensionProvider` capabilities migrate as follows:

| Legacy capability | Pi/overlay replacement |
|---|---|
| `context` | `before_agent_start` |
| `lifecycle` | `session_start`, `turn_end`, `session_shutdown` |
| `metadata` | ordinary extension events or a declared service |
| `ui-panel` | `pi.pizzapi.services[].panel` |
| custom model provider | `pi.registerProvider()` |

There is no version-1 `pi.pizzapi.providers` key.

Legacy Claude-style plugin resources migrate as follows:

| Legacy structural resource | Package replacement |
|---|---|
| `skills/` | `pi.skills` |
| simple `commands/*.md` | `pi.prompts` |
| commands needing runtime logic | `pi.extensions` + `registerCommand()` |
| `hooks/` | `pi.extensions` lifecycle/tool/input events |
| `agents/` | `pi.pizzapi.agents` |
| `rules/` | `pi.pizzapi.rules` |
| `.mcp.json` | `pi.pizzapi.mcp` |
| arbitrary scripts/templates | ordinary package files referenced by the resources above |

### 9.2 Runner services

For every trusted, valid, user-scoped service declaration the daemon:

1. resolves and validates its package-confined paths;
2. loads the existing `ServiceHandler` object/class/factory contract;
3. requires the runtime handler ID to match the declaration;
4. registers through the existing `ServiceRegistry`;
5. passes the existing `ServiceInitOptions` callbacks;
6. records package identity and scope as provenance; and
7. uses the current `service_announce` path for panels/triggers/sigils.

`ServiceHandler`, `ServiceInitOptions`, `ServiceEnvelope`, and protocol declaration types move to/re-export from `@pizzapi/extension-sdk`; the CLI imports one canonical definition.

Service factories MUST NOT run until the daemon grant check passes. Reading and validating declarative JSON is allowed before the grant; importing the service entry is not.

### 9.3 Host detection for graceful degradation

Environment variables and settings keys are rejected as the public detection API. The version-1 SDK uses pi's documented shared event bus.

Pi 0.82.1 loads configured package extensions before PizzaPi's inline host factories. A package therefore cannot assume a host probe will succeed during its factory. The SDK exposes both an immediate probe and a ready subscription:

```ts
export interface PizzaPiHostInfo {
  apiVersion: 1;
  capabilities: readonly string[];
}

export function isPizzaPiHostInfo(value: unknown): value is PizzaPiHostInfo {
  if (!value || typeof value !== "object") return false;
  const host = value as Record<string, unknown>;
  return (
    host.apiVersion === 1 &&
    Array.isArray(host.capabilities) &&
    host.capabilities.every((item) => typeof item === "string")
  );
}

export function detectPizzaPiHost(pi: ExtensionAPI): PizzaPiHostInfo | undefined {
  let host: PizzaPiHostInfo | undefined;
  pi.events.emit("pizzapi:host:probe", {
    respond(value: unknown) {
      if (!host && isPizzaPiHostInfo(value)) host = value;
    },
  });
  return host;
}

export function onPizzaPiHost(
  pi: ExtensionAPI,
  callback: (host: PizzaPiHostInfo) => void,
): () => void {
  let delivered = false;
  const deliver = (host: PizzaPiHostInfo) => {
    if (delivered) return;
    delivered = true;
    callback(host);
  };
  const unsubscribe = pi.events.on("pizzapi:host:ready", (data: unknown) => {
    if (isPizzaPiHostInfo(data)) deliver(data);
  });
  const current = detectPizzaPiHost(pi);
  if (current) deliver(current);
  return unsubscribe;
}
```

The built-in host factory registers the synchronous `pizzapi:host:probe` listener, then emits `pizzapi:host:ready` with a validated `PizzaPiHostInfo` payload. Package extensions that need host information during setup register `onPizzaPiHost()` in their factory; extensions that only need it during events may call `detectPizzaPiHost()` at `session_start` or later. Vanilla pi has no listener and never emits ready.

The host's probe/ready handlers MUST be synchronous. Pi's event bus invokes listeners through an async safety wrapper, so deferred/asynchronous responses would arrive after `detectPizzaPiHost()` returns.

This handshake is capability discovery, not a security boundary: another extension can emit or respond on the shared bus. Security decisions remain in host-owned loaders and grants.

Host absence is a supported outcome, not an error. Package extensions MAY omit PizzaPi-only behavior when no callback arrives or the probe returns `undefined`, but MUST keep their ordinary pi behavior working.

## 10. Graceful degradation contract

### 10.1 PizzaPi package in vanilla pi

Acceptance requires:

- pi-native extensions, skills, prompts, and themes load normally;
- `pi.pizzapi` produces no parse/load error;
- PizzaPi-only agents, rules, MCP, daemon processes, and panels are absent;
- `detectPizzaPiHost()` returns `undefined`; and
- the package extension does not throw because the host is absent.

A package that requires PizzaPi for all meaningful behavior should still load a no-op extension or expose a clear command message; it MUST NOT crash startup.

### 10.2 Vanilla pi package in PizzaPi

A package without `pi.pizzapi` follows upstream behavior unchanged. PizzaPi MUST NOT require an overlay or add a second trust prompt.

## 11. Error behavior

| Situation | Install/config behavior | Runtime behavior |
|---|---|---|
| Invalid overlay schema | non-zero, all errors shown; no grant | warn once, skip overlay |
| Unsupported schema version | non-zero for overlay validation | warn, skip overlay |
| Untrusted service | offer explicit grant | do not import; announce unavailable state through list/config, not service_announce |
| Project package declares service | explain v1 limitation | skip daemon service; session surface remains |
| Entry/sidecar escapes root | reject | warn, skip overlay |
| Handler ID mismatch | reject when testable | warn, skip service/overlay |
| Duplicate built-in ID | reject | built-in wins; package service skipped |
| Service init failure | install unaffected | existing daemon isolation/logging applies |
| Invalid agent/MCP/rules path | reject overlay | skip overlay; pi-native surface remains |

Warnings MUST include package identity, source scope, field/path, and remediation. Secrets from MCP environment/config MUST NOT be logged.

## 12. Deprecation and migration

### 12.1 Permanent compatibility

Read-only consumption of the external Claude Code marketplace may remain. It is an interoperability adapter, not PizzaPi's authoring/install system. It does not gain daemon service trust implicitly.

### 12.2 Stage 0 — coexistence

- Add overlay loading and service grants.
- Package origin wins legacy service collisions.
- Keep legacy service/provider/plugin paths functional.
- Migrate Godmother, then Nightshift.

### 12.3 Stage 1 — one release of warnings

Warn with a migration link when loading:

- `~/.pizzapi/services` and project `.pizzapi/services`;
- `~/.pizzapi/providers` and project providers;
- PizzaPi-local structural plugin directories / `plugin.json` authoring paths; and
- sidecar `manifest.json` service packages outside pi package settings.

Warnings identify the exact source and equivalent `pi.pizzapi` declaration. No user files are deleted.

### 12.4 Stage 2 — removal

After both reference migrations have shipped for one release:

- remove legacy service-directory discovery;
- remove legacy provider discovery and `ProviderBridge` compatibility loading;
- remove PizzaPi-local plugin structural discovery that duplicates pi packages;
- retain only the explicitly documented Claude marketplace adapter; and
- keep config readers long enough to produce a targeted obsolete-config warning.

The removal should be net-negative in `packages/cli` LOC.

## 13. Implementation workstreams

The authoritative dependency order is:

```text
x1FRkyPU (this spec)
├─ 9MXcCYqK  extension-sdk
│  └─ HJrG9dOI  daemon package-service discovery
│     └─ nIMOA8cm  UI end-to-end verification
├─ 0wtzqMu7  session-side convergence
└─ zp7LjCjl  install/list/config + daemon grants

HJrG9dOI + 0wtzqMu7 + zp7LjCjl
└─ jeyDrtSQ  migrate Godmother
   └─ Sb4SYOUS  migrate Nightshift

jeyDrtSQ + Sb4SYOUS
└─ Felva9lO  deprecate/remove legacy paths
```

The SDK, session-side convergence, and install/trust workstreams MAY proceed in parallel after this spec. Daemon discovery waits for the SDK contract. UI verification waits for daemon discovery. Reference migrations wait for all three loading surfaces.

`0wtzqMu7` MUST add `extraProjectDirs` to `discoverAgents()` alongside existing `extraUserDirs`, preserving `agentScope` partitioning and `confirmProjectAgents`. `HJrG9dOI` owns awaited package-before-legacy service registration and the shared built-in ID set. `zp7LjCjl` owns flag stripping, settings diffing, fail-closed bare-pi behavior, and orphan-grant reconciliation.

## 14. Project structure and commands

Expected implementation locations:

```text
docs/specs/pi-pizzapi-overlay.md        authoritative design
packages/extension-sdk/                 public overlay/service contract
packages/cli/src/runner/                daemon discovery and mounting
packages/cli/src/extensions/            session agents/rules/MCP/host probe
packages/cli/src/extensions/subagent-agents.ts  add scope-preserving extraProjectDirs
packages/cli/src/package-commands.ts     install/list/config trust UX
packages/protocol/src/                   unchanged wire declarations
packages/ui/src/                         verification/small provenance fixes only
```

Required commands for implementation PRs:

```bash
bun install
bun run typecheck
bun test packages/cli/src/runner
bun test packages/cli/src/extensions
bun test packages/cli/src/package-commands.test.ts
bun test packages/protocol/src
```

Reference migrations additionally run their plugin-specific tests and a vanilla-pi local-package acceptance test.

## 15. Testing strategy

### Schema/parser

- valid complete and minimal fixtures;
- unknown version/key/type failures;
- duplicate IDs;
- absolute, traversal, and escaping-symlink paths;
- inline and sidecar trigger/sigil definitions;
- agent/rule file and directory declarations;
- size limits and provenance-rich errors.

### Package resolution

- npm/git/local identities;
- project-over-user dedup and `autoload:false` delta behavior;
- stable settings order;
- configured-only discovery (orphan install directories ignored);
- temporary sources excluded from daemon discovery;
- configured-but-missing sources warn and skip through non-interactive `onMissing`;
- pi native-resource filters do not disable overlay resources.

### Trust

- service module is never imported before grant;
- grants cover exact service IDs;
- added IDs after update remain untrusted;
- revoke/removal disposes and unregisters services;
- `--approve` never grants daemon services;
- project packages never mount daemon services in v1;
- project-package agents are absent from default `agentScope: "user"` and still trigger `confirmProjectAgents`.

### Runtime

- every built-in daemon registration is represented by `BUILTIN_SERVICE_IDS`;
- built-ins cannot be overridden, even when disabled, and duplicates warn instead of throwing;
- awaited package registration wins a legacy collision before legacy discovery registers;
- duplicate package service produces one clear warning;
- init/dispose/reconciliation preserve existing lifecycle behavior;
- panel, trigger, sigil, and sigil-server metadata reaches unchanged `service_announce` types;
- malformed package overlay does not block pi-native resources from the same package.

### Graceful degradation

Use one local fixture package in both hosts:

1. `pi install ./fixture` in vanilla pi; verify native extension/skill/prompt loads, overlay is inert, host probe is absent, and startup succeeds.
2. Pin a characterization test proving pi's current event bus invokes synchronous handlers before `emit()` returns.
3. `pizza install ./fixture --allow-daemon-services`; verify native resources plus service/agents/rules/MCP mount.
4. Remove the grant; verify only daemon services stop while session resources still work.

### UI

Using the sandbox UI skill, verify a package-origin service announces an iframe panel, trigger definition, and sigil; viewer reconnect restores the same definitions from relay persistence.

## 16. Boundaries

### Always

- Reuse pi package settings/install/update behavior.
- Validate before importing daemon code.
- Preserve package provenance in errors and runtime metadata.
- Keep the relay/viewer wire protocol unchanged.
- Add one runnable regression for every new branch/parser/race.
- Use Bun for repository commands.

### Ask first

- Any wire-protocol change.
- Any pi patch or fork.
- Support for project-scoped daemon services.
- Native React/web-bundle extension loading.
- A schema-version bump.

### Never

- Treat `--approve` as a daemon grant.
- Scan arbitrary installed directories instead of configured packages.
- Import an untrusted service entry.
- Let a package override a built-in service ID.
- Put overlay keys outside `pi.pizzapi`.
- Put overlay data in theme JSON.
- Make vanilla pi host absence an error.

## 17. Success criteria

The spec is satisfied when:

- a single configured package provides pi-native resources and a trusted runner service with panel/triggers/sigils;
- the same package runs its native surface in vanilla pi without error;
- a vanilla pi package runs unchanged in PizzaPi;
- daemon code is never imported without an explicit per-service grant;
- package resolution matches pi identity, scope, and dedup behavior;
- project-local daemon services are explicitly skipped rather than globally leaked;
- Godmother and Nightshift run from overlay packages;
- the permanent Claude marketplace adapter is clearly separated from deprecated PizzaPi-local plugin authoring;
- legacy loading paths receive one release of warnings and are then removed; and
- PizzaPi's extensibility code ends smaller than before convergence.

## 18. Resolved design questions

| Question | Decision |
|---|---|
| Host detection | synchronous `pi.events` probe via `@pizzapi/extension-sdk`; not env/settings |
| Provider declaration | no overlay key; plain pi extensions and `pi.registerProvider()` |
| Agent definitions | `pi.pizzapi.agents`; pi 0.82.1 has no native `pi.agents` resource |
| Native web UI | excluded from v1; iframe panels only |
| Claude marketplace | retain as explicit read-only compatibility adapter |
| Validation | strict/non-zero in author/install flow; warn-and-skip whole overlay at runtime |
| Service collisions | built-ins reserved; package origin beats legacy; stable first package wins |
| Project daemon services | unsupported in v1; session surface still loads after project trust |
| Service trust | separate global per-package/per-service grants |
| Compat shim | one release after Godmother and Nightshift migrations, then removal |
| MCP shape | one explicit config path containing one or more servers |
