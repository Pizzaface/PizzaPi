# Docs Adversarial Audit — Master Report (2026-07-09)

47 pages audited, one GLM-5.2 agent per page, every claim verified against source.
Per-page findings live alongside this file (`<section>--<page>.md`), each with
file:line evidence, redesign notes, and code UX opportunities.

## Topline

| Metric | Value |
|---|---|
| Pages audited | 47 / 47 |
| Claims checked | 1,677 |
| Claims failed | 352 (21%) |
| BROKEN | 1 (`features/slash-commands`) |
| MAJOR ISSUES | 25 |
| MINOR ISSUES | 21 |
| ACCURATE | 0 |
| P0 findings | 3 |

## P0s (fix first)

1. **`reference/api.mdx`** — API-key auth documented as `Authorization: Bearer pk_live_...`; server only reads `x-api-key` (hex, no prefix). Every integration following the docs gets a 401. (24/96 claims failed on this page overall.)
2. **`security/sandbox.mdx`** — claims `sandbox:violation` events stream to the relay/web UI in real time; no forwarding handler exists and the daemon hard-codes `violations: 0`. Overstated security monitoring.
3. **`web-ui/git-panel.mdx`** — the "Limitations" section denies Stash/History/Compare/Pull/Merge/Rebase/conflict-resolution features that the panel actually ships.

## Systemic themes (cross-page root causes)

### 1. Upstream-pi heritage rot (biggest cluster)
`~/.pi/agent/` paths, `pi <cmd>` invocations, and `pi -e` appear across
`features/pi-packages` (every command wrong), `features/providers-and-models`,
`features/sessions`, `customization/configuration`. PizzaPi patched everything to
`~/.pizzapi/` + `pizza`/`pizzapi`; the docs never followed. **One sweep fixes ~40 failures.**

