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
 * HMAC validation (two modes, auto-detected):
 *   Enhanced: SHA-256 of `${timestamp}.${nonce}.${rawBody}` — requires X-Webhook-Timestamp
 *             and X-Webhook-Nonce headers; includes replay protection.
 *   Legacy:   SHA-256 of raw body only — used when the enhanced headers are absent.
 * Caller must always send:
 *   - X-Webhook-Signature (hex digest)
 * Optional for enhanced mode (enables replay protection):
 *   - X-Webhook-Timestamp (ISO string or RFC3339 date)
 *   - X-Webhook-Nonce (unique per delivery)
 *
 * Every fire spawns a fresh session on the user's connected runner,
 * then delivers the webhook payload as a trigger into that session.
 */

import { requireSession } from "../middleware.js";
import {
    getRunnerData,
} from "../ws/sio-registry.js";
import type { JsonValue } from "@pizzapi/protocol";
import { publishEvent } from "../events/engine.js";
import { createEngineDeps } from "../events/transport.js";
import { createRoute, deleteRoute, getRoute, listRoutes, updateRoute } from "../events/store.js";
import type { RouteHandler } from "./types.js";
import type { RouteInput } from "@pizzapi/protocol";
import type { Webhook } from "../webhooks/store.js";
import { createHmac, timingSafeEqual } from "crypto";
import { createLogger } from "@pizzapi/tools";
import { consumeNonceOnce } from "../redis-kv-store.js";
import {
    createWebhook,
    getWebhook,
    listWebhooksForUser,
    updateWebhook,
    deleteWebhook,
    toPublicWebhook,
} from "../webhooks/store.js";
import { getHiddenModels } from "../user-hidden-models.js";
import { isHiddenModel } from "./model-guard.js";

const log = createLogger("webhooks-api");

/** Maximum accepted age/skew for webhook timestamp headers (ms). */
const WEBHOOK_REPLAY_WINDOW_MS = 5 * 60 * 1000;
/** Allow up to 30s of clock skew (NTP drift) before rejecting as "future". */
const WEBHOOK_CLOCK_SKEW_MS = 30 * 1000;

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

/**
 * Event type for a webhook Source: `webhook:<slug>` derived from its name.
 * Slug must satisfy the protocol's namespaced-type grammar.
 */
function webhookEventType(name: string): string {
    const slug = name
        .toLowerCase()
        .replace(/[^a-z0-9_.-]+/g, "-")
        .replace(/^[^a-z0-9]+/, "")
        .replace(/-+$/, "");
    return `webhook:${slug || "unnamed"}`;
}

/** Deterministic route id for a webhook's config-backed spawn route. */
function webhookRouteId(webhookId: string): string {
    return `rt_wh_${webhookId}`;
}

function webhookRouteInput(webhook: Webhook): RouteInput {
    return {
        eventType: webhookEventType(webhook.name),
        target: {
            kind: "spawn",
            spec: {
                runnerId: webhook.runnerId as string,
                ownerUserId: webhook.userId,
                ...(webhook.cwd ? { cwd: webhook.cwd } : {}),
                ...(webhook.model ? { model: webhook.model } : {}),
            },
        },
        deliverAs: "steer",
        promptTemplate: webhook.prompt ?? undefined,
        origin: "ui",
        ownerUserId: webhook.userId,
    };
}

/**
 * The webhook's spawn config lives as its route (ADR-0002). The route is
 * keyed deterministically and re-synced on webhook create/update/delete so
 * config edits propagate — previously the route was created once on first
 * fire and later webhook edits silently stopped applying.
 */
