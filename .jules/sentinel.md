## 2026-03-02 - [CRITICAL/HIGH] Fix authentication rate limiting

**Vulnerability:** Missing rate limiting on the `/api/auth/sign-in/email` authentication endpoint.
**Learning:** This exposes the application to brute-force and credential-stuffing attacks. Even though the `better-auth` handler is abstracted, an IP-based rate limiter needs to be placed at the request entry point before invoking it.
**Prevention:** Apply a rate limiter checking the `x-forwarded-for` HTTP header on POST requests to authentication endpoints.
