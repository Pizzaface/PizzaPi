/**
 * Triggers router — HTTP API for firing triggers into sessions.
 *
 * POST /api/sessions/:id/trigger
 *   Fires a trigger into a connected session. Supports both session-cookie
 *   auth and API key auth (x-api-key header) for external integrations.
 *
 * POST /api/sessions/:id/model
 *   Switches a live session's model. HTTP equivalent of the viewer's
 *   `model_set` socket event, so runner services can drive it with an API key.
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
 * PUT /api/sessions/:id/trigger-subscriptions/:triggerType
 *   Update params/filters on an existing subscription. Notifies the runner
 *   service so it can react to param changes.
 *
 * DELETE /api/sessions/:id/trigger-subscriptions/:triggerType
 *   Unsubscribe this session from a trigger type.
 *
 * POST /api/runners/:runnerId/trigger-broadcast
 *   Broadcast a trigger by type to all sessions subscribed to that type on
 *   this runner. API key auth only (called by runner services).
 *   Body: { type, payload, deliverAs?, source?, summary? }
 *   deliverAs defaults to "followUp" (queued, non-interruptive) when omitted.
 *   Returns: { ok, delivered: number, triggerId }
 */

import { requireSession, validateApiKey } from "../middleware.js";
import { getHiddenModels } from "../user-hidden-models.js";
import { isHiddenModel } from "./model-guard.js";
import {
    getSharedSession,
    getLocalTuiSocket,
    waitForLocalTuiSocket,
    broadcastToSessionViewers,
    emitToRelaySessionVerified,
    getLocalRunnerSocket,
    emitToRunner,
    recordRunnerSession,
    linkSessionToRunner,
} from "../ws/sio-registry.js";
import { getRunnerServices, getRunnerData } from "../ws/sio-registry/runners.js";
import { triggerAllowedForCwd } from "./mode-scope.js";
import { emitTriggerSubscriptionDelta } from "../ws/namespaces/runner.js";
import type { RouteHandler } from "./types.js";
import { randomUUID } from "crypto";
import { createLogger } from "@pizzapi/tools";

function validateScheduleParams(triggerType: string, params: Record<string, unknown> | undefined): string | null {
    if (!params) return null;
    if (triggerType === "time:cron") {
        const cron = params.cron;
        if (typeof cron !== "string" || cron.trim().split(/\s+/).length !== 5 || cron.trim().split(/\s+/).some((f) => !/^[0-9*/?,\-]+$/.test(f))) return "Invalid cron expression";
    }
    if (triggerType === "time:at" && typeof params.at === "string" && !/^\d{1,2}:\d{2}\s*UTC$/i.test(params.at) && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(params.at)) return "Invalid time; use ISO 8601 with timezone or HH:MMUTC";
    if (triggerType === "time:timer_fired" && typeof params.duration !== "string") return "Invalid duration";
    return null;
}
import {
    pushTriggerHistory,
    getTriggerHistory,
    clearTriggerHistory,
} from "../sessions/trigger-store.js";
import {
    subscribeSessionToTrigger,
    unsubscribeSessionFromTrigger,
    unsubscribeSessionSubscription,
    listSessionSubscriptions,
    getSubscribersForTrigger,
    getSubscriptionParams,
    getSubscriptionFilters,
    updateSessionSubscription,
    getDurableSubscriptionRunnerId,
    type SubscriptionParams,
    type SubscriptionFilter,
    type SubscriptionFilterMode,
} from "../sessions/trigger-subscription-store.js";
import {
    getRunnerListenerTypes,
    listRunnerTriggerListeners,
    updateRunnerTriggerListener,
    removeRunnerTriggerListener,
    type RunnerTriggerListener,
} from "../sessions/runner-trigger-listener-store.js";
import {
    getPersistedRelaySessionOwner,
} from "../sessions/store.js";
import { waitForSpawnAck } from "../ws/runner-control.js";

interface SubscriptionFilterRecord {
    subscriptionId?: string;
    filters?: SubscriptionFilter[];
    filterMode?: SubscriptionFilterMode;
}

const log = createLogger("triggers-api");

function isJsonValue(value: unknown): value is null | string | number | boolean | unknown[] | Record<string, unknown> {
    if (value === null) return true;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return true;
    if (Array.isArray(value)) return value.every(isJsonValue);
    if (typeof value === "object") return Object.values(value as Record<string, unknown>).every(isJsonValue);
    return false;
}

/**
 * Check whether a single filter condition matches a trigger payload field.
 */
function matchesSingleFilter(filter: SubscriptionFilter, payload: Record<string, unknown>): boolean {
    const actual = payload[filter.field];
    const expected = filter.value;
    const op = filter.op ?? "eq";

    if (op === "contains") {
        if (typeof expected !== "string") return false;
        if (typeof actual === "string") return actual.toLowerCase().includes(expected.toLowerCase());
        if (Array.isArray(actual)) {
            return actual.some((item) => typeof item === "string" && item.toLowerCase().includes(expected.toLowerCase()));
        }
        return false;
    }

    // op === "eq" — exact match / set membership
    if (Array.isArray(actual)) {
        if (Array.isArray(expected)) {
            // eslint-disable-next-line eqeqeq
            return expected.some((e) => actual.some((a) => a == e));
        }
        // eslint-disable-next-line eqeqeq
        return actual.some((a) => a == expected);
    }

    if (Array.isArray(expected)) {
        // eslint-disable-next-line eqeqeq
        return expected.some((e) => e == actual);
    }

    // eslint-disable-next-line eqeqeq
    return actual == expected;
}

/**
 * Check whether a trigger payload matches subscription filters.
 *
 * @param filters  Array of filter conditions from the subscription.
 * @param filterMode  "and" (default) = all must match, "or" = any must match.
 */
function payloadMatchesFilters(
    payload: Record<string, unknown>,
    filters: SubscriptionFilter[],
    filterMode: SubscriptionFilterMode = "and",
): boolean {
    if (filters.length === 0) return true;
    if (filterMode === "or") {
        return filters.some((f) => matchesSingleFilter(f, payload));
    }
    // "and" — all must match
    return filters.every((f) => matchesSingleFilter(f, payload));
}

