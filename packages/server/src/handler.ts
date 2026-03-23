import { getAuth, isSignupAllowed } from "./auth.js";
import { isValidPassword, PASSWORD_REQUIREMENTS_SUMMARY } from "@pizzapi/protocol";
import { handleApi } from "./routes/index.js";
import { serveStaticFile } from "./static.js";
import { getClientIp } from "./security.js";

/**
 * Clone a Response and inject the standard security headers.
 * Called on every response returned by handleFetch.
 * Exported for testing.
 */
export function withSecurityHeaders(res: Response): Response {
    const headers = new Headers(res.headers);
    headers.set("X-Content-Type-Options", "nosniff");
    headers.set("X-Frame-Options", "DENY");
    headers.set("X-XSS-Protection", "0");
    headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
    headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

/**
 * Fetch-style request handler (REST + auth + static).
 * Extracted so it can be used both by the production server and integration tests.
 */
export async function handleFetch(req: Request): Promise<Response> {
    const res = await _handleFetch(req);
    return withSecurityHeaders(res);
}

async function _handleFetch(req: Request): Promise<Response> {
    const url = new URL(req.url);

    // ── better-auth handler ────────────────────────────────────────────────
    if (url.pathname.startsWith("/api/auth")) {
        // Block signup when signups are disabled (after first user).
        if (url.pathname === "/api/auth/sign-up/email" && req.method === "POST") {
            const allowed = await isSignupAllowed();
            if (!allowed) {
                return Response.json(
                    { error: "Signups are disabled. Contact the administrator." },
                    { status: 403 },
                );
            }
        }

        // Enforce password policy on change-password requests.
        if (url.pathname === "/api/auth/change-password" && req.method === "POST") {
            try {
                const cloned = req.clone();
                const body = await cloned.json() as { newPassword?: string };
                if (body.newPassword && !isValidPassword(body.newPassword)) {
                    return Response.json(
                        { error: PASSWORD_REQUIREMENTS_SUMMARY },
                        { status: 400 },
                    );
                }
            } catch {
                // Let better-auth handle malformed bodies.
            }
        }

        try {
            // Rewrite x-pizzapi-client-ip with the fully-resolved client IP (accounting
            // for trusted reverse-proxy hops via getClientIp) before handing off to
            // Better Auth. Better Auth is configured to key its built-in rate limiter on
            // x-pizzapi-client-ip (see auth.ts advanced.ipAddress.ipAddressHeaders), so
            // this ensures per-client rate limiting works correctly in proxy deployments
            // while remaining immune to X-Forwarded-For spoofing.
            const resolvedIp = getClientIp(req);
            const authHeaders = new Headers(req.headers);
            authHeaders.set("x-pizzapi-client-ip", resolvedIp);
            const authReq = new Request(req, { headers: authHeaders });
            return await getAuth().handler(authReq);
        } catch (e) {
            console.error("[auth] handler threw:", e);
            return Response.json({ error: "Auth error" }, { status: 500 });
        }
    }

    // ── REST endpoints ─────────────────────────────────────────────────────
    try {
        const res = await handleApi(req, url);
        if (res !== undefined) return res;
    } catch (e) {
        console.error("[api] handleApi threw:", e);
        return Response.json({ error: "Internal server error" }, { status: 500 });
    }

    // ── Static UI files (SPA fallback) ───────────────────────────────────
    const staticRes = await serveStaticFile(url.pathname);
    if (staticRes) return staticRes;

    return Response.json({ error: "Not found" }, { status: 404 });
}
