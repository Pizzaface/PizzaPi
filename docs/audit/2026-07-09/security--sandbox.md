# Audit: security/sandbox.mdx
Verdict: MAJOR ISSUES
Claims checked: 34 | Failed: 11

## Findings

### [P0] sandbox:violation events are NOT forwarded to the relay/web UI in real time
- Claim (line 214): "In sessions connected to the PizzaPi relay, violations are forwarded as `sandbox:violation` events visible in the web UI."
- Claim (line 298): "every `sandbox:violation` event is forwarded in real time."
- Reality: The worker emits `pi.events?.emit?.("sandbox:violation", ...)` (`packages/cli/src/extensions/sandbox-events.ts:22`), but the remote extension only forwards a fixed allow-list of pi events to the relay (`packages/cli/src/extensions/remote/lifecycle-handlers.ts:349-689` — `goal:state_changed`, `plugin:*`, `mcp:auth_*`, `mcp:registry_updated`, `mcp:startup_report`, plus `pi.on(...)` lifecycle events). There is NO `pi.events.on("sandbox:violation", ...)` forwarder anywhere in the repo (grep for `sandbox:violation` matches only the emitter and this doc). The server has no `sandbox:violation` handler either (`grep violation packages/server/src` → only the two REST routes). This is an overstated security-monitoring guarantee — users are told they can observe sandbox violations live in the browser when they cannot.
- Fix: Either wire a `pi.events.on("sandbox:violation", rctx.forwardEvent)` forwarder + server relay + UI consumer, or remove the "forwarded in real time / visible in the web UI" claims and state violations are only visible via the in-session `/sandbox` slash command.

### [P1] GET /sandbox-status `violations` and `recentViolations` always return 0 / empty
- Claim (lines 248-249, 285-286): `violations` = "Total violation count since runner start"; `recentViolations` = "Last 20 violations (newest first)."
- Reality: The REST route calls `sendRunnerCommand(runnerId, { type: "sandbox_get_status" })` (`packages/server/src/routes/runners.ts:1089`), which is handled by the **daemon** socket handler. The daemon hard-codes `violations: 0, recentViolations: []` (`packages/cli/src/runner/daemon.ts:1700-1702`) because the daemon process does not run inside a sandbox. Only the **worker's** remote-exec-handler returns real violations (`packages/cli/src/extensions/remote-exec-handler.ts:542-557`), but that path is not reachable via the REST endpoint. The UI's `/sandbox` command consumes this endpoint (`packages/ui/src/components/session-viewer/slash-commands.ts:610-618`), so the web UI always shows 0 violations.
- Fix: Route the REST status call to an active worker (or have the daemon aggregate worker violations), or correct the docs to state these fields are always 0/empty for the REST endpoint and that real violations are only available via the in-session `/sandbox` slash command.

### [P1] GET /sandbox-status `active` does not reflect actual enforcement
- Claim (line 280): "`active` — Whether enforcement is actually running (may be `false` on unsupported platforms)."
- Reality: The daemon returns `active: configured` where `configured = mode !== "none"` (`packages/cli/src/runner/daemon.ts:1693-1697`). It is `true` for any non-`none` mode regardless of platform support or init failure. The daemon comment explicitly says it "can't know if a worker sandbox is actively enforcing right now — report that a non-`none` mode is *configured*, not that enforcement is proven active." On an unsupported platform the worker logs "Platform not supported for sandboxing" and continues unsandboxed (`packages/tools/src/sandbox.ts:124-128`), but `active` would still be `true`.
- Fix: Rename the field semantics to "configured" (the daemon already returns both `active` and `configured` with the same value), or document `active` as "a non-`none` mode is configured" rather than "enforcement is actually running."

