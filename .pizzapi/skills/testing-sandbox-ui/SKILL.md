---
name: testing-sandbox-ui
description: Use when testing UI features, service panels, or visual behavior in the PizzaPi sandbox using a headless browser. Use when verifying new UI components work end-to-end before merging.
---

# Testing Sandbox UI with Playwright

## Overview

The PizzaPi sandbox (`packages/server/tests/harness/sandbox.ts`) spins up a full server with mock sessions, runners, and services. Combined with `playwright-cli`, you can drive a real browser against it to verify UI features work end-to-end — login, navigation, service panels, iframes, etc.

## When to Use

- Verifying new UI components render correctly in the full app
- Testing service panel iframe loading through the tunnel proxy
- Checking auth flows (login, session management)
- Visual regression checks before merging UI branches
- Any time you need to confirm "does this actually work in a browser?"

## Quick Reference

| Step | Command |
|------|---------|
| Start sandbox | `screen -dmS sandbox bash -c 'cd packages/server && exec bun tests/harness/sandbox.ts --headless --redis=memory > /tmp/sandbox-out.log 2>&1'` |
| Wait for ready | `grep "Sandbox ready" /tmp/sandbox-out.log` |
| Extract UI URL | `grep "UI (HMR)" /tmp/sandbox-out.log` |
| Open browser | `playwright-cli open <URL>` |
| Get element refs | `playwright-cli snapshot` then read the `.yml` file |
| Interact | `playwright-cli fill <ref> "text"` / `playwright-cli click <ref>` |
| Screenshot | `playwright-cli screenshot` then read the `.png` file |
| Clean up | `playwright-cli close && screen -S sandbox -X quit` |

## Starting the Sandbox

**Critical: Use `screen` on macOS.** Background processes started with `nohup &` get killed when the parent bash command times out. `screen` detaches the process from the shell entirely.

```bash
# Start in a detached screen session
screen -dmS sandbox bash -c \
  'cd packages/server && exec bun tests/harness/sandbox.ts --headless --redis=memory > /tmp/sandbox-out.log 2>&1'

# Wait for startup (typically 4-6 seconds)
sleep 6

# Verify it's running
pgrep -f "sandbox.ts" && echo "alive" || echo "dead"

# Extract URLs from the log
grep "UI (HMR)" /tmp/sandbox-out.log   # → http://127.0.0.1:<port>
grep "Server:"  /tmp/sandbox-out.log   # → http://127.0.0.1:<port>
grep "API:"     /tmp/sandbox-out.log   # → http://127.0.0.1:<port>
```

The sandbox starts three things on random ports:
- **Vite dev server** (UI with HMR) — this is where you point the browser
- **API server** (WebSocket + REST) — the Vite proxy forwards to this
- **Sandbox API** (HTTP control surface) — for programmatic session control

## Logging In

The sandbox creates a test user automatically:

| Field | Value |
|-------|-------|
| Email | `testuser@pizzapi-harness.test` |
| Password | `HarnessPass123` |

```bash
playwright-cli open http://127.0.0.1:<vite-port>
playwright-cli snapshot                              # find email/password input refs
playwright-cli fill <email-ref> "testuser@pizzapi-harness.test"
playwright-cli fill <password-ref> "HarnessPass123"
playwright-cli snapshot                              # find sign-in button ref (not disabled)
playwright-cli click <button-ref>
playwright-cli screenshot                            # verify logged in
```

## Testing Service Panels

After logging in, select a session from the sidebar. Service panel buttons appear in the session toolbar header. Look for buttons like "Toggle System Monitor" in the snapshot.

```bash
playwright-cli snapshot
# grep for "monitor\|panel\|service\|tunnel" in the .yml file
playwright-cli click <panel-button-ref>
sleep 2                                              # wait for iframe to load
playwright-cli screenshot                            # verify panel renders
```

The panel loads via iframe → tunnel proxy → mock HTTP server. The sandbox starts a mock system monitor server on a random port and announces it through the mock runner's `service_announce` event.

## Cleanup

**Always clean up both browser and sandbox:**

```bash
playwright-cli close                    # close browser
screen -S sandbox -X quit              # kill sandbox screen session
pkill -f "sandbox.ts" 2>/dev/null      # belt-and-suspenders
```

## Common Problems

| Problem | Cause | Fix |
|---------|-------|-----|
| "Invalid origin" on login | Vite dev server port not in `trustedOrigins` | Fixed in `49116fc8` — `addTrustedOrigin()` called after Vite starts |
| Sandbox dies immediately | Shell timeout kills background process | Use `screen -dmS` instead of `nohup &` |
| "net::ERR_CONNECTION_REFUSED" | Sandbox process died or hasn't started yet | Check `pgrep -f sandbox.ts` and `/tmp/sandbox-out.log` |
| Stale element refs | DOM changed since last snapshot | Re-run `playwright-cli snapshot` to get fresh refs |
| Panel iframe blank | Tunnel proxy can't reach mock server | Check sandbox log for "Mock system monitor panel on port X" |
| "Server running in degraded mode" banner | Redis in-memory mode (expected) | Harmless — real-time updates work, it's just a warning |

## Mock Runner Capabilities

The sandbox mock runner (`mock-runner.ts`) supports:

- **`panels` option** — `ServicePanelInfo[]` included in `service_announce`
- **`tunnel_request` handling** — proxies HTTP to registered panel ports
- **`announceServices(serviceIds, panels?)`** — re-announce at runtime

To add a new mock service panel, start a `Bun.serve({ port: 0 })` before creating the runner and pass the port in the `panels` array.

## Sandbox Credentials & URLs

All ports are ephemeral (random). Always extract from `/tmp/sandbox-out.log`:

```bash
# One-liner to extract all three URLs
grep -E "(UI|Server|API):" /tmp/sandbox-out.log
```

API key is also in the log if you need direct API access.
