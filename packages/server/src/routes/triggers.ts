/**
 * Triggers router — HTTP API for firing triggers into sessions.
 *
 * POST /api/sessions/:id/trigger
 *   Fires a trigger into a connected session. Supports both session-cookie
 *   auth and API key auth (x-api-key header) for external integrations.
 *
 * GET /api/sessions/:id/triggers
 *   Lists recent triggers for a session (from Redis trigger history).
 *
 * GET /api/sessions/:id/available-triggers
 *   Returns trigger defs from the session's runner (what can be subscribed to).
 *
 * GET /api/sessions/:id/trigger-subscriptions
 *   Lists active trigger subscriptions for this session.
 *
 * POST /api/sessions/:id/trigger-subscriptions
 *   Subscribe this session to a trigger type: { triggerType: string }.
 *   Validates that the trigger type is available on the session's runner.
 *
 * DELETE /api/sessions/:id/trigger-subscriptions/:triggerType
 *   Unsubscribe this session from a trigger type.
 *
 * POST /api/runners/:runnerId/trigger-broadcast
 *   Broadcast a trigger by type to all sessions subscribed to that type on
 *   this runner. API key auth only (called by runner services).
 *   Body: { type, payload, deliverAs?, source?, summary? }
 *   Returns: { ok, delivered: number, triggerId }
 */

import { requireSession, validateApiKey } from "../middleware.js";
import { getSharedSession, getLocalTuiSocket } from "../ws/sio-registry.js";
import { emitToRelaySessionVerified } from "../ws/sio-registry.js";
import { getRunnerServices } from "../ws/sio-registry/runners.js";
import type { RouteHandler } from "./types.js";
import { randomUUID } from "crypto";
import { createLogger } from "@pizzapi/tools";
import {
    pushTriggerHistory,
    getTriggerHistory,
} from "../sessions/trigger-store.js";
import {
    subscribeSessionToTrigger,
    unsubscribeSessionFromTrigger,
    listSessionSubscriptions,
    getSubscribersForTrigger,
} from "../sessions/trigger-subscription-store.js";

const log = createLogger("triggers-api");

