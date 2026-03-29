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
import {
    getSharedSession,
    getLocalTuiSocket,
    broadcastToSessionViewers,
    emitToRelaySessionVerified,
    getLocalRunnerSocket,
    recordRunnerSession,
    linkSessionToRunner,
} from "../ws/sio-registry.js";
import { getRunnerServices } from "../ws/sio-registry/runners.js";
import type { RouteHandler } from "./types.js";
import { randomUUID } from "crypto";
import { createLogger } from "@pizzapi/tools";
import {
    pushTriggerHistory,
    getTriggerHistory,
    clearTriggerHistory,
} from "../sessions/trigger-store.js";
import {
    subscribeSessionToTrigger,
    unsubscribeSessionFromTrigger,
    listSessionSubscriptions,
    getSubscribersForTrigger,
    getSubscriptionParams,
    type SubscriptionParams,
} from "../sessions/trigger-subscription-store.js";
import {
    getRunnerListenerTypes,
    getRunnerTriggerListener,
} from "../sessions/runner-trigger-listener-store.js";
import { waitForSpawnAck } from "../ws/runner-control.js";

const log = createLogger("triggers-api");

/** Poll for a session socket to appear after spawn (same pattern as webhooks). */
async function waitForSessionSocket(sessionId: string, timeoutMs: number): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const local = getLocalTuiSocket(sessionId);
        if (local?.connected) return true;
        const shared = await getSharedSession(sessionId);
        if (shared) return true;
        await new Promise((r) => setTimeout(r, 200));
    }
    return false;
}

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

        // Prefix with "external:" so deriveLinkedSessions() in the UI
        // doesn't misclassify this as a child session source. The trigger's
        // own sourceSessionId already uses this prefix; history must match.
        const historySource = `external:${body.source ?? "api"}`;
        const historyEntry = {
            triggerId,
            type: body.type,
            source: historySource,
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
                broadcastToSessionViewers(sessionId, "trigger_delivered", { triggerId });
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
            broadcastToSessionViewers(sessionId, "trigger_delivered", { triggerId });
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

        let body: { triggerType?: string; params?: Record<string, unknown> };
        try {
            body = await req.json() as { triggerType?: string; params?: Record<string, unknown> };
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
        const triggerDef = available.find((def) => def.type === triggerType);
        if (!triggerDef) {
            return Response.json(
                { error: `Trigger type '${triggerType}' is not available on this session's runner` },
                { status: 422 },
            );
        }

        // Validate and coerce subscription params against the trigger def's param definitions.
        let subParams: SubscriptionParams | undefined;
        if (body.params && typeof body.params === "object" && !Array.isArray(body.params)) {
            const paramDefs = triggerDef.params ?? [];
            const validated: SubscriptionParams = {};
            const errors: string[] = [];

            for (const def of paramDefs) {
                const raw = body.params[def.name];
                if (raw === undefined || raw === null) {
                    if (def.required) {
                        errors.push(`Missing required param '${def.name}'`);
                    }
                    continue;
                }

                // Multiselect: expect an array of values
                if (def.multiselect && def.enum) {
                    const arr = Array.isArray(raw) ? raw : [raw];
                    const coerced: Array<string | number | boolean> = [];
                    for (const item of arr) {
                        if (def.type === "number") {
                            const num = Number(item);
                            if (!isNaN(num)) coerced.push(num);
                        } else if (def.type === "boolean") {
                            coerced.push(item === true || item === "true");
                        } else {
                            coerced.push(String(item));
                        }
                    }
                    // Validate against enum values if present
                    // eslint-disable-next-line eqeqeq
                    const invalid = coerced.filter(v => !def.enum!.some(e => e == v));
                    if (invalid.length > 0) {
                        errors.push(`Param '${def.name}' contains invalid values: ${invalid.join(", ")}. Allowed: ${def.enum.join(", ")}`);
                    } else if (coerced.length > 0) {
                        validated[def.name] = coerced;
                    }
                    continue;
                }

                // Scalar: coerce to the declared type
                if (def.type === "number") {
                    const num = Number(raw);
                    if (isNaN(num)) {
                        errors.push(`Param '${def.name}' must be a number`);
                    } else {
                        // Validate against enum
                        // eslint-disable-next-line eqeqeq
                        if (def.enum && !def.enum.some(e => e == num)) {
                            errors.push(`Param '${def.name}' must be one of: ${def.enum.join(", ")}`);
                        } else {
                            validated[def.name] = num;
                        }
                    }
                } else if (def.type === "boolean") {
                    const val = raw === true || raw === "true";
                    validated[def.name] = val;
                } else {
                    const val = String(raw);
                    // eslint-disable-next-line eqeqeq
                    if (def.enum && !def.enum.some(e => e == val)) {
                        errors.push(`Param '${def.name}' must be one of: ${def.enum.join(", ")}`);
                    } else {
                        validated[def.name] = val;
                    }
                }
            }

            // Also accept params not in the def (extensible — services may accept extra keys)
            for (const [key, val] of Object.entries(body.params)) {
                if (key in validated) continue;
                if (paramDefs.some(d => d.name === key)) continue; // already processed
                if (val === undefined || val === null) continue;
                if (typeof val === "string" || typeof val === "number" || typeof val === "boolean") {
                    validated[key] = val;
                } else if (Array.isArray(val)) {
                    const primitives = val.filter(
                        (v: unknown): v is string | number | boolean =>
                            typeof v === "string" || typeof v === "number" || typeof v === "boolean",
                    );
                    if (primitives.length > 0) validated[key] = primitives;
                }
            }

            if (errors.length > 0) {
                return Response.json({ error: errors.join("; ") }, { status: 400 });
            }

            if (Object.keys(validated).length > 0) {
                subParams = validated;
            }
        } else if (triggerDef.params) {
            // Check for required params with no params provided
            const missing = triggerDef.params.filter(p => p.required);
            if (missing.length > 0) {
                return Response.json(
                    { error: `Missing required params: ${missing.map(p => p.name).join(", ")}` },
                    { status: 400 },
                );
            }
        }

        await subscribeSessionToTrigger(sessionId, session.runnerId, triggerType, undefined, subParams);
        log.info(`Session ${sessionId} subscribed to trigger type '${triggerType}' on runner ${session.runnerId}${subParams ? ` with params ${JSON.stringify(subParams)}` : ""}`);
        broadcastToSessionViewers(sessionId, "trigger_subscriptions_changed", { triggerType, action: "subscribe" });
        return Response.json({ ok: true, triggerType, runnerId: session.runnerId, ...(subParams ? { params: subParams } : {}) });
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
        broadcastToSessionViewers(sessionId, "trigger_subscriptions_changed", { triggerType, action: "unsubscribe" });
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

            // Filter by subscription params: each param the subscriber specified
            // must match the corresponding field in the trigger payload.
            // Subscribers with no params receive all triggers (no filtering).
            const subParams = await getSubscriptionParams(targetSessionId, body.type);
            if (subParams) {
                let matches = true;
                for (const [key, expected] of Object.entries(subParams)) {
                    const actual = body.payload[key];
                    if (Array.isArray(expected)) {
                        // Multiselect: payload value must be in the subscriber's selected set.
                        // eslint-disable-next-line eqeqeq
                        if (!expected.some(e => e == actual)) {
                            matches = false;
                            break;
                        }
                    } else {
                        // Scalar: loose equality (handles "42" == 42).
                        // eslint-disable-next-line eqeqeq
                        if (actual != expected) {
                            matches = false;
                            break;
                        }
                    }
                }
                if (!matches) continue;
            }

            const historyEntry = {
                triggerId: `${triggerId}_${targetSessionId.slice(0, 8)}`,
                type: body.type,
                // Prefix with "external:" so deriveLinkedSessions() in the UI
                // doesn't misclassify service sources as child sessions.
                source: `external:${body.source ?? "service"}`,
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
                    broadcastToSessionViewers(targetSessionId, "trigger_delivered", { triggerId: historyEntry.triggerId });
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
                broadcastToSessionViewers(targetSessionId, "trigger_delivered", { triggerId: historyEntry.triggerId });
                delivered++;
            }
        }

        // ── Runner-level auto-spawn listeners ──────────────────────────
        let spawned = 0;
        const listenerTypes = await getRunnerListenerTypes(runnerId);
        if (listenerTypes.includes(body.type)) {
            const listener = await getRunnerTriggerListener(runnerId, body.type);
            if (listener) {
                const runnerSocket = getLocalRunnerSocket(runnerId);
                if (runnerSocket) {
                    const spawnedSessionId = randomUUID();
                    const ackPromise = waitForSpawnAck(spawnedSessionId, 10_000);
                    try {
                        runnerSocket.emit("new_session", {
                            sessionId: spawnedSessionId,
                            ...(listener.cwd ? { cwd: listener.cwd } : {}),
                            ...(listener.prompt ? { prompt: listener.prompt } : {}),
                        });
                        const ack = await ackPromise;
                        if (ack.ok !== false) {
                            await recordRunnerSession(runnerId, spawnedSessionId);
                            await linkSessionToRunner(runnerId, spawnedSessionId);

                            // Poll for the session socket to register (like webhooks do)
                            const ready = await waitForSessionSocket(spawnedSessionId, 15_000);
                            if (!ready) {
                                log.warn(`Auto-spawn listener: session ${spawnedSessionId} socket never appeared`);
                            }

                            const spawnTrigger = {
                                ...trigger,
                                targetSessionId: spawnedSessionId,
                            };
                            const spawnHistory = {
                                triggerId: `${triggerId}_spawn`,
                                type: body.type,
                                source: `external:${body.source ?? "service"}`,
                                summary: body.summary,
                                payload: body.payload,
                                deliverAs,
                                ts,
                                direction: "inbound" as const,
                            };

                            const spawnSocket = getLocalTuiSocket(spawnedSessionId);
                            if (spawnSocket?.connected) {
                                spawnSocket.emit("session_trigger", { trigger: spawnTrigger });
                                void pushTriggerHistory(spawnedSessionId, spawnHistory).catch(() => {});
                                broadcastToSessionViewers(spawnedSessionId, "trigger_delivered", { triggerId: spawnHistory.triggerId });
                                spawned++;
                            } else {
                                const cross = await emitToRelaySessionVerified(
                                    spawnedSessionId, "session_trigger", { trigger: spawnTrigger },
                                );
                                if (cross) {
                                    void pushTriggerHistory(spawnedSessionId, spawnHistory).catch(() => {});
                                    broadcastToSessionViewers(spawnedSessionId, "trigger_delivered", { triggerId: spawnHistory.triggerId });
                                    spawned++;
                                }
                            }
                            log.info(`Auto-spawned session ${spawnedSessionId} for listener ${body.type} on runner ${runnerId}`);
                        }
                    } catch (err) {
                        log.warn(`Failed to auto-spawn session for listener ${body.type}: ${err}`);
                    }
                }
            }
        }

        log.info(`Broadcast trigger ${triggerId} (type=${body.type}) to ${delivered}/${subscriberIds.length} subscribers + ${spawned} spawned on runner ${runnerId}`);
        return Response.json({ ok: true, delivered, spawned, triggerId });
    }

    return undefined;
};
