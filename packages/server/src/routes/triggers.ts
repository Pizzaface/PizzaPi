/**
 * Triggers router — session-control HTTP APIs + trigger history reads.
 *
 * (Fire paths and subscription CRUD moved to the unified engine — see
 * routes/events.ts: POST /api/events, /api/routes, /api/deliveries.)
 *
 * POST /api/sessions/:id/model
 *   Switches a live session's model. HTTP equivalent of the viewer's
 *   `model_set` socket event, so runner services (the Discord bridge's
 *   /models command) can drive it with an API key.
 *   Body: { provider, modelId }. Requires collab mode; hidden models are blocked.
 *
 * POST /api/sessions/:id/abort
 *   Stops the session's current generation. HTTP equivalent of the viewer's
 *   Esc → exec abort, so runner services can drive it with an API key.
 *
 * POST /api/sessions/:id/thinking
 *   Sets the session's thinking/reasoning effort level. HTTP equivalent of
 *   the viewer's exec set_thinking_level. Body: { level }.
 *
 * GET /api/sessions/:id/triggers
 *   Lists recent triggers for a session (from Redis trigger history).
 *   DELETE on the same path clears it (used when a session restarts).
 *
 * GET /api/sessions/:id/available-triggers
 *   Returns trigger defs from the session's runner (what can be subscribed to).
 *
 * GET /api/sessions/:id/available-sigils
 *   Returns sigil defs from the session's runner.
 */

import { requireSession, validateApiKey } from "../middleware.js";
import { getHiddenModels } from "../user-hidden-models.js";
import { isHiddenModel } from "./model-guard.js";
import {
    getSharedSession,
    getLocalTuiSocket,
    broadcastToSessionViewers,
    emitToRelaySessionVerified,
} from "../ws/sio-registry.js";
import { getRunnerServices } from "../ws/sio-registry/runners.js";
import { triggerAllowedForCwd } from "./mode-scope.js";
import type { RouteHandler } from "./types.js";
import { randomUUID } from "crypto";
import { createLogger } from "@pizzapi/tools";

const log = createLogger("triggers");

import {
    getTriggerHistory,
    clearTriggerHistory,
} from "../sessions/trigger-store.js";

// ── Offline-session wake ───────────────────────────────────────────


/** Authenticate via session cookie or API key. */
async function authenticate(req: Request): Promise<{ userId: string; userName: string } | Response> {
    // Try API key first (for external integrations), then fall back to session cookie
    const apiKey = req.headers.get("x-api-key");
    if (apiKey) {
        return validateApiKey(req, apiKey);
    }
    return requireSession(req);
}

