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

export const handleSessionsRoute: RouteHandler = async (req, url) => {
    if (url.pathname === "/api/sessions" && req.method === "GET") {
        const identity = await requireSession(req);
        if (identity instanceof Response) return identity;

        const includePersisted = shouldIncludePersistedSessions(url.searchParams.get("includePersisted"));

        if (!includePersisted) {
            const sessions = await getSessions(identity.userId);
            return Response.json({ sessions, persistedSessions: [] });
        }

        const [sessions, persistedSessions] = await Promise.all([
            getSessions(identity.userId),
            listPersistedRelaySessionsForUser(identity.userId),
        ]);

        return Response.json({ sessions, persistedSessions });
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
