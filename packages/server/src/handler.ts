import { getAuth, isSignupAllowed } from "./auth.js";
import { isValidPassword, PASSWORD_REQUIREMENTS_SUMMARY } from "@pizzapi/protocol";
import { handleApi } from "./routes/index.js";
import { serveStaticFile } from "./static.js";
import { getClientIp } from "./security.js";

/** Default body size limit for API routes (1 MB). */
export const MAX_BODY_SIZE = 1 * 1024 * 1024;

/** Body size limit for attachment upload routes (50 MB). */
export const MAX_ATTACHMENT_BODY_SIZE = 50 * 1024 * 1024;

/**
 * Returns true if the URL path is an attachment upload route.
 * Pattern: POST /api/sessions/:id/attachments
 */
function isAttachmentUploadPath(pathname: string, method: string): boolean {
    return (
        method === "POST" &&
        /^\/api\/sessions\/[^/]+\/attachments$/.test(pathname)
    );
}

/**
 * Enforces body size limits for POST/PUT/PATCH requests.
 *
 * - If Content-Length is present, it is validated with strict digits-only parsing.
 *   Malformed values (e.g. "1abc") are rejected with 400.
 *   Values exceeding the limit are rejected with 413.
 * - If Content-Length is absent (e.g. chunked transfer encoding), the request
 *   body is consumed via a streaming reader and rejected with 413 if the total
 *   bytes read exceed the limit.  The buffered bytes are then reassembled into
 *   a new Request so downstream handlers can still call req.json() / req.formData().
 *
 * Returns either a Response (error) or the Request to continue with.
 */
async function enforceBodySizeLimit(req: Request, url: URL): Promise<Response | Request> {
    const method = req.method;
    if (method !== "POST" && method !== "PUT" && method !== "PATCH") {
        return req;
    }

    const limit = isAttachmentUploadPath(url.pathname, method)
        ? MAX_ATTACHMENT_BODY_SIZE
        : MAX_BODY_SIZE;

    const contentLengthHeader = req.headers.get("content-length");

    if (contentLengthHeader !== null) {
        // Strict digits-only validation — rejects malformed values like "1abc"
        if (!/^\d+$/.test(contentLengthHeader)) {
            return Response.json(
                { error: "Bad Request: malformed Content-Length header" },
                { status: 400 },
            );
        }
        const contentLength = parseInt(contentLengthHeader, 10);
        if (!Number.isFinite(contentLength) || contentLength < 0) {
            return Response.json(
                { error: "Bad Request: invalid Content-Length header" },
                { status: 400 },
            );
        }
        if (contentLength > limit) {
            return Response.json(
                { error: `Payload Too Large: body exceeds ${limit} bytes` },
                { status: 413 },
            );
        }
        return req;
    }

    // No Content-Length header — enforce limit via streaming byte-counter.
    // This covers chunked transfer encoding and any other scenario where a body
    // is present but the header is absent, which would otherwise bypass the
    // fast-path check above.
    if (!req.body) {
        return req;
    }

    const reader = req.body.getReader();
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;

    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            totalBytes += value.byteLength;
            if (totalBytes > limit) {
                reader.cancel().catch(() => undefined);
                return Response.json(
                    { error: `Payload Too Large: body exceeds ${limit} bytes` },
                    { status: 413 },
                );
            }
            chunks.push(value);
        }
    } catch {
        reader.cancel().catch(() => undefined);
        return Response.json(
            { error: "Bad Request: failed to read request body" },
            { status: 400 },
        );
    }

    // Reassemble the buffered bytes and reconstruct the request so downstream
    // handlers can still call req.json() / req.formData() etc.
    const buffered = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
        buffered.set(chunk, offset);
        offset += chunk.byteLength;
    }

    return new Request(req, { body: buffered.buffer as ArrayBuffer });
}

/**
 * Fetch-style request handler (REST + auth + static).
 * Extracted so it can be used both by the production server and integration tests.
 */
export async function handleFetch(req: Request): Promise<Response> {
    const url = new URL(req.url);

    // ── Body size guard ────────────────────────────────────────────────
    // Validates Content-Length when present (strict numeric parsing) and falls
    // back to a streaming byte-counter when Content-Length is absent, so that
    // chunked-encoding or header-omitting requests cannot bypass the limit.
    const sizeResult = await enforceBodySizeLimit(req, url);
    if (sizeResult instanceof Response) return sizeResult;
    req = sizeResult; // may be a new Request wrapping the pre-buffered body

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
