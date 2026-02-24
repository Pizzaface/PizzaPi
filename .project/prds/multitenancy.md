---
name: multitenancy
description: Per-organization multitenancy with horizontally scalable dedicated server instances and a central control plane
status: backlog
created: 2026-02-24T02:09:48Z
---

# PRD: Multitenancy

## Executive Summary

PizzaPi currently operates as a single-instance deployment. This feature introduces per-organization multitenancy with a horizontally scalable architecture where each organization gets a dedicated PizzaPi server instance. A central control plane manages org provisioning, user identity, and routing — enabling PizzaPi to scale as a SaaS platform or a managed enterprise offering.

## Problem Statement

Today, PizzaPi is deployed as a monolithic single-tenant instance. Teams and organizations that want isolated environments must manually stand up and manage separate deployments. This creates operational overhead, inconsistent configurations, and no unified identity or management layer.

**Why now?** As PizzaPi adoption grows, supporting multiple teams/orgs on a single platform is essential for SaaS viability and enterprise adoption. Without multitenancy, each new customer requires bespoke infrastructure work.

## User Stories

### Persona: Platform Admin
- As a platform admin, I want to provision new organizations so that each team gets an isolated PizzaPi environment.
- As a platform admin, I want to monitor all org instances from a central dashboard so I can manage health, usage, and capacity.
- **Acceptance criteria:** Admin can create/delete orgs, view instance status, and see aggregate usage metrics.

### Persona: Org Admin
- As an org admin, I want to invite users to my organization so my team can collaborate on agent sessions.
- As an org admin, I want to manage org-level settings (runners, API keys, preferences) independently from other orgs.
- **Acceptance criteria:** Org admin can invite/remove members, configure org settings, and manage runners within their org boundary.

### Persona: Developer (End User)
- As a developer, I want to log in once and access any organization I belong to without re-authenticating.
- As a developer, I want my sessions, history, and preferences isolated per organization.
- **Acceptance criteria:** User can switch between orgs seamlessly; data from one org is never visible in another.

### Persona: Self-Hosting Enterprise
- As an enterprise IT admin, I want to deploy the multitenancy control plane on-premises so we can run multiple team instances internally.
- **Acceptance criteria:** Control plane + org instances can be deployed via Docker Compose or Kubernetes without external dependencies.

## Requirements

### Functional Requirements

#### Central Control Plane
- **Org Registry**: CRUD operations for organizations (name, slug, plan, status)
- **User Identity**: Central user accounts with SSO-ready architecture (email/password initially, OAuth/SAML later)
- **Org Membership**: Users can belong to multiple orgs with per-org roles (owner, admin, member)
- **Instance Provisioning**: API to provision/deprovision dedicated PizzaPi server instances per org
- **Routing**: Subdomain-based routing (`{org-slug}.pizzapi.example.com`) to the correct org instance

#### Org Instance (Dedicated Server)
- **Isolated Data**: Each org instance has its own SQLite database, Redis namespace (or dedicated Redis), and file storage
- **Scoped Runners**: Runners connect to and are managed within a single org instance
- **Scoped Sessions**: All agent sessions belong to the org; no cross-org session visibility
- **Org Settings**: Independent configuration for API keys, model providers, notification preferences
- **Instance Identity**: Each instance knows its org ID and validates tokens issued by the control plane

#### Auth Flow
- User authenticates against the central control plane
- Control plane issues a JWT containing user ID + org memberships
- Org instances validate JWTs from the control plane (shared signing key or JWKS endpoint)
- Org-switching is seamless without re-authentication

#### API & Communication
- Control plane exposes a management API (REST) for org/user/instance CRUD
- Org instances report health/heartbeat back to the control plane
- WebSocket relay connections are scoped to the org instance

### Non-Functional Requirements

