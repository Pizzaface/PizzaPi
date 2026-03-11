## 2024-03-11 - [High] Fix Rate Limiter IP Spoofing via X-Forwarded-For

**Vulnerability:**
The `/api/register` rate limiting logic relied entirely on `req.headers.get("x-forwarded-for")` to determine the client IP address. Because this Node.js application is a REST + Socket.IO server utilizing an internal Node `IncomingMessage` to `fetch` `Request` adapter, the original TCP socket IP was not being properly forwarded. Since standard header access is blindly trusted, any malicious client could manually spoof the `X-Forwarded-For` header to bypass the rate limiter.

**Learning:**
In custom adapter architectures (Node.js `IncomingMessage` -> `Request`), the raw TCP `socket.remoteAddress` must be securely tunneled as a custom internal header. Simply checking for external headers like `X-Forwarded-For` without validating or dropping incoming copies makes the application vulnerable to basic HTTP header injection and IP spoofing.

**Prevention:**
Always use an authenticated or explicitly validated internal header mechanism (e.g., `x-pizzapi-client-ip`) to securely pass the real socket IP. Ensure that the ingestion point (the adapter) explicitly drops any incoming headers of the same name before populating the true connection IP from `req.socket.remoteAddress`. Utilize helper functions (like `getClientIp`) instead of querying raw external proxy headers.
