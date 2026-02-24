---
name: Scaffold control-plane package
status: open
created: 2026-02-24T02:13:15Z
updated: 2026-02-24T02:18:20Z
beads_id: PizzaPi-8d5.1
depends_on: []
parallel: false
conflicts_with: []
---

# Task: Scaffold control-plane package

## Description

Create `packages/control-plane` as a new Bun server package with the same foundational setup as `packages/server`: Bun.serve, Kysely + SQLite, better-auth, and TypeScript strict mode. This is the foundation all other control plane tasks build on.

## Acceptance Criteria

- [ ] `packages/control-plane/` exists with `package.json`, `tsconfig.json`, `src/index.ts`
- [ ] Bun.serve starts and responds to health check at `GET /health`
- [ ] Kysely is configured with SQLite (separate DB file: `control-plane.db`)
- [ ] better-auth is initialized for user registration/login (email/password)
- [ ] Package builds successfully with `bun run build`
- [ ] Root `package.json` scripts updated to include control-plane in build/dev/typecheck

## Technical Details

- Mirror the structure of `packages/server/` for consistency
- Use Kysely migrations for schema management
- better-auth config: email/password provider, session management
- Entry point: `src/index.ts` with Bun.serve
- Port: configurable via `PORT` env var (default 3100)

## Dependencies

- [ ] None — this is the first task

## Effort Estimate

- Size: M
- Hours: 6
- Parallel: false — foundation for tasks 2-7
