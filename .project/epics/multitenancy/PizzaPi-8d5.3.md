---
name: JWT issuance and JWKS endpoint
status: open
created: 2026-02-24T02:13:15Z
updated: 2026-02-24T02:18:20Z
beads_id: PizzaPi-8d5.3
depends_on: [PizzaPi-8d5.1, PizzaPi-8d5.2]
parallel: false
conflicts_with: []
---

# Task: JWT issuance and JWKS endpoint

## Description

Implement centralized JWT token issuance on the control plane and a JWKS endpoint that org instances use to validate tokens. When a user authenticates and selects an org, the control plane issues a short-lived JWT containing user ID, org ID, and role.

## Acceptance Criteria

- [ ] Control plane generates RSA or Ed25519 key pair on first startup (stored in DB or file)
- [ ] `POST /api/auth/org-token` accepts `{ orgSlug }` and returns a JWT with claims: `sub` (user_id), `org_id`, `org_slug`, `role`, `exp` (15 min)
- [ ] `GET /.well-known/jwks.json` returns the public key in JWKS format
- [ ] JWT is signed with the private key and verifiable with the JWKS public key
- [ ] Token issuance requires an active better-auth session and valid org membership
- [ ] Key rotation: support multiple keys in JWKS with `kid` field

## Technical Details

- Use `jose` npm package for JWT signing/verification and JWKS formatting
- Key pair stored in `jwt_keys` table (id/kid, public_key, private_key, created_at, active)
- On startup: check for active key, generate if none exists
- JWT claims: `{ sub, org_id, org_slug, role, iat, exp, iss: "pizzapi-control-plane" }`
- Token lifetime: 15 minutes (org instances cache JWKS for 5 minutes)

## Dependencies

- [ ] Task 001 — control plane scaffold
- [ ] Task 002 — org data model (for membership validation)

## Effort Estimate

- Size: M
- Hours: 6
- Parallel: false — critical path, needed by task 4
