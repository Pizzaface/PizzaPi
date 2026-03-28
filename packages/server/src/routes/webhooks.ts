/**
 * Webhooks router — registration, management, and inbound fire endpoint.
 *
 * CRUD (all require session-cookie auth):
 *   POST   /api/webhooks            — create webhook
 *   GET    /api/webhooks            — list user's webhooks
 *   GET    /api/webhooks/:id        — get webhook details
 *   PUT    /api/webhooks/:id        — update webhook
 *   DELETE /api/webhooks/:id        — delete webhook
 *
 * Fire endpoint (no auth cookie — validated via HMAC):
 *   POST /api/webhooks/:id/fire     — spawn a new session + fire trigger
 *
 * HMAC validation: SHA-256 of raw request body using webhook.secret.
 * The caller must send the hex digest in X-Webhook-Signature header.
 *
 * Every fire spawns a fresh session on the user's connected runner,
 * then delivers the webhook payload as a trigger into that session.
 */

import { requireSession } from "../middleware.js";
import {
    getSharedSession,
    getLocalTuiSocket,
    emitToRelaySessionVerified,
    broadcastToSessionViewers,
    getLocalRunnerSocket,
    recordRunnerSession,
    linkSessionToRunner,
} from "../ws/sio-registry.js";
import { waitForSpawnAck } from "../ws/runner-control.js";
import type { RouteHandler } from "./types.js";
import { randomUUID } from "crypto";
import { createHmac, timingSafeEqual } from "crypto";
import { createLogger } from "@pizzapi/tools";
import { pushTriggerHistory } from "../sessions/trigger-store.js";
import {
    createWebhook,
    getWebhook,
    listWebhooksForUser,
    updateWebhook,
    deleteWebhook,
} from "../webhooks/store.js";

const log = createLogger("webhooks-api");

/** Timeout for waiting for a spawned session to register (ms). */
const SPAWN_ACK_TIMEOUT_MS = 10_000;

/** How long to wait after spawn for the session socket to appear (ms). */
const SESSION_CONNECT_TIMEOUT_MS = 15_000;

// ── HMAC helpers ─────────────────────────────────────────────────────────────

/**
 * Compute HMAC-SHA256 of body using secret, return hex string.
 */
function computeHmac(secret: string, body: Uint8Array | string): string {
    return createHmac("sha256", secret).update(body).digest("hex");
}

/**
 * Timing-safe comparison of two hex strings.
 */
function hmacEqual(a: string, b: string): boolean {
    try {
        const aBuf = Buffer.from(a, "utf8");
        const bBuf = Buffer.from(b, "utf8");
        if (aBuf.length !== bBuf.length) return false;
        return timingSafeEqual(aBuf, bBuf);
    } catch {
        return false;
    }
}

// ── Spawn helper ──────────────────────────────────────────────────────────────

/**
 * Spawn a session on the webhook's designated runner.
 * Returns the new sessionId, or an error Response.
 */
async function spawnSessionForWebhook(
    runnerId: string,
    cwd: string | null,
    prompt: string | null,
): Promise<{ sessionId: string } | Response> {
    const runnerSocket = getLocalRunnerSocket(runnerId);
    if (!runnerSocket) {
        return Response.json(
            { error: "Runner is not connected to this server" },
            { status: 503 },
        );
    }

    const sessionId = randomUUID();
    const ackPromise = waitForSpawnAck(sessionId, SPAWN_ACK_TIMEOUT_MS);

    try {
        runnerSocket.emit("new_session", {
            sessionId,
            ...(cwd ? { cwd } : {}),
            ...(prompt ? { prompt } : {}),
        });
    } catch {
        return Response.json(
            { error: "Failed to send spawn request to runner" },
            { status: 502 },
        );
    }

    const ack = await ackPromise;
    if (ack.ok === false && !(ack as any).timeout) {
        return Response.json(
            { error: (ack as any).message ?? "Runner rejected the spawn request" },
            { status: 502 },
        );
    }

    await recordRunnerSession(runnerId, sessionId);
    await linkSessionToRunner(runnerId, sessionId);

    return { sessionId };
}

