# Dish 010: Add Request Body Size Limits

- **Cook Type:** sonnet
- **Complexity:** M
- **Godmother ID:** 2UxvLGwh
- **Dependencies:** none
- **Files:** packages/server/src/handler.ts
- **Verification:** bun test packages/server, bun run typecheck
- **Status:** queued

## Task Description

The `handleFetch` function in handler.ts passes request bodies directly to route handlers without any size limit. An attacker can send arbitrarily large POST bodies to exhaust server memory.

**Fix:**
1. Add a body size check early in `handleFetch` for all POST/PUT/PATCH requests
2. Check `Content-Length` header first (fast path — reject before reading body)
3. Default limit: 1MB for API routes, 50MB for attachment upload routes (if they exist)
4. Return 413 (Payload Too Large) with a clear error message when exceeded
5. Add a constant `MAX_BODY_SIZE` at the top of the file
6. Add tests for the size limit enforcement

**Important:** Check which routes expect large bodies (attachments, image uploads) and exempt or raise limits for those specifically. Don't break existing functionality.
