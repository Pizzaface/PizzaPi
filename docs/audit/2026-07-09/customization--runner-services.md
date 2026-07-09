# Audit: customization/runner-services.mdx

Verdict: MAJOR ISSUES
Claims checked: 38 | Failed: 11

## Findings

### [P1] `deliverAs` default is wrong — server defaults to "steer", not "followUp"
- Claim (line ~310, table; line ~325 aside): "`deliverAs` | No | `"steer"` interrupts the current turn; `"followUp"` (default) queues after the turn ends" and "Use `"followUp"` (default) for non-urgent events."
- Reality: The broadcast handler defaults missing `deliverAs` to `"steer"`: `const deliverAs = body.deliverAs ?? "steer";` (packages/server/src/routes/triggers.ts:941). A service that omits the field will interrupt the agent's current turn — the opposite of what the docs imply. The page's own example code sends `deliverAs ?? "followUp"` explicitly, masking the bug for copy-pasters but not for anyone who reads the table.
- Fix: Change the table/aside to state the default is `"steer"`, OR change the server default to `"followUp"` (safer) — the disagreement is a real footgun.

### [P1] `list_trigger_subscriptions()` agent tool does not exist
- Claim (line ~356, Agent Interaction table): "View subscriptions | `list_trigger_subscriptions()`".
- Reality: No such tool is registered. The triggers extension registers only: `list_available_triggers`, `list_available_sigils`, `subscribe_trigger`, `unsubscribe_trigger`, `update_trigger_subscription`, `fire_trigger`, `respond_to_trigger`, `escalate_trigger`, `tell_child` (packages/cli/src/extensions/triggers/extension.ts:204,272,411,503,564,643,712,849,920). `listTriggerSubscriptions` exists only as an internal client function used for auto-cleanup (packages/cli/src/extensions/trigger-client.ts:480, lifecycle-handlers.ts:244,454), never exposed to the agent.
- Fix: Remove the row, or expose a `list_trigger_subscriptions` tool (agents currently cannot inspect their own subscriptions — see Code UX).

### [P1] Documented plugin service folder structure does not match discovery code
- Claim (lines ~70-83, Folder Structure): plugins bundle services as `~/.pizzapi/plugins/my-plugin/plugin.json` + `services/my-service/manifest.json` (nested folder with its own manifest.json).
- Reality: Plugin service discovery never reads a nested `services/<svc>/manifest.json`. `readServiceDeclarations` reads `package.json` → `pizzapi.services` array OR root `manifest.json` → `services` array, where each entry is `{ id?, entry }` pointing at a module file (packages/cli/src/runner/service-loader.ts:430-490). It does not read `plugin.json` for services at all. Tests confirm the real shape: `{ services: [{ id, entry: "./svc.js" }] }` (packages/cli/src/runner/service-loader.test.ts:300-403). The folder-based `manifest.json` + `panel/` layout only applies to `~/.pizzapi/services/` (global-dir) and `.pizzapi/services/` (project-dir), not plugins.
- Fix: Replace the plugin FileTree with the `{id, entry}` array declaration form in package.json/manifest.json, and drop the nested manifest.json.

### [P2] `announceSigilServer` is entirely undocumented — panel-less sigil services silently fail to resolve
- Claim (ServiceHandler API / Quick Reference): the only panel/resolve hook mentioned is `announcePanel(port)`; "Resolve sigils | Implement the `resolve` API route matching each sigil's `resolve` template."
- Reality: A service that defines sigils but has no panel must call `announceSigilServer(port)` so the daemon can stamp a `resolvePort` onto the sigil defs and route tunnel resolve requests (packages/cli/src/runner/service-handler.ts:59-64; packages/cli/src/runner/daemon.ts:599,627,879-901; packages/cli/src/runner/services/time-service.ts:220-265). The page never mentions this API, so a panel-less sigil service following the docs will advertise sigils whose `resolve` endpoint is unreachable. The in-repo SKILL.md also omits it.
- Fix: Add an `announceSigilServer` subsection under ServiceHandler API and show it in the "Services Without Panels" example when sigils are present.

### [P2] Manifest trigger `params` (the core subscription-filtering feature) are not documented on this page
- Claim (Custom Triggers → Declaring Triggers table): trigger fields are `type, label, description, schema` only.
- Reality: `parseTriggers` parses a full `params[]` with `name, label, type (string|number|boolean|json), description, required, default, enum, multiselect` (packages/cli/src/runner/service-loader.ts:350-410). The page's "Trigger Subscription Filters" section even references "params … forwarded to the service" but never explains how to declare them. The SKILL.md documents all of this, so the two docs have drifted.
- Fix: Add a `params` row to the trigger table and a short example (the SKILL.md already has ready-to-copy content).