### [P1] Web UI violation badges / live counter / filterable log / click-to-expand are not implemented
- Claim (lines 300-304): "Violations appear as **warning badges** in the session timeline. The **runner detail panel** shows a live violation counter and a filterable violation log. Clicking a violation expands it to show the full operation, target path, and denial reason."
- Reality: No such UI exists. `grep` for "badge"/"filterable"/"timeline.*violation" in `packages/ui/src` finds nothing. The only violation rendering is `ViolationFeed` in `packages/ui/src/components/SandboxManager.tsx:180` and `CommandResultCard.tsx:697`, both fed by the `sandbox-status` REST response whose `recentViolations` is always `[]` (see P1 above). There is no real-time feed because events are not forwarded (see P0).
- Fix: Remove the unimplemented UI claims, or implement the forwarding + UI and keep the claims.

### [P2] GET /sandbox-status `config` is global-only, not "global + project merged"
- Claim (line 287): "`config` — Fully resolved sandbox config (global + project merged)."
- Reality: The daemon deliberately overrides the resolved config to use **global-only** sandbox settings to avoid leaking project-local overrides into the status response (`packages/cli/src/runner/daemon.ts:1682-1685`: `globalOnlyConfig.sandbox = globalCfg.sandbox ?? {}`). The merge semantics described elsewhere in the page do not apply to this endpoint's `config` field.
- Fix: Document `config` as "fully resolved **global** sandbox config (project-local overrides excluded)."

### [P2] PUT /sandbox-config "send null to remove a key" does not delete on the documented REST endpoint
- Claim (line 270): "Send `null` for a key to remove it from the config (e.g., clearing stale network rules when downgrading from `full` to `basic`)."
- Reality: The REST PUT routes to the daemon's `sandbox_update_config` handler (`packages/cli/src/runner/daemon.ts:1715-1747`). Its merge loop sets `merged[key] = value` for `null` (the `value && typeof value === "object"` guard is falsy for null), so the key is written as `null` in `~/.pizzapi/config.json`, not deleted. Only the **worker's** remote-exec-handler deletes on null (`packages/cli/src/extensions/remote-exec-handler.ts:583-586`), and that path is not used by the REST endpoint. Functionally a `null` network block is treated as undefined by `sanitizeSandboxConfig`, but the JSON key is retained.
- Fix: Either make the daemon handler delete-on-null to match the worker handler, or clarify that `null` clears the effective value but leaves a `null` entry in the JSON file.

### [P2] `--sandbox` flag values shown in docs (none/basic/full) disagree with CLI help text (enforce/audit/off)
- Claim (lines 33-35): `pizza --sandbox full`, `pizza --sandbox basic`, `pizza --sandbox none`.
- Reality: `--sandbox full|basic|none` all work because `SANDBOX_MODE_ALIASES` includes identity mappings for the canonical names (`packages/cli/src/config/types.ts:138-145`). However, `pizza --help` advertises only the aliases: `"Set sandbox mode: enforce, audit, or off"` (`packages/cli/src/index.ts:347`). A user reading `--help` will not know `full/basic/none` are accepted, and the docs never mention `enforce/audit/off`.
- Fix: Update the help string in `index.ts:347` to `none, basic, or full` (and optionally mention aliases), and/or document the `enforce/audit/off` aliases on this page.

### [P2] Intro overstates that sandboxing wraps "MCP server interactions"
- Claim (line 5): "PizzaPi can enforce OS-level sandboxing around every tool call the agent makes — bash commands, file reads/writes, and MCP server interactions."
- Reality: The OS sandbox wraps bash commands and file read/write validation (`packages/tools/src/sandbox.ts` `wrapCommand`/`validatePath`). For MCP, only the server URL domain is checked against the sandbox network policy at registration (`packages/cli/src/extensions/mcp/registry.ts:97-143`); the MCP server process itself is spawned unsandboxed and is not wrapped by `sandbox-exec`/`bubblewrap`. "Around every tool call ... MCP server interactions" implies MCP tool execution is OS-sandboxed, which it is not.
- Fix: Rephrase to "bash commands, file reads/writes, and MCP server network access (domain-filtered)."

