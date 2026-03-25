/**
 * Tunnel HTTP proxy route — /api/tunnel/:sessionId/:port/*
 *
 * Translates an authenticated viewer's HTTP request into a tunnel_request
 * Socket.IO event sent to the runner daemon, then writes the tunnel_response
 * back as an HTTP response.
 *
 * Option C limitations (documented intentionally):
 *   - No WebSocket upgrade (no HMR, no Socket.IO through tunnel)
 *   - No streaming responses (body fully buffered, max 10 MB)
 *   - No SSE support
 *   - No CORS handling beyond header passthrough
 *   - Not suitable for large file downloads (>10 MB)
 */

import { requireSession } from "../middleware.js";
import { getSession } from "../ws/sio-state.js";
import { sendTunnelRequest } from "../ws/namespaces/runner.js";
import type { RouteHandler } from "./types.js";

/** Maximum request body size for tunnel proxying (10 MB). */
const MAX_TUNNEL_BODY_SIZE = 10 * 1024 * 1024;

/** Pattern: /api/tunnel/:sessionId/:port/<rest> */
const TUNNEL_PATH_RE = /^\/api\/tunnel\/([^/]+)\/(\d+)(\/.*)?$/;

/**
 * Tunnel route handler.
 *
 * Auth: the caller must be authenticated (session cookie or API key) AND must
 * either own the session or the session must be accessible (viewable) by them.
 * For now we require session ownership (userId match) since tunnels expose the
 * runner's localhost — they should not be openly accessible to all viewers.
 */
export const handleTunnelRoute: RouteHandler = async (req, url) => {
    const match = url.pathname.match(TUNNEL_PATH_RE);
    if (!match) return undefined;

    const method = req.method.toUpperCase();
    if (!["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"].includes(method)) {
        return new Response("Method not allowed", {
            status: 405,
            headers: { Allow: "GET, POST, PUT, DELETE, PATCH, HEAD, OPTIONS" },
        });
    }

    // ── Authenticate caller ──────────────────────────────────────────────────
    const identity = await requireSession(req);
    if (identity instanceof Response) return identity;

    // ── Parse path segments ──────────────────────────────────────────────────
    const sessionId = decodeURIComponent(match[1]);
    const port = parseInt(match[2], 10);
    const proxyPath = match[3] ?? "/";

    if (!sessionId) {
        return Response.json({ error: "Missing session ID" }, { status: 400 });
    }

    if (!Number.isFinite(port) || port < 1 || port > 65535) {
        return Response.json({ error: "Invalid port" }, { status: 400 });
    }

    // Reconstruct proxy path with query string
    const pathWithQuery = url.search ? `${proxyPath}${url.search}` : proxyPath;

    // ── Look up session and verify ownership ─────────────────────────────────
    const sessionData = await getSession(sessionId);
    if (!sessionData) {
        return Response.json({ error: "Session not found" }, { status: 404 });
    }

    // Only the session owner may access the tunnel — it exposes localhost
    if (sessionData.userId && sessionData.userId !== identity.userId) {
        return Response.json({ error: "Forbidden" }, { status: 403 });
    }

    const runnerId = sessionData.runnerId;
    if (!runnerId) {
        return Response.json({ error: "Session has no runner" }, { status: 503 });
    }

    // ── Read and enforce body size limit ─────────────────────────────────────
    let bodyBase64: string | undefined;
    if (req.body && method !== "GET" && method !== "HEAD") {
        const bodyBuffer = await req.arrayBuffer();
        if (bodyBuffer.byteLength > MAX_TUNNEL_BODY_SIZE) {
            return Response.json(
                { error: `Request body exceeds ${MAX_TUNNEL_BODY_SIZE / 1024 / 1024} MB limit` },
                { status: 413 },
            );
        }
        if (bodyBuffer.byteLength > 0) {
            bodyBase64 = Buffer.from(bodyBuffer).toString("base64");
        }
    }

    // ── Forward headers (strip hop-by-hop and host) ───────────────────────────
    const HOP_BY_HOP = new Set([
        "connection",
        "keep-alive",
        "transfer-encoding",
        "te",
        "trailer",
        "upgrade",
        "proxy-authorization",
        "proxy-authenticate",
        // Rewrite host to 127.0.0.1:{port} in the runner
        "host",
    ]);

    const forwardHeaders: Record<string, string> = {};
    req.headers.forEach((v, k) => {
        if (!HOP_BY_HOP.has(k.toLowerCase())) forwardHeaders[k] = v;
    });

    // ── Build requestId and emit tunnel_request ───────────────────────────────
    const requestId = `${sessionId}-${port}-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    let tunnelResponse;
    try {
        tunnelResponse = await sendTunnelRequest(runnerId, {
            requestId,
            port,
            method,
            path: pathWithQuery,
            headers: forwardHeaders,
            body: bodyBase64,
        });
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("not connected") || msg.includes("disconnected")) {
            return Response.json({ error: "Runner not available" }, { status: 503 });
        }
        if (msg.includes("timed out")) {
            return Response.json({ error: "Tunnel request timed out" }, { status: 504 });
        }
        return Response.json({ error: `Tunnel error: ${msg}` }, { status: 502 });
    }

    // ── Write response back to viewer ─────────────────────────────────────────
    const responseBody = Buffer.from(tunnelResponse.body, "base64");

    const responseHeaders = new Headers();
    for (const [k, v] of Object.entries(tunnelResponse.headers)) {
        try {
            responseHeaders.set(k, v);
        } catch {
            // Skip headers that are invalid in the Headers API
        }
    }

    return new Response(responseBody, {
        status: tunnelResponse.status,
        headers: responseHeaders,
    });
};