### [P2] `panel.requires` manifest field is missing from the manifest table
- Claim (manifest.json table): `panel.dir` is the only panel sub-field listed.
- Reality: `ServiceManifest.panel` also has `requires?: string[]` (validated against `PWD, SESSION_ID, HOME, USER, PROJECT_DIR`), resolved by the daemon and passed to the UI as query params (packages/cli/src/runner/service-loader.ts:460,468-474,506-512; packages/cli/src/runner/daemon.ts:671-672). The SKILL.md documents `panel.requires` and `@VARIABLE@` substitution; this page documents neither.
- Fix: Add a `panel.requires` row and a note on variable expansion (`expandVars` is applied to `entry` and `panel.dir`).

### [P2] `RunnerTriggerListener.autoClose` field is missing from the listener fields table
- Claim (RunnerTriggerListener fields table): fields are `listenerId, triggerType, prompt, cwd, model, params, createdAt`.
- Reality: The type also has `autoClose?: boolean` — when true, auto-spawned sessions shut down on successful completion (packages/server/src/sessions/runner-trigger-listener-store.ts:42-51; accepted by the POST/PUT handlers at packages/server/src/routes/runners.ts:598,642). The docs never mention it, so users can't discover the auto-close behavior.
- Fix: Add an `autoClose` row to the table and note it in the POST example.

### [P2] Listener endpoint auth is mischaracterized as "runner authentication (x-api-key)"
- Claim (Runner Trigger Listeners → CRUD API): "All endpoints require runner authentication (`x-api-key` header)."
- Reality: The handlers call `requireSession(req)`, which accepts an interactive browser session (cookie) OR an API key (packages/server/src/routes/runners.ts:566; packages/server/src/middleware.ts:4-15). It is user/session auth, not "runner authentication." `x-api-key` works but is not the only method, and nothing verifies the caller is the runner itself.
- Fix: Reword to "Require user authentication (browser session or `x-api-key` header)."

### [P2] `panel.dir` has no default and is effectively unused for serving
- Claim (manifest table): `panel.dir` default `"./panel"`.
- Reality: `parseServiceManifest` sets `dir` only when explicitly provided — no `"./panel"` default (packages/cli/src/runner/service-loader.ts:470-473). The daemon never reads `panel.dir` to serve files; the service itself serves its panel via `Bun.serve()` + `announcePanel(port)`. `panel` is treated purely as metadata (presence + `requires`). Listing a default is misleading.
- Fix: Drop the default column entry for `panel.dir`, or clarify it is advisory metadata, not a served path.

### [P2] `entry` default is not strictly `"./index.ts"`
- Claim (manifest table): `entry` default `"./index.ts"`.
- Reality: When `entry` is omitted, `findDefaultEntry` returns the first existing of `["index.ts", "index.js", "index.mts", "index.mjs"]` (packages/cli/src/runner/service-loader.ts:519-525). `"./index.ts"` is only used if that file exists; otherwise it falls through to other extensions.
- Fix: State the default as "first existing of index.ts/index.js/index.mts/index.mjs".

### [P3] "No external CDN scripts — the iframe is sandboxed; external scripts may be blocked" is inaccurate
- Claim (Panel Guidelines): sandbox blocks external scripts.
- Reality: The iframe sandbox is `allow-scripts allow-forms allow-same-origin allow-popups` (packages/ui/src/components/service-panels/IframeServicePanel.tsx:82-83). With `allow-scripts` + `allow-same-origin`, external CDN scripts are not blocked by the sandbox. The advice to avoid external deps is fine, but the stated reason is wrong (a CSP would be the blocker, and none is documented here).
- Fix: Reword to "keep panels self-contained; external resources may fail depending on CSP/network" or drop the sandbox justification.

### [P3] 280px iframe height is only true for the bottom dock position
- Claim (Panel Guidelines): "Panels render inside a 280px-tall iframe."
- Reality: `ServicePanelContainer` uses `{ height: "280px" }` only for `position === "bottom"`; for `position === "right"` it uses `{ width: "320px" }` with full height (packages/ui/src/components/service-panels/ServicePanels.tsx:173). The troubleshooting "Large panel doesn't fit | Panel container is 280px tall" is therefore position-dependent.
- Fix: Note the 280px height applies to the bottom dock; side dock is 320px wide.