/**
 * Wait for a session's TUI socket to appear (it registers after spawn).
 * Polls every 200ms up to the timeout.
 */
async function waitForSessionSocket(
    sessionId: string,
    timeoutMs: number = SESSION_CONNECT_TIMEOUT_MS,
): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        // Check local socket first
        const local = getLocalTuiSocket(sessionId);
        if (local?.connected) return true;
        // Check shared session (cross-node)
        const shared = await getSharedSession(sessionId);
        if (shared) return true;
        await new Promise((r) => setTimeout(r, 200));
    }
    return false;
}

// ── Fire logic ────────────────────────────────────────────────────────────────

async function fireWebhookTrigger(
    webhookId: string,
    webhookName: string,
    source: string,
    targetSessionId: string,
    userId: string,
    payload: Record<string, unknown>,
    prompt: string | null,
): Promise<Response> {
    const triggerId = `wh_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const ts = new Date().toISOString();

    const triggerPayload = prompt
        ? { ...payload, prompt }
        : payload;

    const trigger = {
        type: "webhook",
        sourceSessionId: `external:${source}`,
        sourceSessionName: `Webhook: ${webhookName}`,
        targetSessionId,
        payload: triggerPayload,
        deliverAs: "steer" as const,
        expectsResponse: false,
        triggerId,
        ts,
    };

    const historyEntry = {
        triggerId,
        type: "webhook",
        // Prefix with "external:" so deriveLinkedSessions() in the UI
        // doesn't misclassify webhook sources as child sessions.
        source: `external:${source}`,
        summary: webhookName,
        payload: triggerPayload,
        deliverAs: "steer" as const,
        ts,
        direction: "inbound" as const,
    };

    // Deliver locally first. Write trigger history only after confirmed delivery
    // so the observability log reflects what was actually received.
    const targetSocket = getLocalTuiSocket(targetSessionId);
    if (targetSocket?.connected) {
        try {
            targetSocket.emit("session_trigger", { trigger });
            log.info(`Webhook trigger ${triggerId} delivered to session ${targetSessionId}`);
            void Promise.resolve(pushTriggerHistory(targetSessionId, historyEntry)).catch(() => {});
            broadcastToSessionViewers(targetSessionId, "trigger_delivered", { triggerId });
            return Response.json({ ok: true, triggerId, sessionId: targetSessionId });
        } catch (err) {
            log.error(`Failed to deliver webhook trigger ${triggerId}:`, err);
            return Response.json({ error: "Failed to deliver trigger to session" }, { status: 502 });
        }
    }

    // Cross-node fallback
    const delivered = await emitToRelaySessionVerified(targetSessionId, "session_trigger", { trigger });
    if (delivered) {
        log.info(`Webhook trigger ${triggerId} delivered cross-node to session ${targetSessionId}`);
        void Promise.resolve(pushTriggerHistory(targetSessionId, historyEntry)).catch(() => {});
        broadcastToSessionViewers(targetSessionId, "trigger_delivered", { triggerId });
        return Response.json({ ok: true, triggerId, sessionId: targetSessionId });
    }

    return Response.json(
        { error: "Session was spawned but is not yet connected — trigger could not be delivered" },
        { status: 503 },
    );
}

// ── Route handler ─────────────────────────────────────────────────────────────

export const handleWebhooksRoute: RouteHandler = async (req, url) => {
    // ── POST /api/webhooks ─────────────────────────────────────────────────
    if (url.pathname === "/api/webhooks" && req.method === "POST") {
        const identity = await requireSession(req);
        if (identity instanceof Response) return identity;

        let body: Record<string, unknown>;
        try {
            body = await req.json() as Record<string, unknown>;
        } catch {
            return Response.json({ error: "Invalid JSON body" }, { status: 400 });
        }

        const name = body.name;
        const source = body.source;
        if (!name || typeof name !== "string" || name.trim() === "") {
            return Response.json({ error: "Missing or invalid 'name' field" }, { status: 400 });
        }
        if (!source || typeof source !== "string" || source.trim() === "") {
            return Response.json({ error: "Missing or invalid 'source' field" }, { status: 400 });
        }

        // Validate eventFilter if provided
        let eventFilter: string[] | null = null;
        if (body.eventFilter !== undefined && body.eventFilter !== null) {
            if (
                !Array.isArray(body.eventFilter) ||
                !(body.eventFilter as unknown[]).every((e) => typeof e === "string")
            ) {
                return Response.json(
                    { error: "'eventFilter' must be an array of strings" },
                    { status: 400 },
                );
            }
            eventFilter = body.eventFilter as string[];
        }

        const runnerId =
            typeof body.runnerId === "string" && body.runnerId.trim()
                ? body.runnerId.trim()
                : null;
        const cwd =
            typeof body.cwd === "string" && body.cwd.trim()
                ? body.cwd.trim()
                : null;
        const prompt =
            typeof body.prompt === "string" && body.prompt.trim()
                ? body.prompt.trim()
                : null;

        const webhook = await createWebhook({
            userId: identity.userId,
            name: name.trim(),
            eventFilter,
            source: source.trim(),
            runnerId,
            cwd,
            prompt,
        });

        return Response.json({ webhook }, { status: 201 });
    }

    // ── GET /api/webhooks ──────────────────────────────────────────────────
    if (url.pathname === "/api/webhooks" && req.method === "GET") {
        const identity = await requireSession(req);
        if (identity instanceof Response) return identity;

        const webhooks = await listWebhooksForUser(identity.userId);
        return Response.json({ webhooks });
    }

    // ── GET /api/webhooks/:id ──────────────────────────────────────────────
    const idMatch = url.pathname.match(/^\/api\/webhooks\/([^/]+)$/);
    if (idMatch && req.method === "GET") {
        const identity = await requireSession(req);
        if (identity instanceof Response) return identity;

        const webhookId = decodeURIComponent(idMatch[1]);
        const webhook = await getWebhook(webhookId);

        if (!webhook || webhook.userId !== identity.userId) {
            return Response.json({ error: "Webhook not found" }, { status: 404 });
        }

        return Response.json({ webhook });
    }

    // ── PUT /api/webhooks/:id ──────────────────────────────────────────────
    const putMatch = url.pathname.match(/^\/api\/webhooks\/([^/]+)$/);
    if (putMatch && req.method === "PUT") {
        const identity = await requireSession(req);
        if (identity instanceof Response) return identity;

        const webhookId = decodeURIComponent(putMatch[1]);

        // Confirm it exists and belongs to this user
        const existing = await getWebhook(webhookId);
        if (!existing || existing.userId !== identity.userId) {
            return Response.json({ error: "Webhook not found" }, { status: 404 });
        }

        let body: Record<string, unknown>;
        try {
            body = await req.json() as Record<string, unknown>;
        } catch {
            return Response.json({ error: "Invalid JSON body" }, { status: 400 });
        }

        // Validate eventFilter if provided
        let eventFilter: string[] | null | undefined = undefined;
        if ("eventFilter" in body) {
            if (body.eventFilter === null) {
                eventFilter = null;
            } else if (
                Array.isArray(body.eventFilter) &&
                (body.eventFilter as unknown[]).every((e) => typeof e === "string")
            ) {
                eventFilter = body.eventFilter as string[];
            } else {
                return Response.json(
                    { error: "'eventFilter' must be an array of strings or null" },
                    { status: 400 },
                );
            }
        }

        const updates: Record<string, unknown> = {};
        if (typeof body.name === "string" && body.name.trim()) updates.name = body.name.trim();
        if (typeof body.source === "string" && body.source.trim()) updates.source = body.source.trim();
        if (eventFilter !== undefined) updates.eventFilter = eventFilter;
        if (typeof body.enabled === "boolean") updates.enabled = body.enabled;
        if ("runnerId" in body) {
            updates.runnerId = typeof body.runnerId === "string" && body.runnerId.trim() ? body.runnerId.trim() : null;
        }
        if ("cwd" in body) {
            updates.cwd = typeof body.cwd === "string" && body.cwd.trim() ? body.cwd.trim() : null;
        }
        if ("prompt" in body) {
            updates.prompt = typeof body.prompt === "string" && body.prompt.trim() ? body.prompt.trim() : null;
        }

        const updated = await updateWebhook(webhookId, identity.userId, updates as any);
        if (!updated) {
            return Response.json({ error: "Webhook not found" }, { status: 404 });
        }

        return Response.json({ webhook: updated });
    }

    // ── DELETE /api/webhooks/:id ───────────────────────────────────────────
    const deleteMatch = url.pathname.match(/^\/api\/webhooks\/([^/]+)$/);
    if (deleteMatch && req.method === "DELETE") {
        const identity = await requireSession(req);
        if (identity instanceof Response) return identity;

        const webhookId = decodeURIComponent(deleteMatch[1]);
        const deleted = await deleteWebhook(webhookId, identity.userId);

        if (!deleted) {
            return Response.json({ error: "Webhook not found" }, { status: 404 });
        }

        return Response.json({ ok: true });
    }

    // ── POST /api/webhooks/:id/fire ────────────────────────────────────────
    const fireMatch = url.pathname.match(/^\/api\/webhooks\/([^/]+)\/fire$/);
    if (fireMatch && req.method === "POST") {
        const webhookId = decodeURIComponent(fireMatch[1]);

        // Load webhook (no auth cookie required — HMAC validates the caller)
        const webhook = await getWebhook(webhookId);
        if (!webhook) {
            return Response.json({ error: "Webhook not found" }, { status: 404 });
        }
        if (!webhook.enabled) {
            return Response.json({ error: "Webhook not found" }, { status: 404 });
        }

        // Read raw body for HMAC validation
        let rawBody: ArrayBuffer;
        try {
            rawBody = await req.arrayBuffer();
        } catch {
            return Response.json({ error: "Failed to read request body" }, { status: 400 });
        }

        // Validate HMAC signature.
        const signature = req.headers.get("x-webhook-signature");
        if (!signature) {
            return Response.json({ error: "Missing X-Webhook-Signature header" }, { status: 401 });
        }

        const expected = computeHmac(webhook.secret, new Uint8Array(rawBody));
        if (!hmacEqual(signature, expected)) {
            log.warn(`Invalid HMAC for webhook ${webhookId}`);
            return Response.json({ error: "Invalid signature" }, { status: 401 });
        }

        // Parse body JSON
        let body: Record<string, unknown>;
        try {
            body = JSON.parse(new TextDecoder().decode(rawBody)) as Record<string, unknown>;
        } catch {
            return Response.json({ error: "Invalid JSON body" }, { status: 400 });
        }

        // Check event filter
        const eventType = (body.type as string | undefined) ?? "webhook";

        if (webhook.eventFilter && webhook.eventFilter.length > 0) {
            if (!webhook.eventFilter.includes(eventType)) {
                // Event filtered — silently accept but don't fire
                return Response.json({ ok: true, filtered: true });
            }
        }

        // Webhook must have a runner assigned
        if (!webhook.runnerId) {
            return Response.json(
                { error: "Webhook has no runner assigned" },
                { status: 500 },
            );
        }

        // Spawn a new session on the webhook's designated runner
        const spawnResult = await spawnSessionForWebhook(
            webhook.runnerId,
            webhook.cwd,
            webhook.prompt,
        );
        if (spawnResult instanceof Response) return spawnResult;

        const { sessionId } = spawnResult;
        log.info(`Webhook ${webhookId} spawned session ${sessionId}`);

        // Wait for the session to connect before firing the trigger
        const connected = await waitForSessionSocket(sessionId);
        if (!connected) {
            log.warn(`Webhook ${webhookId}: session ${sessionId} spawned but never connected`);
            return Response.json(
                { error: "Session was spawned but did not connect in time" },
                { status: 504 },
            );
        }

        return fireWebhookTrigger(
            webhook.id,
            webhook.name,
            webhook.source,
            sessionId,
            webhook.userId,
            body,
            webhook.prompt,
        );
    }

    return undefined;
};