/**
 * Legacy compat — convert old-style subscription params into filters (AND logic).
 * Used for backward-compatible subscriptions that have params but no filters.
 */
function legacyParamsToFilters(params: Record<string, unknown>): SubscriptionFilter[] {
    const filters: SubscriptionFilter[] = [];
    for (const [key, expected] of Object.entries(params)) {
        const lower = key.toLowerCase();
        const isContains = lower.endsWith("contains") && key.length > "contains".length;
        const field = isContains ? key.slice(0, -"Contains".length) : key;
        filters.push({
            field,
            value: expected as any,
            op: isContains ? "contains" : "eq",
        });
    }
    return filters;
}

function normalizeFilterRecords(filterData: unknown): SubscriptionFilterRecord[] | undefined {
    if (filterData === undefined) return undefined;
    if (Array.isArray(filterData)) return filterData as SubscriptionFilterRecord[];
    if (filterData && typeof filterData === "object") return [filterData as SubscriptionFilterRecord];
    return undefined;
}

function filterRecordMatchesPayload(payload: Record<string, unknown>, record: SubscriptionFilterRecord): boolean {
    if (record.filters && record.filters.length > 0) {
        return payloadMatchesFilters(payload, record.filters, record.filterMode ?? "and");
    }
    return true;
}

function inferUnsubscribeTarget(target: string, subscriptionIdParam?: string): { subscriptionId?: string; triggerType: string; mode: "subscriptionId" | "triggerType" } {
    if (subscriptionIdParam) {
        return { subscriptionId: subscriptionIdParam, triggerType: target, mode: "subscriptionId" };
    }

    // Path target is always treated as the legacy triggerType delete-all form.
    // Targeted unsubscribe must use the explicit ?subscriptionId= query param.
    return { triggerType: target, mode: "triggerType" };
}

/**
 * Wait for a session socket to appear after spawn. Event-driven: resolves as
 * soon as the TUI socket registers instead of polling.
 * Only the TUI socket counts as ready — the Redis session record
 * (getSharedSession) is created before the socket connects, so checking it
 * would cause premature return and dropped triggers.
 */
async function waitForSessionSocket(sessionId: string, timeoutMs: number): Promise<boolean> {
    return waitForLocalTuiSocket(sessionId, timeoutMs);
}

/**
 * Parse a `runner-listener:<listenerId>` pseudo-session id (as emitted in
 * trigger subscription snapshots for runner-level auto-spawn listeners) into
 * its listenerId and owning runnerId. Returns null when the id doesn't carry
 * a runner segment (legacy listeners without a listenerId).
 */
function parseRunnerListenerSessionId(sessionId: string): { listenerId: string; runnerId: string } | null {
    if (!sessionId.startsWith("runner-listener:")) return null;
    const listenerId = sessionId.slice("runner-listener:".length);
    // listenerId format: listener:<runnerId>:<triggerType>:<ts>:<rand>
    if (!listenerId.startsWith("listener:")) return null;
    const runnerId = listenerId.split(":")[1];
    return runnerId ? { listenerId, runnerId } : null;
}

/**
 * Spawn a fresh session on a runner for an auto-spawn trigger listener and
 * deliver the trigger into it (listener prompt merged into payload.prompt).
 * Shared by service broadcasts and point-to-point deliveries addressed to a
 * `runner-listener:<listenerId>` pseudo-session (time:cron schedules etc.).
 */
