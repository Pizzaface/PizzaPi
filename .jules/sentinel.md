
## 2025-03-16 - Prevent IP spoofing in custom Fetch Request conversion
**Vulnerability:** The `nodeReqToFetchRequest` helper blindly passed through the `x-pizzapi-client-ip` header from incoming client requests. The `handleAuthRoute` then used an insecure method to extract client IPs (trusting `x-forwarded-for` blindly) for rate limiting. This allowed attackers to bypass rate limits by spoofing `x-pizzapi-client-ip` or `x-forwarded-for`.
**Learning:** Custom proxy layers or request adapters (like converting Node.js `IncomingMessage` to `Request`) must proactively strip custom headers used for internal routing/security before attaching their own trusted values derived from the TCP connection.
**Prevention:** Explicitly strip `x-pizzapi-client-ip` (and similar trusted headers) from client requests, set them securely using `req.socket.remoteAddress`, and use a shared, secure utility like `getClientIp` that respects proxy configurations (`PIZZAPI_TRUST_PROXY`).
