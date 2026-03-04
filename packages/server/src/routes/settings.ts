/**
 * Settings router — user preferences (e.g. hidden models).
 */

import { requireSession } from "../middleware.js";
import { getHiddenModels, setHiddenModels } from "../user-hidden-models.js";
import type { RouteHandler } from "./types.js";

export const handleSettingsRoute: RouteHandler = async (req, url) => {
    if (url.pathname === "/api/settings/hidden-models" && req.method === "GET") {
        const identity = await requireSession(req);
        if (identity instanceof Response) return identity;

        const models = await getHiddenModels(identity.userId);
        return Response.json({ hiddenModels: models });
    }

    if (url.pathname === "/api/settings/hidden-models" && req.method === "PUT") {
        const identity = await requireSession(req);
        if (identity instanceof Response) return identity;

        let body: any = {};
        try {
            body = await req.json();
        } catch {
            body = {};
        }

        const hiddenModels = Array.isArray(body.hiddenModels)
            ? (body.hiddenModels as unknown[]).filter((x): x is string => typeof x === "string")
            : [];

        await setHiddenModels(identity.userId, hiddenModels);
        return Response.json({ ok: true, hiddenModels });
    }

    return undefined;
};
