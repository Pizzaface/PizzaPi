# Multi-Tenant Deployment

This guide describes how to deploy PizzaPi in multi-tenant mode with per-organization isolation.

## Architecture

- **Control Plane** (`packages/control-plane`): Manages orgs, users, JWT issuance, and instance provisioning
- **Caddy**: Reverse proxy with wildcard subdomain routing (`{org}.pizzapi.example.com`)
- **Redis**: Shared instance with per-org key prefixes
- **Org Servers**: Per-org PizzaPi server instances provisioned as Docker containers

## Quick Start

```bash
# 1. Build the server image
docker build -t pizzapi-server:latest .

# 2. Start the multi-tenant stack
docker compose -f docker/compose.multitenancy.yml up -d

# 3. Access the control plane
open http://localhost:3100
```

## Configuration

Set these environment variables in a `.env` file or export them before running:

| Variable | Default | Description |
|----------|---------|-------------|
| `PIZZAPI_BASE_DOMAIN` | `pizzapi.example.com` | Base domain for org subdomains |
| `PIZZAPI_JWT_SECRET` | `change-me-in-production` | JWT signing secret |
| `PIZZAPI_SERVER_IMAGE` | `pizzapi-server:latest` | Docker image for org instances |

## CLI: Connecting a Runner to an Org

```bash
# Register a runner with a specific organization
pizzapi runner --org my-org

# The runner will:
# 1. Fetch an org-scoped JWT from the control plane
# 2. Connect to my-org.pizzapi.example.com
# 3. Authenticate with the org-scoped token
```

### Environment Variables for Runners

| Variable | Description |
|----------|-------------|
| `PIZZAPI_ORG_SLUG` | Org slug (alternative to `--org` flag) |
| `PIZZAPI_ORG_TOKEN` | Pre-fetched org JWT (skips control plane auth) |
| `PIZZAPI_CONTROL_PLANE_URL` | Control plane URL for token fetching |
| `PIZZAPI_BASE_DOMAIN` | Base domain for org subdomain resolution |

## Docker Compose Files

- `docker/compose.yml` — Single-tenant stack (unchanged)
- `docker/compose.multitenancy.yml` — Multi-tenant stack (control plane + Caddy + Redis)

The single-tenant compose file is **not affected** by multi-tenancy changes.

## DNS Setup

For production, configure wildcard DNS:

```
*.pizzapi.example.com → your-server-ip
pizzapi.example.com   → your-server-ip
```

For local development, add entries to `/etc/hosts` or use a tool like `dnsmasq`.
