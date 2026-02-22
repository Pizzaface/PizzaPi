## 2025-02-18 - Cross-Site WebSocket Hijacking in Live Share
**Vulnerability:** WebSocket upgrade endpoints `/ws/sessions/{sessionId}` and `/ws/hub` relied on cookie-based authentication but did not validate the `Origin` header, allowing malicious sites to hijack the connection via CSWSH.
**Learning:** `Bun.serve` and manual WebSocket upgrade handlers do not automatically check `Origin` or CSRF tokens. `better-auth` secures HTTP APIs but does not extend protection to manual WebSocket upgrades.
**Prevention:** Explicitly validate `req.headers.get("Origin")` against a trusted list (like `trustedOrigins` from `auth.ts`) in the WebSocket upgrade handler for any endpoint using cookie or implicit authentication.