### [P3] Project-local service discovery (`.pizzapi/services/`) is not mentioned
- Claim (intro / How It Works): "discovered automatically from `~/.pizzapi/services/` on startup."
- Reality: `discoverServices` also scans `<cwd>/.pizzapi/services/` when `cwd` is provided (packages/cli/src/runner/service-loader.ts:580-586,623-635), and plugin dirs. Only the global dir and plugins are documented.
- Fix: Mention project-local `.pizzapi/services/` as an additional discovery source.

### [P3] Sigil `icon` field supported in code but absent from sigil field table
- Claim (sigils.json table / ServiceSigilDef table): fields are `type, label, description, resolve, schema, aliases`.
- Reality: `parseSigils` also parses `icon` (packages/cli/src/runner/service-loader.ts:430-432). It is silently dropped from the docs.
- Fix: Add an `icon` row (optional) or note it is unsupported.

### [P3] `expectsResponse` broadcast body field is undocumented
- Claim (Firing Triggers table): body fields are `type, payload, source, deliverAs, summary`.
- Reality: The server also reads `body.expectsResponse ?? false` and forwards it on the delivered trigger (packages/server/src/routes/triggers.ts:953). Optional, but agents/viewers can act on it.
- Fix: Add an optional `expectsResponse` row, or omit intentionally with a note.

### [P3] Heavy duplication/drift with the in-repo SKILL.md
- The SKILL.md (packages/cli/src/skills/creating-runner-services/SKILL.md) covers the same ServiceHandler material but is strictly more complete: it documents `panel.requires`, `@VARIABLE@` substitution, trigger `params` (incl. `enum`, `multiselect`, `json` type, `Contains` suffix), and the full lifecycle. The docs page omits several of these (see P2 findings) while duplicating the template, quick reference, and troubleshooting tables. The two will keep drifting.
- Fix: Make the docs page the canonical source and have the SKILL reference it, or lift the missing SKILL content into the page.

## Redesign notes
- The page mixes three concerns — manifest authoring, relay HTTP API, and agent tool surface — and re-derives the same fields in a table, a JSON example, and a Quick Reference. Consolidating the manifest schema into one annotated JSON block (with inline comments per field) would eliminate the three-way sync that has already drifted (e.g. `panel.requires`, trigger `params`).
- "How It Works" step 6 says the daemon emits `service_announce` with "panels, trigger defs, and sigil defs" — true, but it omits the `announceSigilServer`/`resolvePort` stamping step, so the sigil-resolution path is invisible. A step 6b for sigil resolve routing would close the gap.
- The trigger-listener and trigger-history sections are well-verified and accurate; consider promoting them out of this already-long page into sub-pages so the authoring sections stay scannable.
- The "Migrating to Split Files" Steps are fine but could note that invalid `triggers.json`/`sigils.json` JSON silently falls back to the manifest arrays (service-loader.ts:492,512) — a real failure mode users will hit.

## Code UX opportunities
- **`deliverAs` default disagreement is a footgun:** the server defaults to `steer` (interruptive) while docs and the example template default to `followUp`. A service author who copies the table but not the example will silently interrupt turns. Fix the server default to `followUp`, or make the broadcast endpoint 400 when `deliverAs` is omitted, forcing an explicit choice.
- **No `list_trigger_subscriptions` agent tool:** agents can subscribe and unsubscribe but cannot inspect active subscriptions, which makes filter tuning a blind loop. Expose the existing `listTriggerSubscriptions` client as a tool (the wiring already exists in trigger-client.ts:480).
- **Silent sigil resolve failure:** a service that declares sigils with `resolve` but forgets `announceSigilServer` (or has no panel) advertises unresolvable sigils. The daemon could warn at announce time when a sigil def has a `resolve` template but no `resolvePort` and no panel port.
- **`panel.dir` is vestigial:** it is parsed and stored but never used for serving, yet the docs treat it as the panel path. Either wire it up (daemon serves the dir, removing the need for every service to roll its own `Bun.serve`+`readFileSync`) or drop the field entirely to reduce boilerplate — the current template is ~40 lines of boilerplate just to serve one HTML file.
- **Plugin service discovery is inconsistent with folder services:** folder services get full manifest.json + split files + `panel.requires` + sigil resolve; plugin services only get `{id, entry}` and lose all manifest metadata (no label, icon, panel, triggers, sigils). Unifying plugin services to also accept a folder-with-manifest would remove a sharp discrepancy the docs already paper over incorrectly.
