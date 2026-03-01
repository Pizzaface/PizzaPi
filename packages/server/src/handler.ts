import { getAuth, isSignupAllowed } from "./auth.js";
import { handleApi } from "./routes/api.js";
import { serveStaticFile } from "./static.js";

/**
 * Fetch-style request handler (REST + auth + static).
 * Extracted so it can be used both by the production server and integration tests.
 */
export async function handleFetch(req: Request): Promise<Response> {
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
