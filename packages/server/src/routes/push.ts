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
} from "../push.js";
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

    return undefined;
};
