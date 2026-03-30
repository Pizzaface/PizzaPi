/**
 * Push router — Web Push notification subscription management.
 */

import { requireSession } from "../middleware.js";
import {
    getVapidPublicKey,
    subscribePush,
    unsubscribePush,
    getSubscriptionsForUser,
    updateEnabledEvents,
    updateSuppressChildNotifications,
    isValidPushEndpoint,
} from "../push.js";
import { getSharedSession, getLocalTuiSocket } from "../ws/sio-registry.js";
import { getPushPendingQuestion, consumePushPendingQuestionIfMatches } from "../ws/sio-state/index.js";
import type { RouteHandler } from "./types.js";

export const handlePushRoute: RouteHandler = async (req, url) => {
    if (url.pathname === "/api/push/vapid-public-key" && req.method === "GET") {
        return Response.json({ publicKey: getVapidPublicKey() });
    }

    if (url.pathname === "/api/push/subscribe" && req.method === "POST") {
        const identity = await requireSession(req);
        if (identity instanceof Response) return identity;

        const body = (await req.json()) as {
            endpoint?: string;
            keys?: { p256dh?: string; auth?: string };
            enabledEvents?: string;
        };

        if (!body.endpoint || !body.keys?.p256dh || !body.keys?.auth) {
            return Response.json(
                { error: "Missing required fields: endpoint, keys.p256dh, keys.auth" },
                { status: 400 },
            );
        }

        if (!isValidPushEndpoint(body.endpoint)) {
            return Response.json(
                { error: "Invalid push endpoint: must be an https:// URL not targeting private/loopback addresses" },
                { status: 400 },
            );
        }

        const id = await subscribePush({
            userId: identity.userId,
            endpoint: body.endpoint,
            keys: { p256dh: body.keys.p256dh, auth: body.keys.auth },
            enabledEvents: body.enabledEvents,
        });

        return Response.json({ ok: true, id });
    }

    if (url.pathname === "/api/push/unsubscribe" && req.method === "POST") {
        const identity = await requireSession(req);
        if (identity instanceof Response) return identity;

        const body = (await req.json()) as { endpoint?: string };
        if (!body.endpoint) {
            return Response.json({ error: "Missing endpoint" }, { status: 400 });
        }

        await unsubscribePush(identity.userId, body.endpoint);
        return Response.json({ ok: true });
    }

    if (url.pathname === "/api/push/subscriptions" && req.method === "GET") {
        const identity = await requireSession(req);
        if (identity instanceof Response) return identity;

        const subs = await getSubscriptionsForUser(identity.userId);
        return Response.json({
            subscriptions: subs.map((s) => ({
                id: s.id,
                endpoint: s.endpoint,
                createdAt: s.createdAt,
                enabledEvents: s.enabledEvents,
                suppressChildNotifications: !!s.suppressChildNotifications,
            })),
        });
    }

    if (url.pathname === "/api/push/events" && req.method === "PUT") {
        const identity = await requireSession(req);
        if (identity instanceof Response) return identity;

        const body = (await req.json()) as { endpoint?: string; enabledEvents?: string };
        if (!body.endpoint || !body.enabledEvents) {
            return Response.json({ error: "Missing endpoint or enabledEvents" }, { status: 400 });
        }

        await updateEnabledEvents(identity.userId, body.endpoint, body.enabledEvents);
        return Response.json({ ok: true });
    }

    if (url.pathname === "/api/push/child-notifications" && req.method === "PUT") {
        const identity = await requireSession(req);
        if (identity instanceof Response) return identity;

        const body = (await req.json()) as { endpoint?: string; suppress?: boolean };
        if (!body.endpoint || typeof body.suppress !== "boolean") {
            return Response.json({ error: "Missing endpoint or suppress (boolean)" }, { status: 400 });
        }

        const updated = await updateSuppressChildNotifications(identity.userId, body.endpoint, body.suppress);
        if (updated === 0) {
            return Response.json({ error: "No matching subscription found for this endpoint" }, { status: 404 });
        }
        return Response.json({ ok: true });
    }

    // ── Answer a push-notification question ────────────────────────────
    if (url.pathname === "/api/push/answer" && req.method === "POST") {
        const identity = await requireSession(req);
        if (identity instanceof Response) return identity;

        let body: { sessionId?: string; text?: string; toolCallId?: string };
        try {
            const parsed = await req.json();
            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
                return Response.json({ error: "Invalid JSON body" }, { status: 400 });
            }
            body = parsed;
        } catch {
            return Response.json({ error: "Invalid JSON body" }, { status: 400 });
        }

        if (
            typeof body.sessionId !== "string" || !body.sessionId.trim() ||
            typeof body.text !== "string" || !body.text.trim() ||
            typeof body.toolCallId !== "string" || !body.toolCallId.trim()
        ) {
            return Response.json(
                { error: "Missing required fields: sessionId, text, toolCallId" },
                { status: 400 },
            );
        }

        // Verify the session belongs to this user
        const session = await getSharedSession(body.sessionId);
        if (!session || session.userId !== identity.userId) {
            return Response.json({ error: "Session not found" }, { status: 404 });
        }

        // Require collab mode (same as viewer input)
        if (!session.collabMode) {
            return Response.json(
                { error: "Session is not in collab mode" },
                { status: 403 },
            );
        }

        // Pre-flight: verify a question is pending (non-destructive read)
        const pendingToolCallId = await getPushPendingQuestion(body.sessionId);
        if (!pendingToolCallId) {
            return Response.json(
                { error: "No question is currently pending for this session" },
                { status: 409 },
            );
        }
        if (body.toolCallId !== pendingToolCallId) {
            return Response.json(
                { error: "This answer does not match the current pending question" },
                { status: 409 },
            );
        }

        // Verify the TUI socket is available BEFORE consuming the token.
        // If the runner is disconnected we return 502 without burning the
        // pending key, so the user can retry when the runner reconnects.
        const tuiSocket = getLocalTuiSocket(body.sessionId);
        if (!tuiSocket) {
            return Response.json(
                { error: "Session runner not connected to this server" },
                { status: 502 },
            );
        }

        // Atomically consume the pending key (compare-and-delete via Lua).
        // Only succeeds if the toolCallId still matches — prevents replays
        // and races with other requests.
        const consumed = await consumePushPendingQuestionIfMatches(body.sessionId, body.toolCallId);
        if (!consumed) {
            return Response.json(
                { error: "Answer already submitted or question resolved" },
                { status: 409 },
            );
        }

        tuiSocket.emit("input" as string, {
            text: body.text.trim(),
            client: "push",
        });

        return Response.json({ ok: true });
    }

    return undefined;
};
