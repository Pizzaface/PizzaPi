---
name: Org data model and CRUD API
status: open
created: 2026-02-24T02:13:15Z
updated: 2026-02-24T02:18:20Z
beads_id: PizzaPi-8d5.2
depends_on: [PizzaPi-8d5.1]
parallel: false
conflicts_with: []
---

# Task: Org data model and CRUD API

## Description

Implement the core data model (organizations, org_memberships, org_instances tables) and REST API endpoints for org management in the control plane.

## Acceptance Criteria

- [ ] Kysely migration creates `organizations`, `org_memberships`, and `org_instances` tables
- [ ] `POST /api/orgs` creates an org (name, slug auto-generated from name)
- [ ] `GET /api/orgs/:slug` returns org details
- [ ] `DELETE /api/orgs/:slug` soft-deletes an org (owner only)
- [ ] `POST /api/orgs/:slug/members` adds a user with role (owner/admin/member)
- [ ] `GET /api/user/orgs` returns all orgs for the authenticated user
- [ ] Slug uniqueness enforced at DB level
- [ ] All endpoints require authentication

## Technical Details

- **Schema**:
  - `organizations`: id (uuid), slug (unique), name, status (active/suspended/deleted), created_at, updated_at
  - `org_memberships`: id, user_id (FK), org_id (FK), role (owner|admin|member), created_at
  - `org_instances`: id, org_id (FK), container_id, host, port, status (provisioning|healthy|unhealthy|stopped), health_checked_at, created_at
- Slug validation: lowercase alphanumeric + hyphens, 3-40 chars
- Use better-auth session middleware for auth on all routes

## Dependencies

- [ ] Task 001 — control plane package scaffold

## Effort Estimate

- Size: M
- Hours: 6
- Parallel: false — needed by tasks 3, 5, 7
