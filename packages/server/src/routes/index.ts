/**
 * Central API dispatcher — chains domain-specific routers.
 *
 * Each router returns `Response | undefined`. The dispatcher tries routers in
 * order and returns the first non-undefined response. If no router matches,
 * it returns `undefined` so the caller (handler.ts) can fall through to static
 * files and eventually 404.
 */

import { getLatestNpmVersion } from "../version.js";
import { serverHealth } from "../health.js";
import { getServerRuntimeInfo } from "../runtime-version.js";
import { handleAuthRoute } from "./auth.js";
import { handleRunnersRoute } from "./runners.js";
import { handleSessionsRoute } from "./sessions.js";
import { handleAttachmentsRoute } from "./attachments.js";
import { handlePushRoute } from "./push.js";
import { handleSettingsRoute } from "./settings.js";
import { handleMcpOAuthRoute } from "./mcp-oauth.js";
import { handleTunnelRoute } from "./tunnel.js";
import { handleTriggersRoute } from "./triggers.js";
import { handleWebhooksRoute } from "./webhooks.js";
import type { RouteHandler } from "./types.js";

/** All domain routers, tried in order. */
const routers: RouteHandler[] = [
    handleMcpOAuthRoute,   // Before auth — OAuth callback must be unauthenticated
    handleAuthRoute,
    handleTunnelRoute,     // Before runners — /api/tunnel/* is session-scoped, not runner-scoped
    handleRunnersRoute,
    handleSessionsRoute,
    handleTriggersRoute,    // Before attachments — /api/sessions/:id/trigger
    handleWebhooksRoute,    // Webhook CRUD + fire endpoint
    handleAttachmentsRoute,
    handlePushRoute,
    handleSettingsRoute,
];

/**
 * Top-level API request handler.
 *
 * Handles a few global endpoints (/health, /status, /api/status, /api/version)
 * directly, then delegates to domain-specific routers.
 */
export async function handleApi(req: Request, url: URL): Promise<Response | undefined> {
    // ── Global endpoints (no auth required, no domain router) ──────────
    if (url.pathname === "/health" || url.pathname === "/status" || url.pathname === "/api/status") {
        const { redis, socketio, startedAt } = serverHealth;
        const ok = redis && socketio;
        const { serverVersion, socketProtocolVersion, buildTimestamp } = await getServerRuntimeInfo();
        return Response.json({
            status: ok ? "ok" : "degraded",
            redis,
            socketio,
            uptime: Math.floor((Date.now() - startedAt) / 1000),
            version: {
                server: serverVersion,
                socketProtocol: socketProtocolVersion,
                buildTimestamp,
            },
        });
    }

    if (url.pathname === "/api/version" && req.method === "GET") {
        const version = await getLatestNpmVersion();
        return Response.json({ version });
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
