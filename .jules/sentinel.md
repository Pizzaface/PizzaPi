
## 2025-03-16 - Prevent IP spoofing in custom Fetch Request conversion
**Vulnerability:** The `nodeReqToFetchRequest` helper blindly passed through the `x-pizzapi-client-ip` header from incoming client requests. The `handleAuthRoute` then used an insecure method to extract client IPs (trusting `x-forwarded-for` blindly) for rate limiting. This allowed attackers to bypass rate limits by spoofing `x-pizzapi-client-ip` or `x-forwarded-for`.
**Learning:** Custom proxy layers or request adapters (like converting Node.js `IncomingMessage` to `Request`) must proactively strip custom headers used for internal routing/security before attaching their own trusted values derived from the TCP connection.
**Prevention:** Explicitly strip `x-pizzapi-client-ip` (and similar trusted headers) from client requests, set them securely using `req.socket.remoteAddress`, and use a shared, secure utility like `getClientIp` that respects proxy configurations (`PIZZAPI_TRUST_PROXY`).
## 2025-03-21 - Path Traversal in Static File Serving
**Vulnerability:** The `serveStaticFile` handler failed to decode URI components (`decodeURIComponent`) and check for null bytes (`\0`), allowing an attacker to use URL-encoded payloads (like `%2e%2e%2f`) to bypass the path prefix check and read arbitrary files on the host.
**Learning:** Path traversal defenses that rely on string prefix matching (e.g., `startsWith`) must operate on fully decoded strings and account for platform-specific path separators.
**Prevention:** Always apply `decodeURIComponent` before resolving file paths, explicitly reject null bytes (`\0`), and construct prefix checks using `path.sep` instead of hardcoded slashes.
