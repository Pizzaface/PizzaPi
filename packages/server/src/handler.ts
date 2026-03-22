import { getAuth, isSignupAllowed } from "./auth.js";
import { isValidPassword, PASSWORD_REQUIREMENTS_SUMMARY } from "@pizzapi/protocol";
import { handleApi } from "./routes/index.js";
import { serveStaticFile } from "./static.js";
import { getClientIp } from "./security.js";

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
            //
            // IMPORTANT: We mutate the headers on the original Request rather than
            // constructing `new Request(req, { headers })`. In Bun's node:http compat
            // layer, Requests created from a Node.js IncomingMessage carry a streaming
            // body; `new Request(original, { headers })` fails to transfer that body
            // (reads hang forever). Mutating in-place avoids the Bun bug entirely and
            // is safe here because we own the Headers object (created in
            // nodeReqToFetchRequest).
            const resolvedIp = getClientIp(req);
            req.headers.set("x-pizzapi-client-ip", resolvedIp);
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
