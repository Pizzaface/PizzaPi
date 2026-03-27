# Dish 009: BETTER_AUTH_SECRET Startup Validation

- **Cook Type:** sonnet
- **Complexity:** S
- **Godmother ID:** jekGK4zm
- **Dependencies:** none
- **Files:** packages/server/src/auth.ts
- **Verification:** bun test packages/server, bun run typecheck
- **Status:** queued

## Task Description

`config.secret ?? process.env.BETTER_AUTH_SECRET` (line 242 of auth.ts) can resolve to `undefined` — no validation, no warning, no error. Running without a secret means sessions are signed with a predictable/empty key.

**Fix:**
1. After resolving the secret value, validate it is defined and non-empty
2. If missing: log a clear error message explaining the risk and how to set it
3. In production (check `NODE_ENV === "production"`): throw an error — do not start without a secret
4. In development: generate a random fallback and log a warning with the env var name
5. Add a minimum length check (at least 32 characters) with a warning if shorter

**Do NOT change the config interface** — just add validation after the existing resolution.
