/**
 * Central API dispatcher — chains domain-specific routers.
 *
 * Each router returns `Response | undefined`. The dispatcher tries routers in
 * order and returns the first non-undefined response. If no router matches,
 * it returns `undefined` so the caller (handler.ts) can fall through to static
 * files and eventually 404.
 */

import { getBundledVersion, getHubVersionInfo, getLatestNpmVersion } from "../version.js";
import { serverHealth } from "../health.js";
import { requireSession } from "../middleware.js";
import { handleAuthRoute } from "./auth.js";
import { handleRunnersRoute } from "./runners.js";
import { handleSessionsRoute } from "./sessions.js";
import { handleAttachmentsRoute } from "./attachments.js";
import { handlePushRoute } from "./push.js";
import { handleSettingsRoute } from "./settings.js";
import { handleMcpOAuthRoute } from "./mcp-oauth.js";
import { handleTunnelRoute } from "./tunnel.js";
import type { RouteHandler } from "./types.js";

/** All domain routers, tried in order. */
const routers: RouteHandler[] = [
    handleMcpOAuthRoute,   // Before auth — OAuth callback must be unauthenticated
    handleAuthRoute,
    handleTunnelRoute,     // Before runners — /api/tunnel/* is session-scoped, not runner-scoped
    handleRunnersRoute,
    handleSessionsRoute,
    handleAttachmentsRoute,
    handlePushRoute,
    handleSettingsRoute,
];

/**
 * Top-level API request handler.
 *
 * Handles a few global endpoints (/health, /api/version) directly, then
 * delegates to domain-specific routers.
 */
export async function handleApi(req: Request, url: URL): Promise<Response | undefined> {
    // ── Global endpoints (no auth required, no domain router) ──────────
    if (url.pathname === "/health") {
        const { redis, socketio, startedAt } = serverHealth;
        const ok = redis && socketio;
        return Response.json({
            status: ok ? "ok" : "degraded",
            redis,
            socketio,
            uptime: Math.floor((Date.now() - startedAt) / 1000),
        });
    }

    if (url.pathname === "/api/version" && req.method === "GET") {
        const latestVersion = await getLatestNpmVersion();
        return Response.json({
            version: latestVersion,
        });
    }

    // Hub image/version metadata — requires authentication to avoid
    // leaking registry details on the unauthenticated /api/version endpoint.
    if (url.pathname === "/api/hub-info" && req.method === "GET") {
        const auth = await requireSession(req);
        if (auth instanceof Response) return auth;
        const hub = getHubVersionInfo();
        let hubVersion = hub.version;
        if (!hubVersion) {
            // For source builds, `PIZZAPI_HUB_VERSION` is "local" so the hub
            // info is intentionally null.  Prefer the bundled package version
            // before hitting the npm registry so the dashboard reports the
            // actual build even when the hub is built from local source.
            const bundledVersion = getBundledVersion();
            hubVersion = bundledVersion ?? (await getLatestNpmVersion());
        }
        return Response.json({
            hubVersion,
            hubImage: hub.image,
        });
    }

    // ── Domain routers ─────────────────────────────────────────────────
    for (const router of routers) {
        const res = await router(req, url);
        if (res !== undefined) return res;
    }

    return undefined;
}

// Re-export parseJsonArray so existing test imports continue to work.
export { parseJsonArray } from "./utils.js";