- **Performance**: Org instance performance is independent — one org's load does not affect another
- **Scalability**: Horizontal scaling by adding new org instances on new servers/containers; control plane is lightweight and stateless (behind a load balancer)
- **Security**: Strict data isolation — no shared database tables across orgs; JWT-based auth with short-lived tokens; TLS everywhere
- **Availability**: Control plane downtime should not break active org sessions (instances operate independently once provisioned)
- **Observability**: Centralized logging and metrics aggregation across all org instances

## Success Criteria

| Metric | Target |
|--------|--------|
| Org provisioning time | < 60 seconds from API call to healthy instance |
| Cross-org data leakage | Zero — verified by automated security tests |
| Auth latency (org switch) | < 500ms for JWT validation + org context load |
| Concurrent orgs per control plane | Support 100+ orgs without degradation |
| Instance independence | Org instance operates normally if control plane is temporarily unreachable |

## Constraints & Assumptions

### Constraints
- Must use Bun runtime and existing PizzaPi tech stack (SQLite/Kysely, Redis, better-auth)
- Control plane and org instances communicate over HTTPS; no shared database connections
- Initial deployment target is Docker Compose; Kubernetes support is a fast-follow

### Assumptions
- DNS wildcard is configured for subdomain routing (e.g., `*.pizzapi.example.com`)
- Each org instance runs as a separate container/process with its own port or behind a reverse proxy
- better-auth can be extended or wrapped to support centralized JWT issuance
- Redis can be namespaced per org (shared Redis with key prefixes) or dedicated per instance

## Out of Scope (v1)

- **Billing & subscription management** — no payment processing or plan enforcement
- **Auto-scaling** — instances are provisioned manually or via API; no auto-scale based on load
- **SSO / SAML / OAuth federation** — email/password auth only in v1; SSO is architecture-ready but not implemented
- **Cross-org collaboration** — no sharing sessions or runners between orgs
- **Data migration between orgs** — no tooling to move users/data between org instances
- **White-labeling / custom domains** — subdomain routing only; no custom domain mapping

## Dependencies

### External
- **Reverse proxy** (e.g., Caddy, Traefik, nginx) for subdomain-based routing to org instances
- **DNS provider** with wildcard subdomain support
- **Container orchestration** (Docker Compose minimum, Kubernetes optional)

### Internal
- **better-auth** — needs extension for centralized identity + JWT issuance
- **Server package** — needs org-awareness (validate org context on every request)
- **UI package** — needs org switcher, org settings pages, and control plane admin UI
- **CLI package** — needs org context for runner registration

## Architecture Overview

```
┌─────────────────────────────────┐
│        Central Control Plane    │
│  ┌───────────┐  ┌────────────┐ │
│  │ Org CRUD  │  │ User/Auth  │ │
│  │ Provision │  │ JWT Issue  │ │
│  └───────────┘  └────────────┘ │
│         ┌──────────┐           │
│         │ Admin UI │           │
│         └──────────┘           │
└──────────────┬──────────────────┘
               │ HTTPS
    ┌──────────┼──────────┐
    ▼          ▼          ▼
┌────────┐ ┌────────┐ ┌────────┐
│ Org A  │ │ Org B  │ │ Org C  │
│Instance│ │Instance│ │Instance│
│        │ │        │ │        │
│ SQLite │ │ SQLite │ │ SQLite │
│ Redis  │ │ Redis  │ │ Redis  │
│ Runners│ │ Runners│ │ Runners│
└────────┘ └────────┘ └────────┘
  acme.      beta.      corp.
  pizzapi    pizzapi    pizzapi
  .example   .example   .example
  .com       .com       .com
```

## Open Questions

1. Should the control plane be a separate package (`packages/control-plane`) or an extension of the existing server?
2. What is the instance provisioning mechanism — Docker API, shell scripts, or a pluggable provider interface?
3. Should org instances share a single Redis with key-prefix isolation, or each get a dedicated Redis?
4. How should runner authentication change to be org-scoped?
