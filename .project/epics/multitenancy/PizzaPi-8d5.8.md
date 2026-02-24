---
name: Redis namespacing and org-scoped runner auth
status: open
created: 2026-02-24T02:13:15Z
updated: 2026-02-24T02:18:20Z
beads_id: PizzaPi-8d5.8
depends_on: [PizzaPi-8d5.4]
parallel: true
conflicts_with: []
---

# Task: Redis namespacing and org-scoped runner auth

## Description

Update the server's Redis usage to prefix all keys with an org-specific namespace. Update runner WebSocket authentication to validate org-scoped tokens.

## Acceptance Criteria

- [ ] All Redis `get`/`set`/`pub`/`sub` calls in packages/server use `REDIS_PREFIX` env var as key prefix
- [ ] When `REDIS_PREFIX` is empty or unset, keys are unchanged (backward compatible)
- [ ] Runner WebSocket handshake accepts org-scoped JWT token (same format as user JWT but with `type: "runner"`)
- [ ] Runner connections are rejected if JWT `org_id` doesn't match server's `ORG_ID`
- [ ] Existing single-tenant runner auth still works when `ORG_ID` is unset
- [ ] No cross-org key collisions when multiple instances share one Redis

## Technical Details

- Create a Redis key helper: `const key = (k: string) => prefix ? \`${prefix}:${k}\` : k`
- Apply to all Redis operations in `packages/server/src/sessions/` and `packages/server/src/ws/`
- Runner auth: extract token from WebSocket URL query param `?token=<jwt>` or first message
- Prefix format: `org:{slug}:` (e.g., `org:acme:session:123`)

## Dependencies

- [ ] Task 004 — JWT middleware (for token validation logic)

## Effort Estimate

- Size: S
- Hours: 4
- Parallel: true — can run alongside tasks 5, 6, 9
