---
name: Server org-context JWT middleware
status: open
created: 2026-02-24T02:13:15Z
updated: 2026-02-24T02:18:20Z
beads_id: PizzaPi-8d5.4
depends_on: [PizzaPi-8d5.3]
parallel: true
conflicts_with: []
---

# Task: Server org-context JWT middleware

## Description

Add a middleware to `packages/server` that validates JWTs issued by the control plane and populates org context on each request. When `ORG_ID` env var is set, the server operates in multi-tenant mode; otherwise it falls back to existing better-auth session auth (single-tenant backward compatibility).

## Acceptance Criteria

- [ ] New `src/middleware/org-context.ts` in packages/server
- [ ] In multi-tenant mode: extracts JWT from `Authorization: Bearer <token>` header or `org_token` cookie
- [ ] Validates JWT signature against JWKS fetched from `JWT_JWKS_URL` env var (cached 5 min)
- [ ] Rejects requests with invalid/expired tokens (401)
- [ ] Rejects requests where JWT `org_id` doesn't match server's `ORG_ID` (403)
- [ ] Populates request context with `userId`, `orgId`, `orgSlug`, `role`
- [ ] When `ORG_ID` is not set, middleware is a no-op (existing auth works unchanged)
- [ ] All existing tests still pass (no regression)

## Technical Details

- Use `jose` package's `jwtVerify` with `createRemoteJWKSet`
- JWKS URL: `JWT_JWKS_URL` env var (e.g., `https://control.pizzapi.example.com/.well-known/jwks.json`)
- Cache JWKS in memory with 5-minute TTL
- Integrate into existing middleware chain in `packages/server/src/middleware.ts`
- Env vars: `ORG_ID`, `ORG_SLUG`, `JWT_JWKS_URL`

## Dependencies

- [ ] Task 003 — JWT issuance + JWKS endpoint

## Effort Estimate

- Size: S
- Hours: 4
- Parallel: true — can run alongside tasks 5, 6, 7
