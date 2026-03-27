# Dish 002: Improve Email Validation Regex

- **Cook Type:** jules
- **Complexity:** S
- **Godmother ID:** W2idB6QW
- **Dependencies:** none
- **Files:** packages/server/src/security.ts, packages/server/src/security.test.ts
- **Verification:** bun test packages/server, bun run typecheck
- **Status:** queued

## Task Description

The email validation in `packages/server/src/security.ts` (line 59) uses:
```
/^[^\s@]+@[^\s@]+\.[^\s@]+$/
```

This is overly permissive — it accepts `a@b.c`, addresses with no TLD length check, and addresses over 254 characters (RFC 5321 limit).

**Fix:**
1. Add a length check: email must be ≤ 254 characters
2. Add minimum TLD length: at least 2 chars after the last dot
3. Add local part length check: ≤ 64 characters (RFC 5321)
4. Update or add tests in security.test.ts covering edge cases: empty string, too-long addresses, single-char TLD, valid addresses
