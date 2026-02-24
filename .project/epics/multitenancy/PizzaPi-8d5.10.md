---
name: CLI org flag and Docker Compose full stack
status: open
created: 2026-02-24T02:13:15Z
updated: 2026-02-24T02:18:20Z
beads_id: PizzaPi-8d5.10
depends_on: [PizzaPi-8d5.4, PizzaPi-8d5.5, PizzaPi-8d5.6]
parallel: true
conflicts_with: [PizzaPi-8d5.6]
---

# Task: CLI org flag and Docker Compose full stack

## Description

Update the CLI to support org-scoped runner registration and create a Docker Compose configuration that brings up the complete multi-tenant stack: control plane, Caddy, Redis, and a sample org instance.

## Acceptance Criteria

- [ ] `packages/cli` accepts `--org <slug>` flag for runner registration
- [ ] When `--org` is provided, CLI connects to `{slug}.pizzapi.example.com` and authenticates with org-scoped JWT
- [ ] CLI prompts for control plane login if no cached credentials
- [ ] `docker/compose.multitenancy.yml` defines: control-plane, caddy, redis services on `pizzapi-net` network
- [ ] `docker compose -f docker/compose.multitenancy.yml up` brings up a working multi-tenant stack
- [ ] README section documenting multi-tenant deployment setup
- [ ] Existing single-tenant `docker/compose.yml` is unaffected

## Technical Details

- CLI changes: add `--org` option to runner start command, fetch org-token from control plane before connecting
- Docker Compose:
  - `control-plane`: builds from `packages/control-plane`, exposes port 3100
  - `caddy`: official Caddy image, mounts Caddyfile from `docker/Caddyfile`
  - `redis`: existing redis service
  - Shared network: `pizzapi-net`
  - Volumes: `control-plane.db`, Caddy data/config
- Separate compose file to avoid cluttering single-tenant setup

## Dependencies

- [ ] Task 004 — server JWT middleware
- [ ] Task 005 — Docker provisioning
- [ ] Task 006 — Caddy configuration

## Effort Estimate

- Size: M
- Hours: 6
- Parallel: true — final integration task, but can start once dependencies are done
