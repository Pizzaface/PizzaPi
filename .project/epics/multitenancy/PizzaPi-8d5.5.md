---
name: Docker-based org instance provisioning
status: open
created: 2026-02-24T02:13:15Z
updated: 2026-02-24T02:18:20Z
beads_id: PizzaPi-8d5.5
depends_on: [PizzaPi-8d5.2]
parallel: true
conflicts_with: []
---

# Task: Docker-based org instance provisioning

## Description

Implement the provisioning engine in the control plane that creates and manages Docker containers for org instances. When an org is created, the control plane spins up a PizzaPi server container with org-specific configuration.

## Acceptance Criteria

- [ ] `POST /api/orgs` (from task 002) triggers automatic instance provisioning after org creation
- [ ] Provisioner creates a Docker container using the PizzaPi server image with org-specific env vars
- [ ] Env vars passed to container: `ORG_ID`, `ORG_SLUG`, `REDIS_PREFIX`, `JWT_JWKS_URL`, `PORT`
- [ ] Container is attached to a shared Docker network for inter-service communication
- [ ] `org_instances` table updated with container_id, host, port, status
- [ ] `DELETE /api/orgs/:slug` stops and removes the container
- [ ] Provisioning errors are caught and reported (org status set to "error")
- [ ] Configurable Docker image name via `PIZZAPI_SERVER_IMAGE` env var

## Technical Details

- Use `dockerode` npm package to interact with Docker Engine API
- Docker socket mounted into control plane container (`/var/run/docker.sock`)
- Each org container gets a unique port (auto-assigned or from a port range)
- Container naming: `pizzapi-org-{slug}`
- Network: `pizzapi-net` (created if not exists)
- Container labels for identification: `pizzapi.org={slug}`, `pizzapi.type=org-instance`

## Dependencies

- [ ] Task 002 — org data model and CRUD API

## Effort Estimate

- Size: L
- Hours: 8
- Parallel: true — can run alongside tasks 4, 6