export const handleTriggersRoute: RouteHandler = async (req, url) => {
    // ── POST /api/sessions/:id/model ──────────────────────────────────
    // Switch a live session's model. Same effect as the viewer's `model_set`
    // socket event, but reachable with an API key so runner services (the
    // Discord bridge's /models command) can drive it.
    const modelMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/model$/);
    if (modelMatch && req.method === "POST") {
        const identity = await authenticate(req);
        if (identity instanceof Response) return identity;

        const sessionId = decodeURIComponent(modelMatch[1]);
        const targetSession = await getSharedSession(sessionId);
        // Same 404-for-forbidden shape as the trigger route — do not leak
        // whether a session exists under another account.
        if (!targetSession || targetSession.userId !== identity.userId) {
            return Response.json({ error: "Session not found or not connected" }, { status: 404 });
        }
        if (!targetSession.collabMode) {
            return Response.json({ error: "Session is not in collab mode" }, { status: 409 });
        }

        let body: { provider?: unknown; modelId?: unknown };
        try {
            body = await req.json() as typeof body;
        } catch {
            return Response.json({ error: "Invalid JSON body" }, { status: 400 });
        }

        const provider = typeof body.provider === "string" ? body.provider.trim() : "";
        const modelId = typeof body.modelId === "string" ? body.modelId.trim() : "";
        if (!provider || !modelId) {
            return Response.json({ error: "Missing 'provider' or 'modelId'" }, { status: 400 });
        }

        // Hard-block hidden models, same rule as the spawn route and the
        // viewer's model_set handler. Fresh DB read — env copies go stale.
        try {
            const hiddenModels = await getHiddenModels(identity.userId);
            if (isHiddenModel(hiddenModels, { provider, id: modelId })) {
                log.warn(`blocked model switch to hidden model ${provider}/${modelId} on ${sessionId}`);
                return Response.json({ error: "Model not available" }, { status: 403 });
            }
        } catch {
            // Lookup failure falls through — the worker-side guard still applies.
        }

        const targetSocket = getLocalTuiSocket(sessionId);
        if (targetSocket?.connected) {
            targetSocket.emit("model_set", { provider, modelId });
            return Response.json({ ok: true, provider, modelId });
        }

        const delivered = await emitToRelaySessionVerified(sessionId, "model_set", { provider, modelId });
        if (delivered) return Response.json({ ok: true, provider, modelId });

        return Response.json(
            { error: "Session is registered but not currently connected" },
            { status: 503 },
        );
    }

    // ── POST /api/sessions/:id/abort ──────────────────────────────────
    // Stop the session's current generation. Same effect as the viewer's
    // Esc → exec { command: "abort" }, but reachable with an API key so
    // runner services (the Discord bridge's /stop command) can drive it.
    const abortMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/abort$/);
    if (abortMatch && req.method === "POST") {
        const identity = await authenticate(req);
        if (identity instanceof Response) return identity;

        const sessionId = decodeURIComponent(abortMatch[1]);
        const targetSession = await getSharedSession(sessionId);
        if (!targetSession || targetSession.userId !== identity.userId) {
            return Response.json({ error: "Session not found or not connected" }, { status: 404 });
        }
        if (!targetSession.collabMode) {
            return Response.json({ error: "Session is not in collab mode" }, { status: 409 });
        }

        const execReq = { type: "exec", id: `abort_${randomUUID().replace(/-/g, "").slice(0, 16)}`, command: "abort" };
        const targetSocket = getLocalTuiSocket(sessionId);
        if (targetSocket?.connected) {
            targetSocket.emit("exec", execReq);
            return Response.json({ ok: true });
        }

        const delivered = await emitToRelaySessionVerified(sessionId, "exec", execReq);
        if (delivered) return Response.json({ ok: true });

        return Response.json(
            { error: "Session is registered but not currently connected" },
            { status: 503 },
        );
    }

    // ── POST /api/sessions/:id/thinking ───────────────────────────────
    // Set the session's thinking/reasoning effort level. Same effect as the
    // viewer's exec { command: "set_thinking_level" }, but reachable with an
    // API key so runner services (the Discord bridge's /effort command) can
    // drive it. Body: { level }.
    const thinkingMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/thinking$/);
    if (thinkingMatch && req.method === "POST") {
        const identity = await authenticate(req);
        if (identity instanceof Response) return identity;

        const sessionId = decodeURIComponent(thinkingMatch[1]);
        const targetSession = await getSharedSession(sessionId);
        if (!targetSession || targetSession.userId !== identity.userId) {
            return Response.json({ error: "Session not found or not connected" }, { status: 404 });
        }
        if (!targetSession.collabMode) {
            return Response.json({ error: "Session is not in collab mode" }, { status: 409 });
        }

        let body: { level?: unknown };
        try {
            body = await req.json() as typeof body;
        } catch {
            return Response.json({ error: "Invalid JSON body" }, { status: 400 });
        }
        const level = typeof body.level === "string" ? body.level.trim() : "";
        const VALID_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
        if (!VALID_LEVELS.includes(level)) {
            return Response.json(
                { error: `Invalid 'level' — expected one of: ${VALID_LEVELS.join(", ")}` },
                { status: 400 },
            );
        }

        const execReq = {
            type: "exec",
            id: `think_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
            command: "set_thinking_level",
            level,
        };
        const thinkingSocket = getLocalTuiSocket(sessionId);
        if (thinkingSocket?.connected) {
            thinkingSocket.emit("exec", execReq);
            return Response.json({ ok: true, level });
        }

        const thinkingDelivered = await emitToRelaySessionVerified(sessionId, "exec", execReq);
        if (thinkingDelivered) return Response.json({ ok: true, level });

        return Response.json(
            { error: "Session is registered but not currently connected" },
            { status: 503 },
        );
    }

    // ── GET /api/sessions/:id/triggers ────────────────────────────────
    const getMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/triggers$/);
    if (getMatch && req.method === "GET") {
        const identity = await authenticate(req);
        if (identity instanceof Response) return identity;

        const sessionId = decodeURIComponent(getMatch[1]);

        // Validate ownership
        const targetSession = await getSharedSession(sessionId);
        if (!targetSession || targetSession.userId !== identity.userId) {
            return Response.json({ error: "Session not found" }, { status: 404 });
        }

        const limit = parseInt(url.searchParams.get("limit") ?? "50", 10);
        const history = await getTriggerHistory(sessionId, Math.min(limit, 200));

        return Response.json({ triggers: history });
    }

    // ── DELETE /api/sessions/:id/triggers ─────────────────────────────
    // Clears trigger history for a session (e.g. on /new).
    if (getMatch && req.method === "DELETE") {
        const identity = await authenticate(req);
        if (identity instanceof Response) return identity;

        const sessionId = decodeURIComponent(getMatch[1]);

        const targetSession = await getSharedSession(sessionId);
        if (!targetSession || targetSession.userId !== identity.userId) {
            return Response.json({ error: "Session not found" }, { status: 404 });
        }

        await clearTriggerHistory(sessionId);
        broadcastToSessionViewers(sessionId, "trigger_delivered", { cleared: true });
        return Response.json({ ok: true });
    }

    // ── GET /api/sessions/:id/available-triggers ──────────────────────
    // Returns trigger defs from the session's runner.
    // The runner is the authoritative source — a session can only subscribe
    // to trigger types declared by services on its own runner.
    const availableMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/available-triggers$/);
    if (availableMatch && req.method === "GET") {
        const identity = await authenticate(req);
        if (identity instanceof Response) return identity;

        const sessionId = decodeURIComponent(availableMatch[1]);

        const session = await getSharedSession(sessionId);
        if (!session || session.userId !== identity.userId) {
            return Response.json({ error: "Session not found" }, { status: 404 });
        }

        if (!session.runnerId) {
            return Response.json({ triggerDefs: [] });
        }

        const services = await getRunnerServices(session.runnerId);
        // Mode-scoped trigger defs are only listed for sessions inside a
        // matching mode's workspace — same rule the web UI applies.
        const runnerId = session.runnerId;
        const triggerDefs = (services?.triggerDefs ?? []).filter((def) =>
            triggerAllowedForCwd(def, services?.sessionModes, session.cwd, runnerId));
        return Response.json({ triggerDefs });
    }

    // ── GET /api/sessions/:id/available-sigils ──────────────────────
    // Returns sigil defs from the session's runner.
    const availableSigilsMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/available-sigils$/);
    if (availableSigilsMatch && req.method === "GET") {
        const identity = await authenticate(req);
        if (identity instanceof Response) return identity;

        const sessionId = decodeURIComponent(availableSigilsMatch[1]);

        const session = await getSharedSession(sessionId);
        if (!session || session.userId !== identity.userId) {
            return Response.json({ error: "Session not found" }, { status: 404 });
        }

        if (!session.runnerId) {
            return Response.json({ sigilDefs: [] });
        }

        const services = await getRunnerServices(session.runnerId);
        return Response.json({ sigilDefs: services?.sigilDefs ?? [] });
    }


    return undefined;
};
