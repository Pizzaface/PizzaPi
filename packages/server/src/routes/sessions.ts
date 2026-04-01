/**
 * Sessions router — session listing and pin/unpin management.
 */

import { requireSession } from "../middleware.js";
import { getSessions } from "../ws/sio-registry.js";
import {
    listPersistedRelaySessionsForUser,
    listPinnedRelaySessionsForUser,
    pinRelaySession,
    unpinRelaySession,
} from "../sessions/store.js";
import type { RouteHandler } from "./types.js";

export function shouldIncludePersistedSessions(param: string | null | undefined): boolean {
    const normalized = param?.trim().toLowerCase();
    return !(normalized === "0" || normalized === "false" || normalized === "no");
}

export const DEFAULT_PERSISTED_LIMIT = 20;
export const MAX_PERSISTED_LIMIT = 100;

export function clampLimit(raw: string | null | undefined): number {
    if (!raw) return DEFAULT_PERSISTED_LIMIT;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_PERSISTED_LIMIT;
    return Math.min(parsed, MAX_PERSISTED_LIMIT);
}

export const handleSessionsRoute: RouteHandler = async (req, url) => {
    if (url.pathname === "/api/sessions" && req.method === "GET") {
        const identity = await requireSession(req);
        if (identity instanceof Response) return identity;

        const includePersisted = shouldIncludePersistedSessions(url.searchParams.get("includePersisted"));

        if (!includePersisted) {
            const sessions = await getSessions(identity.userId);
            return Response.json({ sessions, persistedSessions: [], nextCursor: null });
        }

        const limit = clampLimit(url.searchParams.get("limit"));
        const cursor = url.searchParams.get("cursor") || undefined;

        const [sessions, paginated] = await Promise.all([
            getSessions(identity.userId),
            listPersistedRelaySessionsForUser(identity.userId, limit, cursor),
        ]);

        return Response.json({
            sessions,
            persistedSessions: paginated.sessions,
            nextCursor: paginated.nextCursor,
        });
    }

    if (url.pathname === "/api/sessions/pinned" && req.method === "GET") {
        const identity = await requireSession(req);
        if (identity instanceof Response) return identity;

        const pinnedSessions = await listPinnedRelaySessionsForUser(identity.userId);
        return Response.json({ pinnedSessions });
    }

    // ── Pin / unpin a session ──────────────────────────────────────────
    const pinMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/pin$/);
    if (pinMatch) {
        if (req.method !== "PUT" && req.method !== "DELETE") {
            return new Response("Method not allowed", {
                status: 405,
                headers: { Allow: "PUT, DELETE" },
            });
        }

        const identity = await requireSession(req);
        if (identity instanceof Response) return identity;

        const sessionId = decodeURIComponent(pinMatch[1]);
        if (!sessionId) {
            return Response.json({ error: "Missing session ID" }, { status: 400 });
        }

        if (req.method === "PUT") {
            const ok = await pinRelaySession(sessionId, identity.userId);
            if (!ok) {
                return Response.json({ error: "Session not found or not owned by you" }, { status: 404 });
            }
            return Response.json({ ok: true, isPinned: true });
        }

        const ok = await unpinRelaySession(sessionId, identity.userId);
        if (!ok) {
            return Response.json({ error: "Session not found or not owned by you" }, { status: 404 });
        }
        return Response.json({ ok: true, isPinned: false });
    }

    return undefined;
};
