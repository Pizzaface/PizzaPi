# Dish 004: Security Response Headers (Chef's Special)

- **Cook Type:** sonnet
- **Complexity:** S
- **Godmother ID:** — (codebase exploration find)
- **Dependencies:** none
- **Priority:** P2
- **Status:** served

## Files
- `packages/server/src/handler.ts` (modify — add security headers to all responses)

## Verification
```bash
bun run typecheck
bun test packages/server
# Manual: curl -I http://localhost:3001/health and verify headers present
```

## Task Description

The server returns zero security headers on any response. No CSP, no X-Frame-Options, no X-Content-Type-Options, no Strict-Transport-Security.

**Add a middleware-style header injection** in `packages/server/src/handler.ts` to the `handleFetch` function. After generating the response, clone it and add security headers:

```
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
X-XSS-Protection: 0
Referrer-Policy: strict-origin-when-cross-origin
Permissions-Policy: camera=(), microphone=(), geolocation=()
```

**Note:** Do NOT add CSP yet — it's complex and could break Socket.IO, inline scripts, or the PWA service worker. A proper CSP needs careful audit. The headers above are safe, universal security hardening.

**Note:** Do NOT add HSTS — that should only be set when the server is known to be behind TLS. Let the reverse proxy handle it.

Keep it simple — just the 5 headers above on every response from handleFetch.
