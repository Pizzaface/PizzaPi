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

Run: `2026-10-09T11:54:34.795Z`

Command:

```bash
bun packages/server/benchmarks/slowdown.ts --histories=5,25 --media-kb= --burst-runners=1 --burst-sessions=2 --soak-ms=0 --out=/tmp/pizzapi-slowdown-smoke-WYNiJiY5-r2
```

| Metric | Value |
| --- | ---: |
| Switch median | 34 ms |
| Switch p95 | 34 ms |
| Switch max | 34 ms |
| Burst sessions emitted | 2/2 |
| Soak events | 0 |
| Max long task | 0 ms |

This is a tiny smoke run to prove the production path works; it is not enough to justify a UI optimization.
The previous numbers in this doc (switch median 7829 ms) were invalid: the switch measurement dispatched
an event nothing listened for, then slept a fixed 250 ms and reported the sleep as the switch time. It now
navigates the same way a notification-tap does (`pp-navigate-session` CustomEvent, the real path App.tsx
listens for) and waits for the target session's name to render in the header before stopping the clock.

## Known limits

- PNG media is markdown data URLs, so it exercises browser/UI rendering but not attachment upload/download.
- INP is approximated by script timings and long tasks; use Chrome traces if browser-specific input delay is suspected.
- Runner load is mocked at the relay/server boundary, not from real worker processes.
- Cleanup currently prints late Redis-disconnect warnings after results are written; benchmark output is still produced.
