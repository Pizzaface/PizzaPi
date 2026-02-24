---
name: Instance health check loop
status: open
created: 2026-02-24T02:13:15Z
updated: 2026-02-24T02:18:20Z
beads_id: PizzaPi-8d5.7
depends_on: [PizzaPi-8d5.2, PizzaPi-8d5.5]
parallel: true
conflicts_with: []
---

# Task: Instance health check loop

## Description

Implement a periodic health check in the control plane that pings all org instances and updates their status. Unhealthy instances are flagged after 3 consecutive failures.

## Acceptance Criteria

- [ ] Background loop runs every 30 seconds (configurable via `HEALTH_CHECK_INTERVAL_MS`)
- [ ] Pings `GET /health` on each org instance's internal host:port
- [ ] Updates `org_instances.status` to "healthy" or "unhealthy"
- [ ] Updates `org_instances.health_checked_at` timestamp
- [ ] After 3 consecutive failures, marks instance as "unhealthy"
- [ ] `GET /api/orgs/:slug/status` returns instance health info
- [ ] Health check timeout: 5 seconds per instance
- [ ] Logs warnings for unhealthy instances

## Technical Details

- Use `fetch()` with AbortSignal timeout for health pings
- Track consecutive failure count in memory (Map<orgId, failCount>)
- Run as `setInterval` in the control plane process
- Skip instances with status "stopped" or "provisioning"

## Dependencies

- [ ] Task 002 — org_instances table
- [ ] Task 005 — provisioned instances to check

## Effort Estimate

- Size: S
- Hours: 3
- Parallel: true — independent background service
