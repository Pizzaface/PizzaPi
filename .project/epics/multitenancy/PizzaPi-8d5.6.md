---
name: Caddy reverse proxy and subdomain routing
status: open
created: 2026-02-24T02:13:15Z
updated: 2026-02-24T02:18:20Z
beads_id: PizzaPi-8d5.6
depends_on: [PizzaPi-8d5.5]
parallel: true
conflicts_with: [PizzaPi-8d5.10]
---

# Task: Caddy reverse proxy and subdomain routing

## Description

Configure Caddy as the reverse proxy for subdomain-based routing. The control plane dynamically registers/deregisters upstream backends via Caddy's admin API when org instances are provisioned or removed.

## Acceptance Criteria

- [ ] Caddy configuration with wildcard domain (`*.pizzapi.example.com`)
- [ ] Control plane domain routes to control plane service (`control.pizzapi.example.com` or root domain)
- [ ] Org subdomains route to the correct org instance container
- [ ] Control plane registers upstream with Caddy admin API after container provisioning
- [ ] Control plane removes upstream on org deletion
- [ ] WebSocket connections (`/ws`) are correctly proxied
- [ ] Health check endpoint (`/health`) accessible on each subdomain
- [ ] Caddyfile or JSON config template included in `docker/`

## Technical Details

- Caddy admin API: `POST /config/apps/http/servers/...` to add/update routes
- Alternative: use Caddy's `on_demand_tls` with a validation endpoint on the control plane
- Control plane implements `GET /api/caddy/validate?domain={slug}.pizzapi.example.com` returning 200 for valid orgs
- Caddy config in `docker/Caddyfile` with `reverse_proxy` and dynamic upstreams
- WebSocket proxy: ensure `Connection: Upgrade` headers are forwarded

## Dependencies

- [ ] Task 005 — Docker provisioning (need running containers to route to)

## Effort Estimate

- Size: M
- Hours: 5
- Parallel: true — can run alongside task 4
