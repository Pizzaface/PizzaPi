# Dish 008: Add Rate Limiting to /api/chat

- **Cook Type:** sonnet
- **Complexity:** M
- **Godmother ID:** BfJvTzK0
- **Dependencies:** none
- **Files:** packages/server/src/routes/chat.ts, packages/server/src/security.ts
- **Verification:** bun test packages/server, bun run typecheck
- **Status:** queued

## Task Description

The `/api/chat` endpoint creates a new Agent instance per request with no rate limiting. This is a P1 resource exhaustion vector — each request spawns an AI completion.

**Fix:**
1. Import the existing `RateLimiter` class from `security.ts`
2. Create a rate limiter instance for the chat endpoint — suggest 10 requests per minute per user
3. Apply rate limiting at the top of `handleChatRoute`, after auth check but before processing
4. Return 429 with `Retry-After` header when rate limited
5. Add tests for the rate limiting behavior

**Important:** Use the EXISTING `RateLimiter` class — do not create a new rate limiting mechanism. The rate limiter keys on IP; for authenticated endpoints, consider keying on user ID instead (from the `identity` returned by `requireSession`).