async function spawnListenerSessionAndDeliver(
    runnerId: string,
    runnerUserId: string | undefined,
    listener: Pick<RunnerTriggerListener, "prompt" | "cwd" | "model" | "autoClose">,
    meta: {
        type: string;
        payload: Record<string, unknown>;
        summary?: string;
        source: string;
        deliverAs: "steer" | "followUp";
        expectsResponse: boolean;
        triggerId: string;
        ts: string;
    },
): Promise<{ spawned: boolean; sessionId?: string }> {
    const runnerSocket = getLocalRunnerSocket(runnerId);
    if (!runnerSocket) return { spawned: false };

    // Fire-time hidden-model recheck: the listener's model was validated at
    // create/update time, but may have been hidden since. Drop it (runner
    // default) rather than failing the spawn.
    const hiddenModels = runnerUserId
        ? await getHiddenModels(runnerUserId).catch(() => [] as string[])
        : [];
    const spawnedSessionId = randomUUID();
    const ackPromise = waitForSpawnAck(spawnedSessionId, 10_000);
    const listenerModel = listener.model && !isHiddenModel(hiddenModels, listener.model)
        ? listener.model
        : undefined;
    if (listener.model && !listenerModel) {
        log.warn(`trigger auto-spawn: dropping hidden model ${listener.model.provider}/${listener.model.id}, using runner default`);
    }
    try {
        // Don't pass the listener prompt as the initial prompt — it's merged
        // into the trigger payload below. Sending it here would cause a race:
        // the agent starts processing the prompt before the trigger arrives.
        runnerSocket.emit("new_session", {
            sessionId: spawnedSessionId,
            ...(listener.cwd ? { cwd: listener.cwd } : {}),
            ...(listenerModel ? { model: listenerModel } : {}),
            ...(hiddenModels.length > 0 ? { hiddenModels } : {}),
            ...(listener.autoClose ? { autoClose: true } : {}),
        });
        const ack = await ackPromise;
        if (ack.ok === false) return { spawned: false };
        await recordRunnerSession(runnerId, spawnedSessionId);
        await linkSessionToRunner(runnerId, spawnedSessionId);

        // Poll for the session socket to register (like webhooks do)
        const ready = await waitForSessionSocket(spawnedSessionId, 15_000);
        if (!ready) {
            log.warn(`Auto-spawn listener: session ${spawnedSessionId} socket never appeared`);
        }

        const listenerPrompt = typeof listener.prompt === "string" && listener.prompt.trim()
            ? listener.prompt.trim()
            : undefined;
        const spawnPayload = listenerPrompt
            ? {
                ...meta.payload,
                prompt: typeof meta.payload.prompt === "string" && meta.payload.prompt.trim()
                    ? `${listenerPrompt}\n\n${meta.payload.prompt.trim()}`
                    : listenerPrompt,
            }
            : meta.payload;
        const spawnTrigger = {
            type: meta.type,
            sourceSessionId: `external:${meta.source}`,
            sourceSessionName: meta.summary ?? `Service (${meta.source})`,
            payload: spawnPayload,
            deliverAs: meta.deliverAs,
            expectsResponse: meta.expectsResponse,
            triggerId: meta.triggerId,
            ts: meta.ts,
            targetSessionId: spawnedSessionId,
        };
        const spawnHistory = {
            triggerId: `${meta.triggerId}_spawn_${spawnedSessionId.slice(0, 8)}`,
            type: meta.type,
            source: `external:${meta.source}`,
            summary: meta.summary,
            payload: spawnPayload,
            deliverAs: meta.deliverAs,
            ts: meta.ts,
            direction: "inbound" as const,
        };

        let triggerDelivered = false;
        const spawnSocket = getLocalTuiSocket(spawnedSessionId);
        if (spawnSocket?.connected) {
            spawnSocket.emit("session_trigger", { trigger: spawnTrigger });
            triggerDelivered = true;
        } else if (await emitToRelaySessionVerified(spawnedSessionId, "session_trigger", { trigger: spawnTrigger })) {
            triggerDelivered = true;
        }
        if (triggerDelivered) {
            void Promise.resolve(pushTriggerHistory(spawnedSessionId, spawnHistory)).catch(() => {});
            broadcastToSessionViewers(spawnedSessionId, "trigger_delivered", { triggerId: spawnHistory.triggerId });
            log.info(`Auto-spawned session ${spawnedSessionId} for listener ${meta.type} on runner ${runnerId}`);
            return { spawned: true, sessionId: spawnedSessionId };
        }
        // Kill the orphaned session if trigger delivery failed — without a
        // prompt or trigger, the worker has no work and would sit idle forever.
        log.warn(`Auto-spawn: trigger delivery failed for session ${spawnedSessionId} — killing orphaned worker`);
        runnerSocket.emit("kill_session", { sessionId: spawnedSessionId });
        return { spawned: false };
    } catch (err) {
        log.warn(`Failed to auto-spawn session for listener ${meta.type}: ${err}`);
        return { spawned: false };
    }
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
    /**
     * When true and the target session is offline, the server wakes it: the
     * runner respawns a worker that resumes the same session (new_session with
     * resumeId), and the caller's retry delivers into the awakened session.
     * Used by schedule deliveries (time service) — a schedule firing must
     * reach the session that created it even if its worker has exited.
     */
    wakeSession?: boolean;
}

// ── Offline-session wake ───────────────────────────────────────────

/** In-flight wake attempts, deduped per session so concurrent schedule fires
 *  (or retries) share one worker respawn instead of racing the daemon. */
const pendingSessionWakes = new Map<string, Promise<boolean>>();

/**
 * Ask the session's runner to respawn a worker that RESUMES this session
 * (same relay session id, same conversation via resumeId). Returns true once
 * the worker's TUI socket has registered. Runs in the background — the
 * trigger route returns 503 immediately and the caller's retry loop delivers
 * once the session is awake, which avoids double-delivery races between a
 * slow wake and the caller's own delivery timeout.
 */
function wakeOfflineSession(
    sessionId: string,
    session: { runnerId?: string | null; cwd?: string },
): Promise<boolean> {
    const existing = pendingSessionWakes.get(sessionId);
    if (existing) return existing;

    const attempt = (async (): Promise<boolean> => {
        const runnerId = session.runnerId;
        if (!runnerId) return false;

        // The runner may be connected to a DIFFERENT relay node. emitToRunner
        // goes through the per-runner room, which the Redis adapter fans out
        // cluster-wide, so waking is not limited to sessions whose runner
        // happens to share this node.
        const isLocal = !!getLocalRunnerSocket(runnerId);
        const ackPromise = isLocal ? waitForSpawnAck(sessionId, 10_000) : null;
        try {
            emitToRunner(runnerId, "new_session", {
                sessionId,
                ...(session.cwd ? { cwd: session.cwd } : {}),
                // The daemon resolves the local .jsonl by session id; if the file
                // is gone it degrades to a fresh conversation under the same
                // relay session — still the schedule's home.
                resumeId: sessionId,
            });
        } catch (err) {
            log.warn(`wake: failed to send new_session for ${sessionId}:`, err);
            return false;
        }

        // The spawn ack and worker socket are observable only on the node the
        // runner/worker connect to. Cross-node, fire and let the caller's retry
        // confirm delivery — that path is already cluster-wide.
        if (!ackPromise) {
            log.info(`wake: asked runner ${runnerId} on another node to resume ${sessionId}`);
            return true;
        }

        const ack = await ackPromise;
        if (ack.ok === false && !(ack as { timeout?: boolean }).timeout) {
            log.warn(`wake: runner rejected resume of ${sessionId}: ${(ack as { message?: string }).message ?? "unknown"}`);
            return false;
        }
        const ready = await waitForSessionSocket(sessionId, 15_000);
        if (ready) {
            log.info(`wake: session ${sessionId} resumed and registered`);
        } else {
            log.warn(`wake: session ${sessionId} worker never registered`);
        }
        return ready;
    })().finally(() => {
        pendingSessionWakes.delete(sessionId);
    });

    pendingSessionWakes.set(sessionId, attempt);
    return attempt;
}

/**
 * Resolve who owns a session for subscription management, tolerating a session
 * whose live record is gone.
 *
 * Schedules (time:*) outlive the session that created them, so a standing
 * subscription must stay listable and cancellable after its owner ends —
 * otherwise a cron fires forever with no way to see or stop it from the UI.
 * The live Redis record is preferred (it is authoritative and carries the
 * current runner); the persisted relay_session row is the fallback.
 *
 * Returns null when the session is unknown or belongs to another user —
 * callers must treat that exactly like "not found".
 */
