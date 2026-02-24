---
name: multitenancy
status: backlog
created: 2026-02-24T02:11:21Z
progress: 0%
prd: .project/prds/multitenancy.md
beads_id: PizzaPi-8d5
---

# Epic: Multitenancy

## Overview

Introduce per-organization multitenancy to PizzaPi via a new **control plane** package (`packages/control-plane`) that manages orgs, centralized user identity, and JWT-based auth. Each org gets a dedicated PizzaPi server instance (separate process/container) with its own SQLite DB and Redis namespace. A reverse proxy (Caddy) handles subdomain-based routing. The existing `packages/server` is modified minimally — it gains JWT validation and org-context awareness but otherwise remains the single-org runtime it already is.

## Architecture Decisions

- **Separate control plane package**: The control plane is a new `packages/control-plane` Bun server, not bolted onto the existing server. This keeps concerns clean — the control plane manages identity and provisioning; org instances handle sessions and runners.
- **JWT-based federated auth**: The control plane issues JWTs (via better-auth + custom JWT plugin). Org instances validate tokens using a shared JWKS endpoint — no direct DB sharing.
- **Docker-based provisioning**: Org instances are provisioned as Docker containers via the Docker Engine API. Each container runs the existing `packages/server` with org-specific env vars (ORG_ID, ORG_SLUG, JWT_JWKS_URL, REDIS_PREFIX).
- **Shared Redis with key prefixes**: A single Redis instance is used with per-org key prefixes (`org:{slug}:*`) to reduce infrastructure complexity. Dedicated Redis per org is a future option.
- **Caddy reverse proxy**: Caddy with on-demand TLS and wildcard subdomain routing. Control plane registers/deregisters upstreams via Caddy's admin API.
- **Minimal server changes**: The existing server gains a middleware that extracts org context from JWT and validates org membership. All existing routes remain unchanged — they're already scoped to a single instance's DB.

## Technical Approach

### Control Plane (`packages/control-plane`)

- **Stack**: Bun.serve, Kysely + SQLite, better-auth
- **Data model**:
  - `organizations` (id, slug, name, status, created_at)
  - `org_memberships` (user_id, org_id, role: owner|admin|member)
  - `org_instances` (org_id, container_id, host, port, status, health_checked_at)
  - Users table managed by better-auth
- **API endpoints**:
  - `POST /api/orgs` — create org + provision instance
  - `GET/DELETE /api/orgs/:slug` — read/delete org
  - `POST /api/orgs/:slug/members` — invite user
  - `GET /api/orgs/:slug/status` — instance health
  - `GET /api/user/orgs` — list orgs for authenticated user
- **Provisioning**: Calls Docker Engine API to `docker run` a PizzaPi server container with org-specific config. Registers upstream with Caddy.
- **Health checks**: Periodic HTTP health pings to org instances; marks unhealthy after 3 failures.

### Server Modifications (`packages/server`)

- **New middleware**: `org-context.ts` — extracts and validates JWT from `Authorization` header or cookie; populates `req.orgId` and `req.userId`. Falls back to existing better-auth session for backward compatibility (single-tenant mode).
- **Env-based org config**: `ORG_ID`, `ORG_SLUG`, `REDIS_PREFIX`, `JWT_JWKS_URL` env vars. When `ORG_ID` is set, the server operates in multi-tenant mode.
- **Redis namespacing**: Prefix all Redis keys with `REDIS_PREFIX` env var (defaults to empty for single-tenant).
- **Runner auth**: Runners provide an org-scoped token during WebSocket handshake; server validates against its ORG_ID.

### UI Changes (`packages/ui`)

- **Org switcher**: Dropdown in the header showing user's orgs; switching navigates to `{slug}.pizzapi.example.com`.
- **Control plane admin UI**: Separate route (`/admin`) on the control plane domain for org management (create, delete, view status). Simple table + forms — no complex dashboards in v1.
- **Org settings page**: Within each org instance, a settings page for org-specific configuration (API keys, members list).

### Infrastructure (`docker/`)