### 2. Setup wizard vs. docs
- `runSetup()` persists only `apiKey`, never `relayUrl` (setup.ts:257) — docs claim it saves/overwrites both.
- `relayUrl: "off"` is never cleared by re-running setup (standalone-mode's documented recovery path is false).
- Docs invented a `pizzapi setup --show` read-only behavior; setup always re-runs the full wizard.
- Wizard prompts (e.g. "Your name") missing from docs' mock output.

### 3. Fabricated content (documented things that don't exist)
- `runner.json` example schema is invented (real: pid/supervisorPid/startedAt/runnerId/runnerSecret).
- `packages/control-plane` in architecture docs — package doesn't exist.
- MCP `transport: "sse"` — code accepts only `http`/`streamable`.
- Agent frontmatter `provider` field — not parsed (while 4 real fields undocumented).
- Pre-built binary GitHub Releases — release workflow never creates them; curl asset name wrong.
- Preferences accent-preset system (`data-accent` Default/Green/Orange/Purple) — replaced by hex swatches; `accent-colors.css` is dead code.
- Web UI slash commands `/tree /export /share /login /logout /reload /session` — fall through to the model as raw text; `/rewind` exists but is undocumented.
- `list_trigger_subscriptions()` tool in runner-services docs — doesn't exist.

### 4. Silent no-ops documented as working
- `pizzapi update --self` prints a hint and exits 0 — docs say it updates pi.
- Provider `ui-panel`/`metadata` capabilities validated but never invoked; `fireTrigger`/`publishMetadata` passed as no-ops.
- Plan-mode execution tracking (`[DONE:n]`, checklist) only exists in the legacy TUI path, not the primary `plan_mode` flow.

### 5. Inverted/wrong defaults
- `deliverAs` default is `steer`, docs say `followUp` (triggers.ts:941) — services silently interrupt turns.
- Attachment limit: docs say 50 MB configurable; real configurable limit 30 MB, 50 MB is a separate fixed body ceiling. (env-variables page says 20 MB — three pages, three numbers.)
- macOS terminal shell fallback is `/bin/bash`, not `/bin/zsh`.
- `session_error` fires AFTER `session_complete`, not before.
- Child sessions DO send push notifications by default (suppression is opt-in; ntfy never suppressed).

### 6. Redundant page pairs/triples (merge candidates)
- `features/plan-mode` + `web-ui/plan-mode`
- `features/slash-commands` + `web-ui/slash-commands` + `customization/prompt-templates` (three overlapping, mutually contradictory)
- `features/providers-and-models` + `customization/providers`
- `customization/subagents` + `customization/agent-definitions` (canonical reference is the wrong one)
- `deployment/mobile-push` + `web-ui/push-notifications` (auditor verdict: keep separate, cross-link)

## Verdict-by-page

| Page | Verdict | Failed/Checked |
|---|---|---|
| features/slash-commands | **BROKEN** | 11/32 |
| reference/api | MAJOR | 24/96 |
| customization/configuration | MAJOR | 14/58 |
| web-ui/git-panel | MAJOR | 13/34 |
| customization/providers | MAJOR | 11/34 |
| customization/runner-services | MAJOR | 11/38 |
| features/sessions | MAJOR | 11/42 |
| reference/protocol | MAJOR | 11/34 |
| security/sandbox | MAJOR | 11/34 |
| customization/agent-definitions | MAJOR | 9/37 |
| customization/hooks | MAJOR | 9/34 |
| customization/skills | MAJOR | 9/18 |
| deployment/self-hosting | MAJOR | 9/44 |
| features/pi-packages | MAJOR | 9/28 |
| features/providers-and-models | MAJOR | 9/34 |
| reference/architecture | MAJOR | 9/30 |
| running/cli-reference | MAJOR | 9/43 |
| web-ui/preferences | MAJOR | 9/24 |
| customization/mcp-servers | MAJOR | 8/34 |
| customization/claude-plugins | MAJOR | 7/45 |
| customization/subagents | MAJOR | 7/22 |
| features/multi-agent | MAJOR | 7/40 |
| running/runner-daemon | MAJOR | 7/29 |
| customization/prompt-templates | MAJOR | 6/26 |
| start-here/installation | MAJOR | 6/48 |
| features/plan-mode | MAJOR | 5/34 |
| reference/windows-crashes | MAJOR | 5/18 |
| running/standalone-mode | MAJOR | 5/22 |
| web-ui/plan-mode | MAJOR | 5/35 |
| web-ui/file-explorer | MINOR | 9/38 |
| customization/tool-search | MINOR | 5/22 |
| deployment/mac-setup | MINOR | 6/29 |
| deployment/mobile-push | MINOR | 3/22 |
| deployment/tailscale | MINOR | 2/26 |
| features/tunnels | MINOR | 7/30 |
| features/webhooks | MINOR | 6/28 |
| index | MINOR | 0/22 |
| reference/development | MINOR | 7/36 |
| reference/environment-variables | MINOR | 2/51 |
| reference/mobile-builds | MINOR | 2/41 |
| start-here/first-remote-session | MINOR | 4/18 |
| start-here/getting-started | MINOR | 6/39 |
| web-ui/overview | MINOR | 7/83 |
| web-ui/push-notifications | MINOR | 5/34 |
| web-ui/slash-commands | MINOR | 7/34 |
| web-ui/terminal | MINOR | 4/28 |
| web-ui/usage-dashboard | MINOR | 4/49 |

## Top code UX opportunities (fix code, simplify docs)

1. **`pizzapi runner install/uninstall`** — auto-generate the launchd plist / systemd unit. Kills the manual plist authoring duplicated across installation, runner-daemon, and mac-setup pages, and resolves the `launchctl unload` tension.
2. **Setup persistence** — persist `relayUrl` in `runSetup()`, clear `relayUrl: "off"` on success, add `pizzapi config show`. Fixes three pages' worth of false claims at the source.
3. **Fix `deliverAs` server default** to `followUp` (or require it) — matches docs and prevents silent turn interruption.
4. **Expose `list_trigger_subscriptions` tool** — wiring already exists in trigger-client.ts:480.
5. **Release workflow**: either attach `pizza-*` binaries to GitHub Releases or delete the docs tab.
6. **Multi-agent semantics**: emit `session_error` before `session_complete`; suppress child pushes by default (or guard ntfy on `isChildSession`); require explicit `action` on `session_complete` responses (accidental `ack` kills children).
7. **Compose security**: fail fast (or auto-generate + persist) `BETTER_AUTH_SECRET` instead of warning-and-continuing with ephemeral sessions.
8. **Sandbox status honesty**: forward `sandbox:violation` to the relay or return `active: null`/unknown instead of hard-coded zeros.
9. **Canonical binary name**: pick `pizza` or `pizzapi`, document the other as alias — the split is a recurring confusion source in nearly every page.
10. **Drift prevention**: generate keyboard-shortcut tables, protocol event tables, and env-var tables from code constants (`META_RELAY_EVENT_TYPES`, `ShortcutsDialog` list); add a CI check that documented protocol events exist in `packages/protocol` interfaces.

## Suggested refactor sequence

1. **Phase 1 — factual triage (no restructure):** fix all P0/P1s; global sweep `~/.pi/agent/` → `~/.pizzapi/`, `pi ` → `pizza `; delete fabricated content.
2. **Phase 2 — structure:** merge the duplicate page pairs/triples; fold `windows-crashes` into installation or archive it; rebuild `reference/api` from actual route handlers.
3. **Phase 3 — code UX:** land items 1–8 above, then delete the doc paragraphs that existed only to paper over those footguns.
4. **Phase 4 — drift prevention:** code-generated tables + CI doc checks.