/** Shape of the POST /api/sessions/:id/trigger request body. */
interface TriggerRequest {
    /** Trigger type — e.g. "webhook", "service", "custom" */
    type: string;
    /** Arbitrary payload delivered to the session */
    payload: Record<string, unknown>;
    /** How to deliver: "steer" interrupts current turn, "followUp" queues after */
    deliverAs?: "steer" | "followUp";
    /** Whether the trigger expects a response from the session */
    expectsResponse?: boolean;
    /** Optional source identifier (e.g. "github", "godmother", "cron") */
    source?: string;
    /** Optional human-readable summary for the trigger */
    summary?: string;
}

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
    // ── POST /api/sessions/:id/trigger ────────────────────────────────
    const postMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/trigger$/);
    if (postMatch && req.method === "POST") {
        const identity = await authenticate(req);
        if (identity instanceof Response) return identity;

        const sessionId = decodeURIComponent(postMatch[1]);
        if (!sessionId) {
            return Response.json({ error: "Missing session ID" }, { status: 400 });
        }

        // Validate the target session exists and belongs to this user
        const targetSession = await getSharedSession(sessionId);
        if (!targetSession) {
            return Response.json({ error: "Session not found or not connected" }, { status: 404 });
        }
        if (targetSession.userId !== identity.userId) {
            return Response.json({ error: "Session not found or not connected" }, { status: 404 });
        }

        // Parse and validate the request body
        let body: TriggerRequest;
        try {
            body = await req.json() as TriggerRequest;
        } catch {
            return Response.json({ error: "Invalid JSON body" }, { status: 400 });
        }

        if (!body.type || typeof body.type !== "string") {
            return Response.json({ error: "Missing or invalid 'type' field" }, { status: 400 });
        }
        if (!body.payload || typeof body.payload !== "object" || Array.isArray(body.payload)) {
            return Response.json({ error: "Missing or invalid 'payload' field — must be an object" }, { status: 400 });
        }

        const deliverAs = body.deliverAs ?? "steer";
        if (deliverAs !== "steer" && deliverAs !== "followUp") {
            return Response.json({ error: "Invalid 'deliverAs' — must be 'steer' or 'followUp'" }, { status: 400 });
        }

        const triggerId = `ext_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
        const ts = new Date().toISOString();
        const trigger = {
            type: body.type,
            sourceSessionId: `external:${body.source ?? "api"}`,
            sourceSessionName: body.summary ?? `External (${body.source ?? "api"})`,
            targetSessionId: sessionId,
            payload: body.payload,
            deliverAs,
            expectsResponse: body.expectsResponse ?? false,
            triggerId,
            ts,
        };

        const historyEntry = {
            triggerId,
            type: body.type,
            source: body.source ?? "api",
            summary: body.summary,
            payload: body.payload,
            deliverAs,
            ts,
            direction: "inbound" as const,
        };

        // Deliver to the session via Socket.IO (same path as internal triggers).
        // Write trigger history only after confirmed delivery so the history
        // accurately reflects what the session actually received.
        const targetSocket = getLocalTuiSocket(sessionId);
        if (targetSocket?.connected) {
            try {
                targetSocket.emit("session_trigger", { trigger });
                log.info(`External trigger ${triggerId} delivered to session ${sessionId}`);
                void Promise.resolve(pushTriggerHistory(sessionId, historyEntry)).catch(() => {});
                return Response.json({ ok: true, triggerId });
            } catch (err) {
                log.error(`Failed to deliver trigger ${triggerId} to session ${sessionId}:`, err);
                return Response.json({ error: "Failed to deliver trigger to session" }, { status: 502 });
            }
        }

        // Cross-node fallback
        const delivered = await emitToRelaySessionVerified(sessionId, "session_trigger", { trigger });
        if (delivered) {
            log.info(`External trigger ${triggerId} delivered cross-node to session ${sessionId}`);
            void Promise.resolve(pushTriggerHistory(sessionId, historyEntry)).catch(() => {});
            return Response.json({ ok: true, triggerId });
        }

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
        return Response.json({ triggerDefs: services?.triggerDefs ?? [] });
    }

    // ── GET /POST /api/sessions/:id/trigger-subscriptions ────────────
    const subsMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/trigger-subscriptions$/);
    if (subsMatch && req.method === "GET") {
        const identity = await authenticate(req);
        if (identity instanceof Response) return identity;

        const sessionId = decodeURIComponent(subsMatch[1]);

        const session = await getSharedSession(sessionId);
        if (!session || session.userId !== identity.userId) {
            return Response.json({ error: "Session not found" }, { status: 404 });
        }

        const subscriptions = await listSessionSubscriptions(sessionId);
        return Response.json({ subscriptions });
    }

    // ── POST /api/sessions/:id/trigger-subscriptions ──────────────────
    if (subsMatch && req.method === "POST") {
        const identity = await authenticate(req);
        if (identity instanceof Response) return identity;

        const sessionId = decodeURIComponent(subsMatch[1]);

        const session = await getSharedSession(sessionId);
        if (!session || session.userId !== identity.userId) {
            return Response.json({ error: "Session not found" }, { status: 404 });
        }

        let body: { triggerType?: string };
        try {
            body = await req.json() as { triggerType?: string };
        } catch {
            return Response.json({ error: "Invalid JSON body" }, { status: 400 });
        }

        if (!body.triggerType || typeof body.triggerType !== "string") {
            return Response.json({ error: "Missing or invalid 'triggerType' field" }, { status: 400 });
        }

        const triggerType = body.triggerType.trim();

        if (!session.runnerId) {
            return Response.json({ error: "Session has no associated runner" }, { status: 422 });
        }

        // Validate that the trigger type is declared by the runner's services.
        // If the runner catalog is unavailable (e.g. runner restarted before
        // re-announcing), return 503 so callers know to retry rather than
        // treating it as a permanent "not available" failure (422).
        const services = await getRunnerServices(session.runnerId);
        if (!services) {
            return Response.json(
                { error: "Runner service catalog is temporarily unavailable — the runner may be restarting. Retry in a moment." },
                { status: 503 },
            );
        }
        const available = services.triggerDefs ?? [];
        const isDeclared = available.some((def) => def.type === triggerType);
        if (!isDeclared) {
            return Response.json(
                { error: `Trigger type '${triggerType}' is not available on this session's runner` },
                { status: 422 },
            );
        }

        await subscribeSessionToTrigger(sessionId, session.runnerId, triggerType);
        log.info(`Session ${sessionId} subscribed to trigger type '${triggerType}' on runner ${session.runnerId}`);
        return Response.json({ ok: true, triggerType, runnerId: session.runnerId });
    }

    // ── DELETE /api/sessions/:id/trigger-subscriptions/:triggerType ───
    const subsDeleteMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/trigger-subscriptions\/(.+)$/);
    if (subsDeleteMatch && req.method === "DELETE") {
        const identity = await authenticate(req);
        if (identity instanceof Response) return identity;

        const sessionId = decodeURIComponent(subsDeleteMatch[1]);
        const triggerType = decodeURIComponent(subsDeleteMatch[2]);

        const session = await getSharedSession(sessionId);
        if (!session || session.userId !== identity.userId) {
            return Response.json({ error: "Session not found" }, { status: 404 });
        }

        await unsubscribeSessionFromTrigger(sessionId, triggerType);
        log.info(`Session ${sessionId} unsubscribed from trigger type '${triggerType}'`);
        return Response.json({ ok: true, triggerType });
    }

    // ── POST /api/runners/:runnerId/trigger-broadcast ─────────────────
    // Broadcast a trigger by type to all sessions subscribed to that type
    // on this runner. API key only — called by runner services.
    // This is the delivery path that closes the subscription loop:
    // services fire typed triggers here and the server fans out to all
    // subscriber sessions, making subscriptions useful in production.
    const broadcastMatch = url.pathname.match(/^\/api\/runners\/([^/]+)\/trigger-broadcast$/);
    if (broadcastMatch && req.method === "POST") {
        const apiKey = req.headers.get("x-api-key");
        if (!apiKey) {
            return Response.json({ error: "API key required" }, { status: 401 });
        }
        const identity = await validateApiKey(req, apiKey);
        if (identity instanceof Response) return identity;

        const runnerId = decodeURIComponent(broadcastMatch[1]);

        let body: TriggerRequest;
        try {
            body = await req.json() as TriggerRequest;
        } catch {
            return Response.json({ error: "Invalid JSON body" }, { status: 400 });
        }

        if (!body.type || typeof body.type !== "string") {
            return Response.json({ error: "Missing or invalid 'type' field" }, { status: 400 });
        }
        if (!body.payload || typeof body.payload !== "object" || Array.isArray(body.payload)) {
            return Response.json({ error: "Missing or invalid 'payload' field — must be an object" }, { status: 400 });
        }

        const deliverAs = body.deliverAs ?? "steer";
        if (deliverAs !== "steer" && deliverAs !== "followUp") {
            return Response.json({ error: "Invalid 'deliverAs' — must be 'steer' or 'followUp'" }, { status: 400 });
        }

        // Look up all sessions subscribed to this runner+type
        const subscriberIds = await getSubscribersForTrigger(runnerId, body.type);
        if (subscriberIds.length === 0) {
            return Response.json({ ok: true, delivered: 0, triggerId: null });
        }

        const triggerId = `ext_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
        const ts = new Date().toISOString();
        const trigger = {
            type: body.type,
            sourceSessionId: `external:${body.source ?? "service"}`,
            sourceSessionName: body.summary ?? `Service (${body.source ?? "service"})`,
            payload: body.payload,
            deliverAs,
            expectsResponse: body.expectsResponse ?? false,
            triggerId,
            ts,
        };

        let delivered = 0;
        for (const targetSessionId of subscriberIds) {
            const targetSession = await getSharedSession(targetSessionId);
            // Only deliver to sessions belonging to the same user (ownership check)
            // and sessions that are actually connected.
            if (!targetSession || targetSession.userId !== identity.userId) continue;

            const historyEntry = {
                triggerId: `${triggerId}_${targetSessionId.slice(0, 8)}`,
                type: body.type,
                source: body.source ?? "service",
                summary: body.summary,
                payload: body.payload,
                deliverAs,
                ts,
                direction: "inbound" as const,
            };

            // Write history only after confirmed delivery so the log reflects
            // what the session actually received (not optimistically before delivery).
            const localSocket = getLocalTuiSocket(targetSessionId);
            if (localSocket?.connected) {
                try {
                    localSocket.emit("session_trigger", { trigger: { ...trigger, targetSessionId } });
                    void Promise.resolve(pushTriggerHistory(targetSessionId, historyEntry)).catch(() => {});
                    delivered++;
                    continue;
                } catch {
                    // fall through to cross-node
                }
            }
            const crossNode = await emitToRelaySessionVerified(
                targetSessionId, "session_trigger", { trigger: { ...trigger, targetSessionId } },
            );
            if (crossNode) {
                void Promise.resolve(pushTriggerHistory(targetSessionId, historyEntry)).catch(() => {});
                delivered++;
            }
        }

        log.info(`Broadcast trigger ${triggerId} (type=${body.type}) to ${delivered}/${subscriberIds.length} subscribers on runner ${runnerId}`);
        return Response.json({ ok: true, delivered, triggerId });
    }

    return undefined;
};