- **Updated Docker Compose**: Adds `control-plane` and `caddy` services alongside existing `redis` and `server`.
- **Caddy config**: Wildcard TLS, dynamic upstreams via admin API.
- **Provisioning template**: A container template/config that the control plane uses to spin up org instances.

### CLI Changes (`packages/cli`)

- **Org-scoped runner registration**: `--org <slug>` flag; runner connects to `{slug}.pizzapi.example.com` and authenticates with an org-scoped token.

## Implementation Strategy

**Phase 1 — Foundation** (Tasks 1–4): Control plane package, data model, JWT auth, org CRUD API.
**Phase 2 — Instance Management** (Tasks 5–7): Docker provisioning, Caddy routing, health checks.
**Phase 3 — Integration** (Tasks 8–10): Server org-awareness, UI org switcher, CLI org flag, Docker Compose update.

Testing approach: Unit tests for control plane API and JWT validation; integration tests for provisioning + routing; security tests for cross-org isolation.

## Task Breakdown Preview

- [ ] Task 1: Scaffold `packages/control-plane` with Bun server, Kysely, SQLite, better-auth
- [ ] Task 2: Implement org data model and CRUD API (orgs, memberships, instances tables)
- [ ] Task 3: Implement centralized JWT issuance (better-auth JWT plugin + JWKS endpoint)
- [ ] Task 4: Add org-context JWT validation middleware to `packages/server`
- [ ] Task 5: Implement Docker-based org instance provisioning in control plane
- [ ] Task 6: Add Caddy reverse proxy config and dynamic upstream registration
- [ ] Task 7: Implement instance health check loop in control plane
- [ ] Task 8: Add Redis key-prefix namespacing to server and org-scoped runner auth
- [ ] Task 9: Build UI org switcher, control plane admin page, and org settings page
- [ ] Task 10: Update CLI for org-scoped runner registration and Docker Compose for full stack

## Dependencies

- **Docker Engine API** access from control plane container (Docker socket mount)
- **Caddy** with admin API enabled for dynamic upstream management
- **better-auth** JWT/JWKS capabilities (verify plugin support or implement custom)
- **Wildcard DNS** configured in deployment environment

## Success Criteria (Technical)

- Control plane can create an org and have a healthy instance running within 60 seconds
- JWT issued by control plane is validated by org instance with < 50ms overhead
- Zero cross-org data leakage verified by integration tests hitting multiple org subdomains
- Single-tenant mode (no ORG_ID env var) works identically to current behavior — no regression
- Docker Compose `up` brings up full multi-tenant stack (control plane + Caddy + Redis + sample org)

## Estimated Effort

- **Overall**: 3–4 weeks for a single developer
- **Critical path**: Tasks 1–3 (control plane foundation) → Task 4 (server middleware) → Task 5–6 (provisioning + routing)
- **Parallelizable**: Task 9 (UI) can proceed once Tasks 1–3 are done; Task 10 (CLI + Docker) can proceed alongside Task 9

## Tasks Created

- [ ] PizzaPi-8d5.1 - Scaffold control-plane package (parallel: false)
- [ ] PizzaPi-8d5.2 - Org data model and CRUD API (parallel: false)
- [ ] PizzaPi-8d5.3 - JWT issuance and JWKS endpoint (parallel: false)
- [ ] PizzaPi-8d5.4 - Server org-context JWT middleware (parallel: true)
- [ ] PizzaPi-8d5.5 - Docker-based org instance provisioning (parallel: true)
- [ ] PizzaPi-8d5.6 - Caddy reverse proxy and subdomain routing (parallel: true)
- [ ] PizzaPi-8d5.7 - Instance health check loop (parallel: true)
- [ ] PizzaPi-8d5.8 - Redis namespacing and org-scoped runner auth (parallel: true)
- [ ] PizzaPi-8d5.9 - UI org switcher and admin pages (parallel: true)
- [ ] PizzaPi-8d5.10 - CLI org flag and Docker Compose full stack (parallel: true)

Total tasks: 10
Parallel tasks: 7
Sequential tasks: 3
Estimated total effort: 58 hours