### [P3] Slow-startup warning example omits the "Disable this warning" line the code emits
- Claim (lines 522-530): example output ends with `Tip: Use --safe-mode or --no-mcp for instant startup.`
- Reality: The formatter also appends `"Disable this warning: set slowStartupWarning: false in config."` (`packages/cli/src/extensions/mcp-extension.ts:976`).
- Fix: Add the final line to the example, or note it is truncated.

### [P3] REST response shapes omit `ok` and `rawConfig` fields actually returned
- Claim (lines 254-263, 268-272): GET/PUT response examples list only `mode/active/platform/violations/recentViolations/config` and `saved/resolvedConfig/message`.
- Reality: Both daemon handlers return an additional `ok: true` (`packages/cli/src/runner/daemon.ts:1699, 1744`), and the GET handler also returns `configured` and `rawConfig` (`daemon.ts:1703-1706`). The server passes these through verbatim (`runners.ts:1096, 1141`).
- Fix: Either document `ok`, `configured`, and `rawConfig`, or filter them at the server boundary so the wire response matches the docs.

### [P3] "Safe Mode & Startup Diagnostics" section is off-topic and duplicated
- Claim (lines 444-547): a large safe-mode / startup-diagnostics section.
- Reality: Safe mode is unrelated to OS-level sandboxing; the same `--safe-mode`/`--no-*` flags, `PIZZAPI_NO_*` env vars, `mcpTimeout` (default 30000) and `slowStartupWarning` (default true, 5s threshold) are documented in `running/cli-reference.mdx:38-82`, `customization/configuration.mdx:75-136`, and `customization/mcp-servers.mdx:195-217`. The 5-second threshold is correct (`SLOW_STARTUP_THRESHOLD_MS = 5_000`, `mcp-extension.ts:590`) and the 30s MCP timeout is correct (`DEFAULT_MCP_TIMEOUT = 30_000`, `registry.ts:302`), so the duplication is purely structural.
- Fix: Move this section to `running/cli-reference.mdx` or a dedicated "startup" page and keep only a cross-reference here.

## Redesign notes
- The page conflates two unrelated topics — OS sandboxing (the actual subject) and startup diagnostics (safe mode). Splitting them would let each page be authoritative and remove ~100 lines of duplication.
- The "Runtime Inspection & Configuration API" section describes an API whose violation-visibility half does not work end-to-end. Either complete the pipeline (worker → forwardEvent → server → UI) or trim the docs to what actually functions (the `/sandbox` slash command and the config GET/PUT).
- The daemon-vs-worker split for `sandbox_get_status`/`sandbox_update_config` is the root cause of most inaccuracies (violations=0, active=configured, no null-delete, global-only config). The docs should either reflect daemon reality or the code should route status queries to a live worker.
- Security claims on a security page need a higher bar: every "visible in the web UI" / "forwarded in real time" assertion should be backed by a forwarding handler in `lifecycle-handlers.ts` and a consumer in `packages/ui/src`.

## Code UX opportunities
- `pizza --help` advertises `enforce, audit, or off` for `--sandbox` while the docs and config use `none/basic/full`; align the help text to the canonical names (or accept both and document both).
- The daemon's `sandbox_get_status` returns `active === configured` and always-0 violations, which is misleading for any consumer (UI or API). Consider having the daemon forward the status query to an active worker, or return `active: null` ("unknown") when no worker is live.
- The two `sandbox_update_config` handlers (daemon vs worker remote-exec-handler) implement different null semantics (set-to-null vs delete). Unify them so the documented "null removes" behavior is consistent regardless of which path serves the request.
- The `sandbox:violation` event is emitted but goes nowhere off-host. If real-time web UI visibility is intended, add a `pi.events.on("sandbox:violation", rctx.forwardEvent)` listener alongside the existing `mcp:*` forwarders.
- `launchctl unload`/`load` of `com.pizzapi.runner.plist` (line 364-365) restarts the daemon and disconnects active sessions; a caution note (or a non-restarting `launchctl setenv`-based alternative for env-var-only changes) would reduce surprise.
