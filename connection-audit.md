# Connection Audit — Dish 015

## Scope
- Server WebSocket wiring: `packages/server/src/ws/`
- UI socket/fetch usage: `packages/ui/src/`
- Goal: inventory all frontend↔backend connections, map flows, and flag duplication/oversized/unused paths.

## 1) WebSocket namespace inventory

### Server-side namespaces (6 total)
Registered in `packages/server/src/ws/namespaces/index.ts`:

1. `/relay` — TUI worker session channel
2. `/viewer` — browser session viewer channel
3. `/runner` — runner daemon control/data channel
4. `/terminal` — browser terminal PTY channel
5. `/hub` — browser live session/meta feed
6. `/runners` — browser runner inventory feed

### Browser-opened namespaces (4 + 1 transient)
From `packages/ui/src/`:

- `/hub` — long-lived shared socket (App)
- `/runners` — long-lived shared socket (`useRunnersFeed`)
- `/viewer` — active-session socket (App)
- `/terminal` — per-terminal socket (`WebTerminal`)
- `/viewer` (transient) — temporary socket only for ending non-active sessions

### Service channels
Service channels are **already multiplexed** over existing sockets (no extra namespace per service):

- Envelope: `ServiceEnvelope { serviceId, type, requestId?, payload, sessionId? }`
- Events:
  - `service_message` (viewer/relay → runner and runner → viewer/relay)
  - `service_announce` (runner → viewer)

## 2) HTTP endpoint inventory

`rg "fetch\(" packages/ui/src` finds **37 unique fetch endpoints/templates** in UI code.

### Endpoints hit on app load (authenticated path)

1. `GET /health` (degraded banner polling)
2. `GET /api/settings/hidden-models` (hidden model sync)
3. `GET /api/sessions/pinned` (sidebar pinned list)
4. `GET /api/sessions` (**fallback only** if `/hub` snapshot is not received promptly)

### Endpoints hit on app load (unauthenticated path)

1. `GET /api/signup-status` (Auth page signup enablement)

## 3) Data flow map by connection

### `/hub` (browser session feed)
- Server → UI: `sessions`, `session_added`, `session_removed`, `session_status`, `state_snapshot`, `meta_event`
- UI → Server: `subscribe_session_meta`, `unsubscribe_session_meta`
- Purpose: global session list + per-session meta state/trigger badges.

### `/runners` (browser runner feed)
- Server → UI: `runners`, `runner_added`, `runner_removed`, `runner_updated`
- Purpose: live runner inventory for sidebar/runner manager.

### `/viewer` (active session stream)
- Server → UI: `connected`, `event`, `disconnected`, `exec_result`, `service_message`, `service_announce`, `trigger_error`
- UI → Server: `connected`, `resync`, `input`, `model_set`, `exec`, `trigger_response`, `mcp_oauth_paste`, `service_message`
- Purpose: main transcript/events/control path.

### `/terminal` (browser PTY)
- UI → Server: `terminal_input`, `terminal_resize`, `kill_terminal`
- Server → UI: `terminal_connected`, `terminal_ready`, `terminal_data`, `terminal_exit`, `terminal_error`
- Purpose: live terminal interaction.

### `/relay` (worker)
- Worker → Server: register/session lifecycle/events/triggers/service_message
- Server → Worker: viewer inputs/exec/model, inter-session messages, trigger responses
- Purpose: core CLI worker relay.

### `/runner` (daemon)
- Runner ↔ Server: registration, session spawn lifecycle, skills/agents/plugins/file ops, terminal backend, service channels
- Purpose: daemon control plane and fanout source for per-runner services.

## 4) Duplicates, oversized payloads, unused connections

### Duplicates found
1. **Duplicate session-list path on connect**
   - `/hub` already sends canonical `sessions`, while sidebar fallback also called `/api/sessions` immediately on each connect.
   - This created avoidable duplicate payload transfer.
   - ✅ Quick win already on `main`: delayed/cancelable REST fallback (details below).

2. **Duplicate unchanged `service_announce` fanout**
   - Runner could re-emit identical announce payloads; server rebroadcasted and rewrote Redis every time.
   - ✅ Quick win already on `main`: no-op dedupe for unchanged announce payloads.

### Oversized payload risk
1. `service_message.payload` is unbounded (`unknown`) and currently not size-capped server-side.
   - Impact: misbehaving/over-chatty services can push oversized frames to all viewers for a runner.
   - Not changed in this quick-win pass (requires protocol-level budget/limits + error surface).

2. `session_active` can be large, but this path already has chunked delivery + assembled cache fallback in relay pipeline.

### Unused connections
- No clearly unused namespace found.
- All registered namespaces have active producers/consumers in current architecture.

## 5) Can service channels share a single multiplexed socket?

**Yes — and they already do.**

Current architecture multiplexes service traffic on the existing `/viewer`/`/relay` sockets using `serviceId` in `ServiceEnvelope`. No additional per-service WebSocket namespace is required.

## 6) Quick wins noted by this audit

The following improvements were identified during the audit. Items A and B were
already present on `main` before this PR; they are documented here for completeness
and attribution. Item C is the only change delivered by this PR.

### A) Avoid redundant `/api/sessions` fetches on healthy `/hub` connects *(pre-existing on main)*
- File: `packages/ui/src/components/SessionSidebar.tsx`
- Change:
  - Added delayed fallback (`HUB_SESSIONS_REST_FALLBACK_DELAY_MS = 1200`)
  - Cancel fallback timer when canonical `/hub` `sessions` snapshot arrives
  - Reused same delayed path for already-connected shared socket
- Result: reduced duplicate startup/reconnect HTTP payloads.

### B) Skip no-op `service_announce` fanout *(pre-existing on main)*
- File: `packages/server/src/ws/namespaces/runner.ts`
- Change:
  - Added `isSameServiceAnnounce(...)` comparator
  - `service_announce` handler now returns early for unchanged payloads
- Result: avoids redundant Redis writes and per-session viewer broadcasts.

### C) Extract and test `isSameServiceAnnounce` comparator *(shipped by this PR)*
- Files:
  - `packages/server/src/ws/namespaces/runner.service-announce.ts` — pure comparator extracted to its own module
  - `packages/server/src/ws/namespaces/runner.service-announce.test.ts` — unit tests covering equality and mismatch cases
- Change: moved the helper out of the heavy `runner.ts` namespace so the test can import just the comparator without pulling in the full server module and all its transitive dependencies.
- Result: cheaper, more isolated test coverage for the dedupe logic.

## 7) Follow-up items (larger)

1. Add byte-size budget + rejection/telemetry for `service_message.payload`.
2. Consider optional debounce/coalesce for high-frequency service streams when multiple viewers watch same runner.
3. Add lightweight connection metrics (announce count, service_message bytes, fallback REST hit-rate) to validate impact in production.
