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
        const trigger = {
            type: body.type,
            sourceSessionId: `external:${body.source ?? "api"}`,
            sourceSessionName: body.summary ?? `External (${body.source ?? "api"})`,
            targetSessionId: sessionId,
            payload: body.payload,
            deliverAs,
            expectsResponse: body.expectsResponse ?? false,
            triggerId,
            ts: new Date().toISOString(),
        };

        // Store in trigger history
        await pushTriggerHistory(sessionId, {
            triggerId,
            type: body.type,
            source: body.source ?? "api",
            summary: body.summary,
            payload: body.payload,
            deliverAs,
            ts: trigger.ts,
            direction: "inbound",
        });

        // Deliver to the session via Socket.IO (same path as internal triggers)
        const targetSocket = getLocalTuiSocket(sessionId);
        if (targetSocket?.connected) {
            try {
                targetSocket.emit("session_trigger", { trigger });
                log.info(`External trigger ${triggerId} delivered to session ${sessionId}`);
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

        if (!session.runnerId) {
            return Response.json({ error: "Session has no associated runner" }, { status: 422 });
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

        // Validate that the trigger type is declared by the runner's services
        const services = await getRunnerServices(session.runnerId);
        const available = services?.triggerDefs ?? [];
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

    return undefined;
};
