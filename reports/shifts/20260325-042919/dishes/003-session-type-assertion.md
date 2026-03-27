# Dish 003: Fix `(session as any).user` Type Assertion in App.tsx

- **Cook Type:** sonnet
- **Complexity:** M
- **Priority:** P2
- **Godmother ID:** IBj63TgN
- **Dependencies:** none
- **Files:** packages/ui/src/App.tsx, packages/ui/src/lib/auth-client.ts
- **Verification:** bun run typecheck; bun test packages/ui
- **Status:** queued
- **Confidence Band:** B
- **dispatchPriority:** normal

## Task Description

In `packages/ui/src/App.tsx`, the `useSession()` hook from better-auth is used at line 108:
```ts
const { data: session, isPending } = useSession();
```

But there are two places where the session's `user` property is accessed via unsafe type casts:

**Line 136:**
```ts
const userId = session && typeof session === "object" ? (session as any).user?.id : null;
```

**Line 3171:**
```ts
const rawUser = session && typeof session === "object" ? (session as any).user : undefined;
const userName = rawUser && typeof rawUser.name === "string" ? (rawUser.name as string) : "";
const userEmail = rawUser && typeof rawUser.email === "string" ? (rawUser.email as string) : "";
```

The `(session as any)` casts are needed because the TypeScript return type of `useSession()` from better-auth's `createAuthClient` does not expose a `user` property typed shape.

**Investigation needed first:**
1. Check what `useSession` returns at runtime vs what TypeScript says it returns
2. Check if better-auth exports a `Session` type that includes `user: { id, name, email }`
3. Options:
   a. **Extract type from better-auth** — `typeof authClient.$Infer.Session` or similar better-auth type inference
   b. **Create a local type guard** — `function getSessionUser(session: unknown): { id?: string; name?: string; email?: string } | null`
   c. **Declare a module augmentation** — add a `user` property to the better-auth session type
   d. **Use a typed wrapper** — create `useTypedSession()` that returns the correct shape

**Steps:**
1. Branch: `git checkout -b fix/session-user-type-assertion`
2. Inspect the better-auth types: run `grep -r "Session\|useSession" node_modules/better-auth/dist/*.d.ts | head -40` to understand the exported type
3. Also check: `grep -r "user" node_modules/better-auth/dist/*.d.ts | head -20`
4. Pick the cleanest fix that eliminates `(session as any)`:
   - If better-auth exports the session type with user, use it
   - Otherwise, create a simple typed helper in `packages/ui/src/lib/auth-client.ts`
5. Update both occurrences in App.tsx
6. Run: `bun run typecheck` — zero errors (zero, not "no new errors")
7. Run: `bun test packages/ui`
8. Commit: `fix(ui): replace (session as any) casts with proper better-auth session type`
9. Push and open a PR

## Investigation Hints

better-auth's `createAuthClient` returns a typed client. The session type can often be inferred via:
```ts
type AuthSession = typeof authClient.$Infer.Session;
```

Or the session data type is typically:
```ts
type SessionData = {
  user: { id: string; name: string; email: string; ... };
  session: { ... };
}
```

Check the better-auth docs/types to confirm the correct inference path.

## Acceptance Criteria
- No `(session as any)` casts in App.tsx
- `bun run typecheck` exits with code 0
- The user's `id`, `name`, and `email` are accessed with proper TypeScript types
- The sidebar cache key generation still works correctly (still uses user ID for cross-account isolation)

## Health Inspection — 2026-03-25T11:46Z
- **Inspector Model:** claude-sonnet-4-6 (Anthropic)
- **Verdict:** CITATION
- **Findings:** P3 — `App.tsx:136`: replacement cast `(session as BetterAuthSession | null)` may be unnecessary; `session?.user?.id` already compiles without a cast at lines 111–112. No functional impact — cast is to the correct type, not `any`.
- **Critic Missed:** This P3 residual type-assertion noise.