async function syncWebhookRoute(webhook: Webhook): Promise<void> {
    const routeId = webhookRouteId(webhook.id);
    const existing = await getRoute(routeId);
    if (!webhook.runnerId) {
        if (existing) await deleteRoute(routeId);
        return;
    }
    const input = webhookRouteInput(webhook);
    if (existing) {
        await updateRoute(routeId, {
            eventType: input.eventType,
            target: input.target,
            deliverAs: input.deliverAs,
            promptTemplate: input.promptTemplate,
            ownerUserId: input.ownerUserId,
        });
    } else {
        await createRoute(input, { routeId });
    }
    // Retire legacy lazily-created copies of THIS webhook's route (created by
    // the old fire path with the exact same spec shape) so the deterministic
    // route is the only one and fires don't double-spawn. User-customized
    // routes with different specs are left alone.
    for (const route of await listRoutes({ eventType: input.eventType, ownerUserId: webhook.userId })) {
        if (route.routeId === routeId || route.origin !== "ui") continue;
        const spec = route.target.kind === "spawn" ? route.target.spec : null;
        if (!spec) continue;
        const sameShape =
            spec.runnerId === webhook.runnerId &&
            (spec.cwd ?? undefined) === (webhook.cwd ?? undefined) &&
            (route.promptTemplate ?? undefined) === (webhook.prompt ?? undefined) &&
            JSON.stringify(spec.model ?? null) === JSON.stringify(webhook.model ?? null);
        if (sameShape) await deleteRoute(route.routeId).catch(() => {});
    }
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

        if (runnerId) {
            const runner = await getRunnerData(runnerId);
            if (!runner || runner.userId !== identity.userId) {
                return Response.json(
                    { error: "Runner not found or not owned by you" },
                    { status: 403 },
                );
            }
        }

        // Validate model if provided
        let model: { provider: string; id: string } | null = null;
        if (body.model && typeof body.model === "object") {
            const mp = (body.model as any).provider;
            const mi = (body.model as any).id;
            if (typeof mp === "string" && mp.trim() && typeof mi === "string" && mi.trim()) {
                model = { provider: mp.trim(), id: mi.trim() };
            }
        }
        if (model && isHiddenModel(await getHiddenModels(identity.userId).catch(() => []), model)) {
            return Response.json({ error: "Model is hidden and cannot be used" }, { status: 403 });
        }

        const webhook = await createWebhook({
            userId: identity.userId,
            name: name.trim(),
            eventFilter,
            source: source.trim(),
            runnerId,
            cwd,
            prompt,
            model,
        });
        if (webhook) await syncWebhookRoute(webhook).catch((err) => log.warn("webhook route sync failed:", err));

        return Response.json({ webhook }, { status: 201 });
    }

    // ── GET /api/webhooks ──────────────────────────────────────────────────
    if (url.pathname === "/api/webhooks" && req.method === "GET") {
        const identity = await requireSession(req);
        if (identity instanceof Response) return identity;

        const webhooks = await listWebhooksForUser(identity.userId);
        return Response.json({ webhooks: webhooks.map(toPublicWebhook) });
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

        return Response.json({ webhook: toPublicWebhook(webhook) });
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
            if (typeof updates.runnerId === "string") {
                const runner = await getRunnerData(updates.runnerId);
                if (!runner || runner.userId !== identity.userId) {
                    return Response.json(
                        { error: "Runner not found or not owned by you" },
                        { status: 403 },
                    );
                }
            }
        }
        if ("cwd" in body) {
            updates.cwd = typeof body.cwd === "string" && body.cwd.trim() ? body.cwd.trim() : null;
        }
        if ("prompt" in body) {
            updates.prompt = typeof body.prompt === "string" && body.prompt.trim() ? body.prompt.trim() : null;
        }
        if ("model" in body) {
            if (body.model === null) {
                updates.model = null;
            } else if (body.model && typeof body.model === "object") {
                const mp = (body.model as any).provider;
                const mi = (body.model as any).id;
                if (typeof mp === "string" && mp.trim() && typeof mi === "string" && mi.trim()) {
                    const candidate = { provider: mp.trim(), id: mi.trim() };
                    if (isHiddenModel(await getHiddenModels(identity.userId).catch(() => []), candidate)) {
                        return Response.json({ error: "Model is hidden and cannot be used" }, { status: 403 });
                    }
                    updates.model = candidate;
                }
            }
        }

        const updated = await updateWebhook(webhookId, identity.userId, updates as any);
        if (!updated) {
            return Response.json({ error: "Webhook not found" }, { status: 404 });
        }
        try {
            await syncWebhookRoute(updated);
        } catch (err) {
            log.error("Webhook route sync failed:", err);
            return Response.json({ error: "Failed to sync webhook route" }, { status: 500 });
        }

        return Response.json({ webhook: toPublicWebhook(updated) });
    }

    // ── DELETE /api/webhooks/:id ───────────────────────────────────────────
    const deleteMatch = url.pathname.match(/^\/api\/webhooks\/([^/]+)$/);
    if (deleteMatch && req.method === "DELETE") {
        const identity = await requireSession(req);
        if (identity instanceof Response) return identity;

        const webhookId = decodeURIComponent(deleteMatch[1]);
        const webhook = await getWebhook(webhookId);
        if (!webhook || webhook.userId !== identity.userId) {
            return Response.json({ error: "Webhook not found" }, { status: 404 });
        }

        // Delete the route first so a route failure cannot leave an active
        // orphan after the webhook row is gone.
        try {
            await deleteRoute(webhookRouteId(webhookId));
        } catch (err) {
            log.error("Webhook route delete failed:", err);
            return Response.json({ error: "Failed to delete webhook route" }, { status: 500 });
        }

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

        const rawBodyText = new TextDecoder().decode(rawBody);
        const timestampHeader = req.headers.get("x-webhook-timestamp");
        const nonceHeader = req.headers.get("x-webhook-nonce");
        const useEnhanced = !!(timestampHeader && nonceHeader);

        if (useEnhanced) {
            // Enhanced verification: HMAC of `${timestamp}.${nonce}.${rawBody}` with replay protection.
            const timestampMs = Date.parse(timestampHeader!);
            if (!Number.isFinite(timestampMs)) {
                return Response.json({ error: "Invalid X-Webhook-Timestamp header" }, { status: 401 });
            }

            const nowMs = Date.now();
            if (timestampMs > nowMs + WEBHOOK_CLOCK_SKEW_MS) {
                // Reject timestamps too far in the future. A small tolerance (30s)
                // accommodates NTP drift without reopening the replay window —
                // nonces are retained for the full REPLAY_WINDOW after first seen,
                // which far exceeds the skew allowance.
                return Response.json({ error: "Webhook timestamp is in the future" }, { status: 401 });
            }
            if (nowMs - timestampMs > WEBHOOK_REPLAY_WINDOW_MS) {
                return Response.json({ error: "Webhook timestamp is too old" }, { status: 401 });
            }

            const nonce = nonceHeader!.trim();
            if (!nonce) {
                return Response.json({ error: "Missing X-Webhook-Nonce header" }, { status: 401 });
            }

            const expected = computeHmac(webhook.secret, `${timestampHeader}.${nonce}.${rawBodyText}`);
            if (!hmacEqual(signature, expected)) {
                log.warn(`Invalid HMAC (enhanced) for webhook ${webhookId}`);
                return Response.json({ error: "Invalid signature" }, { status: 401 });
            }

            const consumed = await consumeNonceOnce("webhook", `${webhookId}:${nonce}`, WEBHOOK_REPLAY_WINDOW_MS);
            if (!consumed) {
                return Response.json({ error: "Webhook nonce has already been used" }, { status: 409 });
            }
        } else {
            // Legacy verification: HMAC of raw body only (no replay protection).
            const expected = computeHmac(webhook.secret, rawBodyText);
            if (!hmacEqual(signature, expected)) {
                log.warn(`Invalid HMAC (legacy) for webhook ${webhookId}`);
                return Response.json({ error: "Invalid signature" }, { status: 401 });
            }
        }

        // Parse body JSON
        let body: Record<string, unknown>;
        try {
            body = JSON.parse(rawBodyText) as Record<string, unknown>;
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

        // Unified trigger system (ADR-0002): a webhook is a Source publishing
        // `webhook:<slug>` events; routing decides the target. A default
        // spawn-spec route is ensured lazily from the webhook's spawn config,
        // and users can repoint/extend routes via /api/routes.
        // SECURITY: fail-closed — never spawn on a runner the webhook owner no
        // longer owns (runner reclaimed by another user after webhook creation).
        if (webhook.runnerId) {
            const runnerData = await getRunnerData(webhook.runnerId).catch(() => null);
            if (!runnerData || runnerData.userId !== webhook.userId) {
                return Response.json({ error: "Runner is not available for this webhook" }, { status: 403 });
            }
        }

        const routeType = webhookEventType(webhook.name);
        const configRoute = await getRoute(webhookRouteId(webhook.id));
        if (webhook.runnerId && !configRoute) {
            // Ensure this webhook's config-backed route even when unrelated
            // routes already exist for the same event type.
            await syncWebhookRoute(webhook).catch((err) => log.warn("webhook route sync failed:", err));
        } else if (!webhook.runnerId) {
            const existingRoutes = await listRoutes({ eventType: routeType, ownerUserId: webhook.userId });
            if (existingRoutes.length === 0) {
                return Response.json(
                    { error: "Webhook has no runner assigned and no routes configured" },
                    { status: 500 },
                );
            }
        }

        try {
            const outcome = await publishEvent(
                {
                    type: routeType,
                    payload: { ...(body as Record<string, JsonValue>), externalType: eventType },
                    summary: `Webhook ${webhook.name}`,
                },
                // Tenant scope: the webhook's owner. Only their routes match, so
                // two users' equivalently named webhooks can never cross-fire.
                { kind: "webhook", id: webhook.id, name: webhook.name, auth: "hmac", userId: webhook.userId },
                createEngineDeps(),
            );
            log.info(`Webhook ${webhookId} published ${outcome.event.eventId} (${outcome.deliveries.length} deliveries, ${outcome.spawnedSessions.length} spawns)`);
            if (outcome.deliveries.length === 0) {
                // 503: routes exist but nothing accepted the delivery (runner
                // offline, spawn rejected) — the sender should retry.
                return Response.json(
                    { error: "Webhook event published but no route delivered it — retry" },
                    { status: 503 },
                );
            }
            return Response.json({
                ok: true,
                eventId: outcome.event.eventId,
                sessionIds: outcome.deliveries.map((d) => d.sessionId),
                spawnedSessions: outcome.spawnedSessions,
            });
        } catch (err) {
            log.error(`Webhook ${webhookId} publish failed:`, err);
            return Response.json({ error: "Failed to publish webhook event" }, { status: 500 });
        }
    }

    return undefined;
};