async function resolveSubscriptionOwner(
    sessionId: string,
    userId: string,
): Promise<{ runnerId: string | null; cwd?: string } | null> {
    const live = await getSharedSession(sessionId);
    if (live) {
        return live.userId === userId
            ? { runnerId: live.runnerId ?? null, ...(live.cwd ? { cwd: live.cwd } : {}) }
            : null;
    }
    const persisted = await getPersistedRelaySessionOwner(sessionId);
    if (persisted) {
        if (!persisted.userId || persisted.userId !== userId) return null;
        return {
            runnerId: persisted.runnerId,
            ...(persisted.cwd ? { cwd: persisted.cwd } : {}),
        };
    }
    // Last resort: the relay-session pruner deletes ended sessions, but durable
    // time:* schedules outlive them. Resolve ownership through the schedule's
    // runner — a schedule that exists must stay manageable by the runner's
    // owner, or it fires forever with no way to cancel it.
    const runnerId = await getDurableSubscriptionRunnerId(sessionId);
    if (!runnerId) return null;
    const runner = await getRunnerData(runnerId).catch(() => null);
    if (!runner || runner.userId !== userId) return null;
    return { runnerId };
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

    // ── POST /api/sessions/:id/trigger ────────────────────────────────
    const postMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/trigger$/);
    if (postMatch && req.method === "POST") {
        const identity = await authenticate(req);
        if (identity instanceof Response) return identity;

        const sessionId = decodeURIComponent(postMatch[1]);
        if (!sessionId) {
            return Response.json({ error: "Missing session ID" }, { status: 400 });
        }

        // Validate the target session belongs to this user. A missing live
        // record is not decided here: a schedule outlives its session, so a
        // wake-enabled delivery may legitimately target a session whose live
        // record has been swept — resolved against the durable table below,
        // once the body tells us whether a wake was requested.
        const targetSession = await getSharedSession(sessionId);
        if (targetSession && targetSession.userId !== identity.userId) {
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

        // A `runner-listener:<listenerId>` pseudo-session is a runner-level
        // auto-spawn listener — there is no real session to deliver into.
        // Fires addressed to it (the time service's cron/at/timer deliveries)
        // spawn a fresh session from the listener's own prompt/cwd/model and
        // deliver the trigger there, exactly like a service broadcast would.
        if (sessionId.startsWith("runner-listener:")) {
            const parsed = parseRunnerListenerSessionId(sessionId);
            const runnerData = parsed ? await getRunnerData(parsed.runnerId).catch(() => null) : null;
            if (!parsed || !runnerData || runnerData.userId !== identity.userId) {
                return Response.json({ error: "Listener not found" }, { status: 404 });
            }
            const listener = (await listRunnerTriggerListeners(parsed.runnerId))
                .find((entry) => entry.listenerId === parsed.listenerId);
            if (!listener) {
                return Response.json({ error: "Listener not found" }, { status: 404 });
            }
            const listenerTriggerId = `ext_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
            const result = await spawnListenerSessionAndDeliver(parsed.runnerId, runnerData.userId, listener, {
                type: body.type,
                payload: body.payload,
                summary: body.summary,
                source: body.source ?? "api",
                deliverAs,
                expectsResponse: body.expectsResponse ?? false,
                triggerId: listenerTriggerId,
                ts: new Date().toISOString(),
            });
            if (!result.spawned) {
                // 503 (not 404): the listener still exists — the caller's
                // schedule must retry, not treat the schedule as deleted.
                return Response.json({ error: "Failed to spawn listener session — retry delivery" }, { status: 503 });
            }
            return Response.json({ ok: true, triggerId: listenerTriggerId, spawnedSessionId: result.sessionId });
        }

        // Where this trigger can be delivered or resumed. Falls back to the
        // durable table ONLY for wake-enabled deliveries, so ordinary triggers
        // keep their existing "live session or 404" contract.
        const target: { runnerId: string | null; cwd?: string } | null = targetSession
            ? { runnerId: targetSession.runnerId ?? null, ...(targetSession.cwd ? { cwd: targetSession.cwd } : {}) }
            : body.wakeSession === true
                ? await resolveSubscriptionOwner(sessionId, identity.userId)
                : null;
        if (!target) {
            // No live record and nothing durable to resume — the session is
            // genuinely gone. Callers treat 404 as "start fresh work": the time
            // service spawns a replacement session for the schedule.
            return Response.json({ error: "Session not found or not connected" }, { status: 404 });
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

        // Offline — optionally wake the session in the background. The caller
        // retries (schedule deliveries use backoff) and lands the trigger once
        // the resumed worker registers. This covers a session whose live record
        // is gone entirely: the runner resumes it by id from the session file,
        // so a schedule returns to the conversation that created it rather than
        // starting a stranger.
        if (body.wakeSession === true && target.runnerId) {
            // Redis-backed, so a runner attached to another relay node counts as
            // reachable — a local-socket check would report a perfectly healthy
            // multi-node deployment as "runner down".
            const wakeRunnerData = await getRunnerData(target.runnerId).catch(() => null);
            // SECURITY: fail-closed — if the runner was reclaimed by another user
            // after the session ended, refuse the wake. Never emit a resume
            // command to another user's runner (cross-user command injection).
            if (wakeRunnerData && wakeRunnerData.userId !== identity.userId) {
                log.warn(`wake: runner ${target.runnerId} is owned by a different user — refusing cross-user wake for session ${sessionId}`);
                return Response.json({ error: "Session not found or not connected" }, { status: 404 });
            }
            const runnerReachable = !!getLocalRunnerSocket(target.runnerId) || !!wakeRunnerData;
            if (runnerReachable) {
                log.info(`External trigger ${triggerId}: session ${sessionId} offline — starting wake`);
                void wakeOfflineSession(sessionId, target).catch((err) => {
                    log.warn(`wake: unexpected error for ${sessionId}:`, err);
                });
            } else {
                // Runner is down, not the session. Retrying is right — spawning a
                // replacement here would strand work on a runner that is about
                // to come back.
                log.info(`External trigger ${triggerId}: runner ${target.runnerId} unreachable — caller should retry`);
            }
            return Response.json(
                {
                    error: runnerReachable
                        ? "Session is offline — wake started, retry delivery"
                        : "Session is offline and its runner is unreachable — retry delivery",
                    ...(runnerReachable ? { waking: true } : {}),
                },
                { status: 503 },
            );
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

    // ── GET /POST /api/sessions/:id/trigger-subscriptions ────────────
    const subsMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/trigger-subscriptions$/);
    if (subsMatch && req.method === "GET") {
        const identity = await authenticate(req);
        if (identity instanceof Response) return identity;

        const sessionId = decodeURIComponent(subsMatch[1]);

        // Falls back to persisted ownership: a schedule outlives its session,
        // and an unlistable schedule is an uncancellable one.
        const owner = await resolveSubscriptionOwner(sessionId, identity.userId);
        if (!owner) {
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

        let body: { triggerType?: string; params?: Record<string, unknown>; filters?: unknown[]; filterMode?: string };
        try {
            body = await req.json() as { triggerType?: string; params?: Record<string, unknown>; filters?: unknown[]; filterMode?: string };
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
        if (!triggerAllowedForCwd(triggerDef, services.sessionModes, session.cwd, session.runnerId)) {
            return Response.json(
                { error: `Trigger type '${triggerType}' is scoped to session mode(s) [${(triggerDef.modes ?? []).join(", ")}] — this session's working directory is not inside a matching mode workspace` },
                { status: 422 },
            );
        }

        const scheduleError = validateScheduleParams(triggerType, body.params);
        if (scheduleError) return Response.json({ error: scheduleError }, { status: 400 });

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
                            if (item === true || item === "true") coerced.push(true);
                            else if (item === false || item === "false") coerced.push(false);
                            // else: skip invalid boolean values (filtered out by enum validation below)
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
                    } else if (def.required) {
                        errors.push(`Param '${def.name}' requires at least one valid value`);
                    }
                    continue;
                }

                // Generic JSON param: preserve object/array/scalar values as-is
                if (def.type === "json") {
                    if (!isJsonValue(raw)) {
                        errors.push(`Param '${def.name}' must be valid JSON`);
                    } else {
                        validated[def.name] = raw as SubscriptionParams[string];
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
                    if (raw === true || raw === "true") {
                        validated[def.name] = true;
                    } else if (raw === false || raw === "false") {
                        validated[def.name] = false;
                    } else {
                        errors.push(`Param '${def.name}' must be a boolean (true/false)`);
                    }
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
                if (isJsonValue(val)) {
                    validated[key] = val as SubscriptionParams[string];
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

        // Validate and coerce subscription filters against the trigger def's output schema.
        let subFilters: SubscriptionFilter[] | undefined;
        let subFilterMode: SubscriptionFilterMode | undefined;
        if (Array.isArray(body.filters) && body.filters.length > 0) {
            const schemaProps = (triggerDef.schema as any)?.properties ?? {};
            const validatedFilters: SubscriptionFilter[] = [];
            const filterErrors: string[] = [];

            for (const raw of body.filters) {
                if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
                    filterErrors.push("Each filter must be an object with { field, value }");
                    continue;
                }
                const f = raw as Record<string, unknown>;
                if (typeof f.field !== "string" || !f.field) {
                    filterErrors.push("Filter missing 'field'");
                    continue;
                }
                if (f.value === undefined || f.value === null) {
                    filterErrors.push(`Filter on '${f.field}' missing 'value'`);
                    continue;
                }
                // Validate field exists in the output schema (if schema is provided)
                if (triggerDef.schema && Object.keys(schemaProps).length > 0 && !(f.field in schemaProps)) {
                    filterErrors.push(`Filter field '${f.field}' is not in the trigger's output schema. Available: ${Object.keys(schemaProps).join(", ")}`);
                    continue;
                }
                const op = f.op === "contains" ? "contains" as const : "eq" as const;
                // Coerce value to primitive or array of primitives
                let value: string | number | boolean | Array<string | number | boolean>;
                if (Array.isArray(f.value)) {
                    value = f.value.filter(
                        (v: unknown): v is string | number | boolean =>
                            typeof v === "string" || typeof v === "number" || typeof v === "boolean",
                    );
                } else if (typeof f.value === "string" || typeof f.value === "number" || typeof f.value === "boolean") {
                    value = f.value;
                } else {
                    value = String(f.value);
                }
                validatedFilters.push({ field: f.field, value, op });
            }

            if (filterErrors.length > 0) {
                return Response.json({ error: filterErrors.join("; ") }, { status: 400 });
            }
            if (validatedFilters.length > 0) {
                subFilters = validatedFilters;
            }
        }
        if (body.filterMode === "or" || body.filterMode === "and") {
            subFilterMode = body.filterMode;
        }

        const subscriptionId = await subscribeSessionToTrigger(sessionId, session.runnerId, triggerType, undefined, subParams, subFilters, subFilterMode);
        if (!subscriptionId) {
            // Store failure (Redis down or write error). Do NOT report success or
            // emit a delta — an empty-ID subscribe delta would poison the runner's
            // subscription cache with an unremovable phantom entry.
            log.warn(`Failed to persist trigger subscription for session ${sessionId} type '${triggerType}'`);
            return Response.json({ error: "Failed to store trigger subscription" }, { status: 503 });
        }
        const logParts: string[] = [];
        if (subParams) logParts.push(`params=${JSON.stringify(subParams)}`);
        if (subFilters) logParts.push(`filters=${JSON.stringify(subFilters)} mode=${subFilterMode ?? "and"}`);
        log.info(`Session ${sessionId} subscribed to trigger type '${triggerType}' on runner ${session.runnerId}${logParts.length > 0 ? ` with ${logParts.join(", ")}` : ""}`);
        broadcastToSessionViewers(sessionId, "trigger_subscriptions_changed", { triggerType, action: "subscribe" });

        // Notify the runner via typed delta (always, even without params).
        // The reconciliation protocol (trigger_subscription_delta) is the
        // authoritative path — services use reconcileSubscriptions() to apply it.
        // The legacy subscription_params_changed event has been removed to
        // prevent double-apply when both server and runner are updated.
        if (session.runnerId) {
            void emitTriggerSubscriptionDelta(session.runnerId, {
                action: "subscribe",
                subscription: {
                    subscriptionId,
                    sessionId,
                    triggerType,
                    runnerId: session.runnerId,
                    ...(subParams ? { params: subParams } : {}),
                    ...(subFilters ? { filters: subFilters } : {}),
                    ...(subFilterMode ? { filterMode: subFilterMode } : {}),
                },
            });
        }

        return Response.json({
            ok: true,
            subscriptionId,
            triggerType,
            runnerId: session.runnerId,
            ...(subParams ? { params: subParams } : {}),
            ...(subFilters ? { filters: subFilters } : {}),
            ...(subFilterMode ? { filterMode: subFilterMode } : {}),
        });
    }

    // ── DELETE /api/sessions/:id/trigger-subscriptions/:triggerType ───
    const subsDeleteMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/trigger-subscriptions\/(.+)$/);
    if (subsDeleteMatch && req.method === "DELETE") {
        const identity = await authenticate(req);
        if (identity instanceof Response) return identity;

        const sessionId = decodeURIComponent(subsDeleteMatch[1]);
        const target = decodeURIComponent(subsDeleteMatch[2]);
        const subscriptionIdParam = url.searchParams.get("subscriptionId")?.trim() || undefined;

        // One-shot runner listeners (time:at / time:timer_fired) are retired by
        // the time service after a successful fire via this same DELETE route —
        // map the pseudo-session back to the durable listener row.
        if (sessionId.startsWith("runner-listener:")) {
            const parsed = parseRunnerListenerSessionId(sessionId);
            const runnerData = parsed ? await getRunnerData(parsed.runnerId).catch(() => null) : null;
            if (!parsed || !runnerData || runnerData.userId !== identity.userId) {
                return Response.json({ error: "Listener not found" }, { status: 404 });
            }
            const listener = (await listRunnerTriggerListeners(parsed.runnerId))
                .find((entry) => entry.listenerId === parsed.listenerId);
            const removed = listener ? await removeRunnerTriggerListener(parsed.runnerId, parsed.listenerId) : false;
            if (listener && removed) {
                void emitTriggerSubscriptionDelta(parsed.runnerId, {
                    action: "unsubscribe",
                    subscription: {
                        subscriptionId: parsed.listenerId,
                        sessionId,
                        triggerType: listener.triggerType,
                        runnerId: parsed.runnerId,
                    },
                }).catch((err) => {
                    log.warn("Failed to emit runner listener unsubscribe delta:", err);
                });
                log.info(`Removed fired runner listener ${parsed.listenerId} on ${parsed.runnerId}`);
            }
            return Response.json({ ok: true, removed: removed ? 1 : 0 });
        }

        // Persisted fallback: cancelling a schedule whose session has ended must
        // work, and must still reach the runner below so its armed timer dies
        // with the subscription (otherwise the next fire spawns a replacement
        // session for work the user just cancelled).
        const owner = await resolveSubscriptionOwner(sessionId, identity.userId);
        if (!owner) {
            return Response.json({ error: "Session not found" }, { status: 404 });
        }

        let { triggerType, subscriptionId, mode } = inferUnsubscribeTarget(target, subscriptionIdParam);
        let removed = 0;

        if (mode === "subscriptionId" && subscriptionId) {
            const result = await unsubscribeSessionSubscription(sessionId, subscriptionId);
            removed = result?.removed ?? 1;
            if (result?.triggerType) {
                // The query parameter may target an ID whose trigger type differs
                // from the path target; report and fan out the real metadata.
                triggerType = result.triggerType;
            }
        } else {
            const result = await unsubscribeSessionFromTrigger(sessionId, triggerType);
            removed = result.removed;
        }

        if (removed === 0) {
            return Response.json({ error: `Subscription '${subscriptionId ?? triggerType}' not found` }, { status: 404 });
        }

        log.info(`Session ${sessionId} unsubscribed from trigger target '${subscriptionId ?? triggerType}'`);
        broadcastToSessionViewers(sessionId, "trigger_subscriptions_changed", { triggerType, action: "unsubscribe" });

        if (owner.runnerId) {
            // SECURITY: verify the persisted runner still belongs to the caller before
            // emitting a delta — a reclaimed runner must not receive cross-user subscription
            // mutation events.
            const unsubRunnerData = await getRunnerData(owner.runnerId).catch(() => null);
            if (!unsubRunnerData || unsubRunnerData.userId === identity.userId) {
                void emitTriggerSubscriptionDelta(owner.runnerId, {
                    action: "unsubscribe",
                    subscription: {
                        subscriptionId: subscriptionId ?? `legacy:all:${triggerType}`,
                        sessionId,
                        triggerType,
                        runnerId: owner.runnerId,
                    },
                });
            } else {
                log.warn(`subscription delete: runner ${owner.runnerId} belongs to a different user — skipping delta for session ${sessionId}`);
            }
        }

        return Response.json({ ok: true, ...(subscriptionId ? { subscriptionId } : {}), triggerType, removed });
    }

    // ── PUT /api/sessions/:id/trigger-subscriptions/:triggerType ──────
    // Update params/filters on an existing subscription without removing it.
    // Notifies the runner service so it can react to param changes.
    if (subsDeleteMatch && req.method === "PUT") {
        const identity = await authenticate(req);
        if (identity instanceof Response) return identity;

        const sessionId = decodeURIComponent(subsDeleteMatch[1]);
        const target = decodeURIComponent(subsDeleteMatch[2]);
        const subscriptionIdParam = url.searchParams.get("subscriptionId")?.trim() || undefined;

        // Same persisted fallback as GET/DELETE — editing a standing schedule
        // must not require its creating session to still be running.
        const owner = await resolveSubscriptionOwner(sessionId, identity.userId);
        if (!owner) {
            return Response.json({ error: "Session not found" }, { status: 404 });
        }

        let body: { params?: Record<string, unknown>; filters?: unknown[]; filterMode?: string };
        try {
            body = await req.json() as { params?: Record<string, unknown>; filters?: unknown[]; filterMode?: string };
        } catch {
            return Response.json({ error: "Invalid JSON body" }, { status: 400 });
        }

        const scheduleError = validateScheduleParams(target, body.params);
        if (scheduleError) return Response.json({ error: scheduleError }, { status: 400 });

        // Validate params against the runner's trigger def (if available)
        let subParams: SubscriptionParams | undefined;
        if (owner.runnerId) {
            const services = await getRunnerServices(owner.runnerId);
            const triggerDef = services?.triggerDefs?.find((d) => d.type === target);

            if (body.params && typeof body.params === "object" && !Array.isArray(body.params)) {
                const paramDefs = triggerDef?.params ?? [];
                const validated: SubscriptionParams = {};
                const errors: string[] = [];

                for (const def of paramDefs) {
                    const raw = body.params[def.name];
                    if (raw === undefined || raw === null) {
                        if (def.required) errors.push(`Missing required param '${def.name}'`);
                        continue;
                    }
                    if (def.multiselect && def.enum) {
                        const arr = Array.isArray(raw) ? raw : [raw];
                        const coerced: Array<string | number | boolean> = [];
                        for (const item of arr) {
                            if (def.type === "number") { const num = Number(item); if (!isNaN(num)) coerced.push(num); }
                            else if (def.type === "boolean") { if (item === true || item === "true") coerced.push(true); else if (item === false || item === "false") coerced.push(false); }
                            else { coerced.push(String(item)); }
                        }
                        // eslint-disable-next-line eqeqeq
                        const invalid = coerced.filter(v => !def.enum!.some(e => e == v));
                        if (invalid.length > 0) errors.push(`Param '${def.name}' contains invalid values: ${invalid.join(", ")}`);
                        else if (coerced.length > 0) validated[def.name] = coerced;
                        else if (def.required) errors.push(`Param '${def.name}' requires at least one valid value`);
                        continue;
                    }
                    if (def.type === "json") {
                        if (!isJsonValue(raw)) errors.push(`Param '${def.name}' must be valid JSON`);
                        else validated[def.name] = raw as SubscriptionParams[string];
                    } else if (def.type === "number") {
                        const num = Number(raw);
                        // eslint-disable-next-line eqeqeq
                        if (isNaN(num)) errors.push(`Param '${def.name}' must be a number`);
                        // eslint-disable-next-line eqeqeq
                        else if (def.enum && !def.enum.some(e => e == num)) errors.push(`Param '${def.name}' must be one of: ${def.enum.join(", ")}`);
                        else validated[def.name] = num;
                    } else if (def.type === "boolean") {
                        if (raw === true || raw === "true") validated[def.name] = true;
                        else if (raw === false || raw === "false") validated[def.name] = false;
                        else errors.push(`Param '${def.name}' must be a boolean`);
                    } else {
                        const val = String(raw);
                        // eslint-disable-next-line eqeqeq
                        if (def.enum && !def.enum.some(e => e == val)) errors.push(`Param '${def.name}' must be one of: ${def.enum.join(", ")}`);
                        else validated[def.name] = val;
                    }
                }
                // Accept extra params not in the def
                for (const [key, val] of Object.entries(body.params)) {
                    if (key in validated || paramDefs.some(d => d.name === key)) continue;
                    if (val === undefined || val === null) continue;
                    if (typeof val === "string" || typeof val === "number" || typeof val === "boolean") validated[key] = val;
                    else if (Array.isArray(val)) {
                        const primitives = val.filter((v: unknown): v is string | number | boolean => typeof v === "string" || typeof v === "number" || typeof v === "boolean");
                        if (primitives.length > 0) validated[key] = primitives;
                    }
                }
                if (errors.length > 0) return Response.json({ error: errors.join("; ") }, { status: 400 });
                if (Object.keys(validated).length > 0) subParams = validated;
            }
        }

        // Validate filters
        let subFilters: SubscriptionFilter[] | undefined;
        let subFilterMode: SubscriptionFilterMode | undefined;
        if (Array.isArray(body.filters) && body.filters.length > 0) {
            const services = owner.runnerId ? await getRunnerServices(owner.runnerId) : null;
            const triggerDef = services?.triggerDefs?.find((d) => d.type === target);
            const schemaProps = (triggerDef?.schema as any)?.properties ?? {};
            const validatedFilters: SubscriptionFilter[] = [];
            const filterErrors: string[] = [];
            for (const raw of body.filters) {
                if (!raw || typeof raw !== "object" || Array.isArray(raw)) { filterErrors.push("Each filter must be an object"); continue; }
                const f = raw as Record<string, unknown>;
                if (typeof f.field !== "string" || !f.field) { filterErrors.push("Filter missing 'field'"); continue; }
                if (f.value === undefined || f.value === null) { filterErrors.push(`Filter on '${f.field}' missing 'value'`); continue; }
                if (triggerDef?.schema && Object.keys(schemaProps).length > 0 && !(f.field in schemaProps)) {
                    filterErrors.push(`Filter field '${f.field}' is not in the trigger's output schema`);
                    continue;
                }
                const op = f.op === "contains" ? "contains" as const : "eq" as const;
                let value: string | number | boolean | Array<string | number | boolean>;
                if (Array.isArray(f.value)) {
                    value = f.value.filter((v: unknown): v is string | number | boolean => typeof v === "string" || typeof v === "number" || typeof v === "boolean");
                } else if (typeof f.value === "string" || typeof f.value === "number" || typeof f.value === "boolean") {
                    value = f.value;
                } else { value = String(f.value); }
                validatedFilters.push({ field: f.field, value, op });
            }
            if (filterErrors.length > 0) return Response.json({ error: filterErrors.join("; ") }, { status: 400 });
            if (validatedFilters.length > 0) subFilters = validatedFilters;
        }
        if (body.filterMode === "or" || body.filterMode === "and") subFilterMode = body.filterMode;

        const result = await updateSessionSubscription(sessionId, subscriptionIdParam ?? target, {
            params: subParams,
            filters: subFilters,
            filterMode: subFilterMode,
        });

        if (!result.updated) {
            return Response.json({ error: `Session is not subscribed to '${target}'` }, { status: 404 });
        }

        const logParts: string[] = [];
        if (subParams) logParts.push(`params=${JSON.stringify(subParams)}`);
        if (subFilters) logParts.push(`filters=${JSON.stringify(subFilters)} mode=${subFilterMode ?? "and"}`);
        const triggerType = result.triggerType ?? target;
        const subscriptionId = result.subscriptionId ?? subscriptionIdParam;
        log.info(`Session ${sessionId} updated subscription for '${target}'${logParts.length > 0 ? ` with ${logParts.join(", ")}` : ""}`);
        broadcastToSessionViewers(sessionId, "trigger_subscriptions_changed", { triggerType, action: "update" });

        // Notify the runner via typed delta.
        // The reconciliation protocol (trigger_subscription_delta) is the
        // authoritative path — the legacy subscription_params_changed event
        // has been removed to prevent double-apply.
        if (owner.runnerId) {
            // SECURITY: verify the persisted runner still belongs to the caller before
            // emitting a delta — a reclaimed runner must not receive cross-user subscription
            // mutation events.
            const updateRunnerData = await getRunnerData(owner.runnerId).catch(() => null);
            if (!updateRunnerData || updateRunnerData.userId === identity.userId) {
                void emitTriggerSubscriptionDelta(owner.runnerId, {
                    action: "update",
                    subscription: {
                        subscriptionId: subscriptionId ?? `legacy:all:${triggerType}`,
                        sessionId,
                        triggerType,
                        runnerId: owner.runnerId,
                        ...(subParams ? { params: subParams } : {}),
                        ...(subFilters ? { filters: subFilters } : {}),
                        ...(subFilterMode ? { filterMode: subFilterMode } : {}),
                    },
                });
            } else {
                log.warn(`subscription update: runner ${owner.runnerId} belongs to a different user — skipping delta for session ${sessionId}`);
            }
        }

        return Response.json({
            ok: true,
            ...(subscriptionId ? { subscriptionId } : {}),
            triggerType,
            runnerId: result.runnerId,
            ...(subParams ? { params: subParams } : {}),
            ...(subFilters ? { filters: subFilters } : {}),
            ...(subFilterMode ? { filterMode: subFilterMode } : {}),
        });
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

        // Verify the runner belongs to the authenticated user
        const runnerData = await getRunnerData(runnerId);
        if (!runnerData || runnerData.userId !== identity.userId) {
            return Response.json({ error: "Runner not found" }, { status: 404 });
        }

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

        // Default to "followUp" (non-interruptive) when omitted — matches the
        // documented default and the runner-services example template. A
        // service that wants to interrupt the current turn must opt in
        // explicitly with deliverAs: "steer".
        const deliverAs = body.deliverAs ?? "followUp";
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

        // Process all subscribers concurrently. Each subscriber's filtering,
        // ownership check, and delivery are independent; the only shared result
        // is the delivered count, which is summed from per-subscriber booleans.
        const deliveredResults = await Promise.all(
            subscriberIds.map(async (targetSessionId) => {
                const targetSession = await getSharedSession(targetSessionId);
                // Only deliver to sessions belonging to the same user (ownership check)
                // and sessions that are actually connected.
                if (!targetSession || targetSession.userId !== identity.userId) return false;

                // Re-check mode scope at fire time; modes and cwd can change after subscribe.
                const services = await getRunnerServices(runnerId);
                const triggerDef = services?.triggerDefs?.find((def) => def.type === body.type);
                if (triggerDef && !triggerAllowedForCwd(triggerDef, services?.sessionModes, targetSession.cwd, runnerId)) return false;

                // Filter by subscription filters (based on output schema fields).
                // New subscriptions always have a filterData result (even with filters=[]).
                // Legacy subscriptions return undefined and fall back to param matching.
                const filterData = normalizeFilterRecords(await getSubscriptionFilters(targetSessionId, body.type));
                if (filterData) {
                    const matchedAny = filterData.length === 0 || filterData.some((record) => filterRecordMatchesPayload(body.payload, record));
                    if (!matchedAny) return false;
                } else {
                    const subParams = await getSubscriptionParams(targetSessionId, body.type);
                    if (subParams) {
                        const legacyFilters = legacyParamsToFilters(subParams);
                        if (!payloadMatchesFilters(body.payload, legacyFilters, "and")) return false;
                    }
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
                        return true;
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
                    return true;
                }
                return false;
            }),
        );
        const delivered = deliveredResults.reduce((sum, didDeliver) => sum + (didDeliver ? 1 : 0), 0);

        // ── Runner-level auto-spawn listeners ──────────────────────────
        let spawned = 0;
        const listenerTypes = await getRunnerListenerTypes(runnerId);
        if (listenerTypes.includes(body.type)) {
            // Auto-spawn listeners support multiple rows for the same trigger type.
            // Looking up by trigger type returns only the newest row, which can drop
            // valid matches when older listeners have different params. Always load
            // the full listener list for broadcast matching.
            const listeners = (await listRunnerTriggerListeners(runnerId))
                .filter((listener) => listener.triggerType === body.type);
            const matchingListeners = listeners.filter((listener) => {
                if (listener.params && Object.keys(listener.params).length > 0) {
                    const listenerFilters = legacyParamsToFilters(listener.params);
                    return payloadMatchesFilters(body.payload, listenerFilters, "and");
                }
                return true;
            });
            for (const listener of matchingListeners) {
                const result = await spawnListenerSessionAndDeliver(runnerId, runnerData.userId, listener, {
                    type: body.type,
                    payload: body.payload,
                    summary: body.summary,
                    source: body.source ?? "service",
                    deliverAs,
                    expectsResponse: body.expectsResponse ?? false,
                    triggerId,
                    ts,
                });
                if (result.spawned) spawned++;
            }
        }

        log.info(`Broadcast trigger ${triggerId} (type=${body.type}) to ${delivered}/${subscriberIds.length} subscribers + ${spawned} spawned on runner ${runnerId}`);
        return Response.json({ ok: true, delivered, spawned, triggerId });
    }

    return undefined;
};
