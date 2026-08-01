/**
 * Settings router — user preferences (e.g. hidden models).
 */

import { requireSession } from "../middleware.js";
import { getHiddenModels, setHiddenModels } from "../user-hidden-models.js";
import { getAllRunners } from "../ws/sio-state/index.js";
import { getConnectedSessionsForRunner } from "../ws/sio-registry/runners.js";
import { getLocalTuiSocket } from "../ws/sio-registry/sessions.js";
import { emitToRelaySession } from "../ws/sio-registry/context.js";
import { createLogger } from "@pizzapi/tools";
import type { RouteHandler } from "./types.js";

const log = createLogger("settings");

/**
 * Best-effort push of the updated hidden-model list to every running worker
 * session owned by the user, so mid-conversation model switching, cycling,
 * and the list_models tool reflect the change without a restart.
 */
async function pushHiddenModelsToUserSessions(userId: string, hiddenModels: string[]): Promise<void> {
    try {
        const runners = await getAllRunners(userId);
        for (const runner of runners) {
            const sessions = await getConnectedSessionsForRunner(runner.runnerId).catch(() => []);
            for (const { sessionId } of sessions) {
                const tuiSocket = getLocalTuiSocket(sessionId);
                if (tuiSocket) {
                    tuiSocket.emit("hidden_models_update" as string, { hiddenModels });
                } else {
                    // Cross-node: route through the relay adapter.
                    emitToRelaySession(sessionId, "hidden_models_update", { hiddenModels });
                }
            }
        }
    } catch (err) {
        log.warn("Failed to push hidden models to sessions:", err);
    }
}

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
        void pushHiddenModelsToUserSessions(identity.userId, hiddenModels);
        return Response.json({ ok: true, hiddenModels });
    }

    return undefined;
};
