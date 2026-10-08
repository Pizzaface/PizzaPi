# Session UI slowdown benchmark

Re-runnable benchmark: `packages/server/benchmarks/slowdown.ts`.

Full production UI run:

```bash
bun packages/server/benchmarks/slowdown.ts --build-ui --out /tmp/pizzapi-slowdown-validation
```

Fast smoke run:

```bash
bun packages/server/benchmarks/slowdown.ts --histories=1 --media-kb= --burst-runners=1 --burst-sessions=1 --soak-ms=0 --out /tmp/pizzapi-slowdown-smoke
```

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

Run: `2026-10-08T04:00:18.545Z`

Command:

```bash
bun packages/server/benchmarks/slowdown.ts --histories=1 --media-kb= --burst-runners=1 --burst-sessions=1 --soak-ms=0 --out=/tmp/pizzapi-slowdown-smoke-WYNiJiY5-final
```

| Metric | Value |
| --- | ---: |
| Switch median | 7829 ms |
| Switch p95 | 7829 ms |
| Switch max | 7829 ms |
| Burst sessions delivered | 1/1 |
| Soak events | 0 |
| Max long task | 3963 ms |

This is a tiny smoke run to prove the production path works; it is not enough to justify a UI optimization.

## Known limits

- PNG media is markdown data URLs, so it exercises browser/UI rendering but not attachment upload/download.
- INP is approximated by script timings and long tasks; use Chrome traces if browser-specific input delay is suspected.
- Runner load is mocked at the relay/server boundary, not from real worker processes.
- Cleanup currently prints late Redis-disconnect warnings after results are written; benchmark output is still produced.
