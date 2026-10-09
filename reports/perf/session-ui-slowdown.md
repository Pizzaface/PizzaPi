# Session UI slowdown benchmark

Re-runnable benchmark: `packages/server/benchmarks/slowdown.ts`.

Full production UI run:

```bash
bun packages/server/benchmarks/slowdown.ts --build-ui --out /tmp/pizzapi-slowdown-validation
```

Fast smoke run:

```bash
bun packages/server/benchmarks/slowdown.ts --histories=5,25 --media-kb= --burst-runners=1 --burst-sessions=2 --soak-ms=0 --out /tmp/pizzapi-slowdown-smoke
```

Use at least two `--histories` values for the smoke run — with only one session, "switch" just
re-opens the session already on screen and doesn't exercise a real cross-session switch.

The harness serves `packages/ui/dist` through the real server harness, seeds relay sessions, opens the built UI with Playwright, switches sessions, records long tasks, and writes `slowdown-results.json` plus `slowdown-results.md`.

## Acceptance coverage

- `Reusable benchmark`: `packages/server/benchmarks/slowdown.ts`
- `Production UI support`: uses `PIZZAPI_UI_DIR`/`packages/ui/dist`, with optional `--build-ui`
- `History`: configurable `--histories=125,500,2000`
- `Media`: configurable `--media-kb=65,1024,4096`
- `Remote rendering`: browser drives `/session/<id>` against the real server
- `Runner load`: configurable `--burst-runners` and `--burst-sessions`
- `Findings doc`: this file

## Measured smoke numbers

Run: `2026-10-09T12:38:31.670Z`

Command:

```bash
bun packages/server/benchmarks/slowdown.ts --histories=5,25 --media-kb= --burst-runners=1 --burst-sessions=2 --soak-ms=0 --out=/tmp/pizzapi-slowdown-smoke-WYNiJiY5-r3
```

| Metric | Value |
| --- | ---: |
| Switch median | 69 ms |
| Switch p95 | 69 ms |
| Switch max | 69 ms |
| Burst sessions emitted | 2/2 |
| Soak events | 0 |
| Max long task | 0 ms |

This is a tiny smoke run to prove the production path works; it is not enough to justify a UI optimization.

What the switch metric measures, precisely: the clock starts on the `pp-navigate-session` CustomEvent
dispatch (the real path App.tsx listens for, used today by notification-tap navigation) and stops only once
the TARGET session's transcript has actually rendered — not just its name in the header. App.tsx sets the
header from the UI cache/live-session list immediately on switch, before any snapshot or message arrives,
so a header-only wait measures a header re-render rather than the transcript load. The wait instead looks
for a marker baked into the target session's last seeded message (`switch-marker:<sessionName>`, unique per
session), which can only appear once that session's real content has rendered, and the wait fails loudly
(120s timeout) if it never does.

Making that marker visible also required fixing how sessions are seeded: `message_update` deltas are never
cached server-side for a cold viewer (`updateSessionState()` only runs for `session_active`), so a mock relay
session seeded with only deltas rendered nothing but the "waiting for session events" placeholder for *any*
viewer that connects after the events were sent — including `measureOpen`'s first page load and every
session switch. Seeding now sends one `session_active` snapshot carrying the full message history instead,
the same way a real pi runner answers a cold connect.

The previous numbers in this doc (switch median 7829 ms, then 34 ms) were both invalid for different reasons:
the first because it slept a fixed 250 ms and reported the sleep as the switch time; the second because it
stopped the clock on the header name alone, which (as above) was never proof that any content had rendered
at all. Confirmed non-vacuous: pointing the dispatch at a nonexistent event name (`pp-navigate-session-broken`)
makes the benchmark fail loudly with a timeout instead of reporting a number.

## Known limits

- PNG media is markdown data URLs, so it exercises browser/UI rendering but not attachment upload/download.
- INP is approximated by script timings and long tasks; use Chrome traces if browser-specific input delay is suspected.
- Runner load is mocked at the relay/server boundary, not from real worker processes.
- Cleanup currently prints late Redis-disconnect warnings after results are written; benchmark output is still produced.
