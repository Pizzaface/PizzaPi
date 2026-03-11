1. **Analyze Vulnerability**
   - The `/api/register` endpoint in `packages/server/src/routes/auth.ts` uses `x-forwarded-for` to extract the client's IP address for rate limiting registration attempts.
   - However, `x-forwarded-for` can easily be spoofed by a malicious client because the application directly reads the header without first clearing it or getting it from a trusted proxy or the underlying socket.
   - Because the PizzaPi server uses a Node.js `IncomingMessage` to `fetch` `Request` adapter (`nodeReqToFetchRequest` in `packages/server/src/index.ts`), the actual socket IP is lost by the time the request reaches the route handler.

2. **Implement Fix**
   - In `packages/server/src/index.ts`, modify `nodeReqToFetchRequest` to:
     a) Read the actual client IP from `req.socket.remoteAddress`.
     b) Strip out any incoming spoofed `x-pizzapi-client-ip` headers from the request.
     c) Inject the trusted `req.socket.remoteAddress` into the `x-pizzapi-client-ip` header.
   - In `packages/server/src/security.ts`, add a `getClientIp` function that reads the `x-pizzapi-client-ip` header from a fetch `Request`.
   - In `packages/server/src/routes/auth.ts`, modify the rate limiting check to use `getClientIp` instead of reading `x-forwarded-for`.

3. **Verify Fix**
   - Run tests using `bun test`.
   - Ensure the build succeeds using `bun run build`.

4. **Complete pre-commit steps to ensure proper testing, verification, review, and reflection are done.**
   - Request review and submit.
