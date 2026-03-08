import { getAuth, isSignupAllowed } from "./auth.js";
import { isValidPassword, PASSWORD_REQUIREMENTS_SUMMARY } from "@pizzapi/protocol";
import { RateLimiter, getClientIp } from "./security.js";
import { handleApi } from "./routes/index.js";
import { serveStaticFile } from "./static.js";

/**
 * Fetch-style request handler (REST + auth + static).
 * Extracted so it can be used both by the production server and integration tests.
 */
// 10 requests per 15 minutes for sign-ins to prevent brute force/credential stuffing
const signInRateLimiter = new RateLimiter(10, 15 * 60 * 1000);

export async function handleFetch(req: Request): Promise<Response> {
    const url = new URL(req.url);

    // ── better-auth handler ────────────────────────────────────────────────
    if (url.pathname.startsWith("/api/auth")) {
        // Guard against brute force attacks on the sign-in endpoint
        if (url.pathname === "/api/auth/sign-in/email" && req.method === "POST") {
            const clientIp = getClientIp(req);
            if (!signInRateLimiter.check(clientIp)) {
                return Response.json(
                    { error: "Too many sign-in attempts. Please try again later." },
                    { status: 429 },
                );
            }
        }

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
            return await getAuth().handler(req);
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
