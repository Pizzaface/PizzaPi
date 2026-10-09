/**
 * Trigger Client — HTTP client for the unified trigger system (ADR-0002).
 *
 * `fireTrigger(sessionId, params)` publishes via POST /api/events with an
 * explicit target (the one fire path; no Socket.IO fallback). `publishEvent`
 * is the same thing without a forced target. Offline/local mode returns a
 * clear "requires relay" error.
 *
 *   import { publishEvent, fireTrigger } from "../extensions/trigger-client.js";
 *
 *   await fireTrigger("session-abc123", {
 *     type: "godmother:idea_started",
 *     payload: { ideaId: "idea-xyz", summary: "Fix the bug" },
 *     source: "godmother",
 *     deliverAs: "steer",
 *   });
 *
 * Or use `createTriggerClient()` for a bound client with fixed deps:
 *
 *   const client = createTriggerClient();
 *   await client.fire("session-abc", {
 *     type: "godmother:idea_started",
 *     payload: { ideaId: "xyz" },
 *   });
 */

import { createLogger } from "@pizzapi/tools";
import type { JsonValue } from "@pizzapi/protocol";
import type { ServiceSigilDef } from "@pizzapi/protocol";
import { getRelaySocket as getRelaySocketDefault } from "./remote.js";
import { loadConfig } from "../config.js";
import { normalizeLoopbackHost } from "../relay-url.js";

const log = createLogger("trigger-client");

// ── Types ─────────────────────────────────────────────────────────────────────

export interface FireTriggerParams {
    /** Trigger type — e.g. "service", "godmother:idea_started", "webhook" */
    type: string;
    /** Arbitrary payload delivered to the session */
    payload: Record<string, unknown>;
    /** How to deliver: "steer" (default) interrupts current turn, "followUp" queues after */
    deliverAs?: "steer" | "followUp";
    /** Whether the trigger expects a response from the session */
    expectsResponse?: boolean;
    /** Optional source identifier (e.g. "godmother", "github", "cron") */
    source?: string;
    /** Optional human-readable summary for the trigger */
    summary?: string;
}

export interface FireTriggerResult {
    ok: boolean;
    eventId?: string;
    error?: string;
}

// ── Dependency injection ───────────────────────────────────────────────────────

export interface TriggerClientDeps {
    getRelaySocket: typeof getRelaySocketDefault;
    getRelayHttpBaseUrl: () => string | null;
    getApiKey: () => string | undefined;
    fetch: (url: string, init?: RequestInit) => Promise<Response>;
}

function defaultGetRelayHttpBaseUrl(): string | null {
    const configured =
        process.env.PIZZAPI_RELAY_URL ??
        loadConfig(process.cwd()).relayUrl ??
        "ws://localhost:7492";

    if (configured.toLowerCase() === "off") return null;

    const trimmed = normalizeLoopbackHost(
        configured.trim().replace(/\/$/, "").replace(/\/ws\/sessions$/, ""),
    );
    if (trimmed.startsWith("ws://")) return `http://${trimmed.slice("ws://".length)}`;
    if (trimmed.startsWith("wss://")) return `https://${trimmed.slice("wss://".length)}`;
    if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) return trimmed;
    // No scheme — treat as a secure remote host
    return `https://${trimmed}`;
}

function defaultGetApiKey(): string | undefined {
    return (
        process.env.PIZZAPI_API_KEY ??
        process.env.PIZZAPI_API_TOKEN ??
        loadConfig(process.cwd()).apiKey
    );
}

const defaultDeps: TriggerClientDeps = {
    getRelaySocket: getRelaySocketDefault,
    getRelayHttpBaseUrl: defaultGetRelayHttpBaseUrl,
    getApiKey: defaultGetApiKey,
    fetch: (url, init) => globalThis.fetch(url, init),
};

// ── Core client ───────────────────────────────────────────────────────────────

/**
 * Fire a trigger into a session: publish an Event with an explicit target
 * (implicit single-session Route). HTTP only — there is no Socket.IO fire
 * fallback (ADR-0002); offline mode returns a clear error.
 *
 * Auth errors (401/403) and not-found errors (404) are definitive failures.
 * Transient failures (5xx, network) are returned as { ok: false, method-less }
 * for the caller's retry policy.
 */
export async function fireTrigger(
    sessionId: string,
    params: FireTriggerParams,
    deps: Partial<TriggerClientDeps> = {},
): Promise<FireTriggerResult> {
    const d: TriggerClientDeps = { ...defaultDeps, ...deps };
    const baseUrl = d.getRelayHttpBaseUrl();
    const apiKey = d.getApiKey();

    if (!baseUrl || !apiKey) {
        return {
            ok: false,
            error: "Not connected to relay — firing triggers requires a relay (PIZZAPI_RELAY_URL + PIZZAPI_API_KEY)",
        };
    }

    try {
        const result = await publishEvent({
            type: params.type,
            payload: params.payload,
            ...(params.summary ? { summary: params.summary } : {}),
            // Same bound TTL as the lifecycle publisher — an escalate:true
            // contract without ttlMs never expires, so escalation is dead.
            ...(params.expectsResponse ? { responseContract: { escalate: true, ttlMs: 30 * 60 * 1000 } } : {}),
            target: { sessionId, deliverAs: params.deliverAs ?? "steer" },
            ...(params.source ? { source: { id: params.source, name: params.source } } : {}),
        }, d);
        if (result.ok) {
            log.info(`Event ${result.eventId} (${params.type}) fired to session ${sessionId}`);
            return { ok: true, eventId: result.eventId };
        }
        return { ok: false, error: result.error ?? "Publish failed" };
    } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
}

/**
 * Create a bound trigger client with pre-configured dependencies.
 * Useful for services that need to fire triggers repeatedly without
 * passing deps on every call.
 *
 * @example
 * // In a runner service:
 * const triggerClient = createTriggerClient();
 *
 * // When an idea moves to "execute":
 * await triggerClient.fire(sessionId, {
 *   type: "godmother:idea_execute",
 *   payload: { ideaId: "idea-xyz", summary: "Fix the bug", project: "PizzaPi" },
 *   source: "godmother",
 *   deliverAs: "steer",
 * });
 */
export function createTriggerClient(deps: Partial<TriggerClientDeps> = {}) {
    return {
        fire: (sessionId: string, params: FireTriggerParams) =>
            fireTrigger(sessionId, params, deps),
        publish: (params: PublishEventParams) => publishEvent(params, deps),
    };
}

// ── Unified event publish / respond (ADR-0002) ────────────────────────────────

export interface PublishEventParams {
    /** Registered namespaced Event Type, e.g. "lifecycle:plan_review". */
    type: string;
    /** Optional route allowlist for route-specific event fires. */
    routeIds?: string[];
    payload?: Record<string, unknown>;
    summary?: string;
    /** Publisher's idempotency key + response-correlation id. */
    fireId?: string;
    responseContract?: { actions?: string[]; ttlMs?: number; escalate?: boolean };
    /** Direct target — an implicit single-session route (ownership-checked). */
    target?: { sessionId: string; deliverAs?: "steer" | "followUp" };
    /** Who is publishing. Sessions pass their relay session id. */
    source?: { kind?: "session" | "service" | "scheduler" | "api"; id?: string; name?: string };
}

export interface PublishEventResult {
    ok: boolean;
    eventId?: string;
    created?: boolean;
    deliveries?: Array<{ deliveryId: string; sessionId: string; status: string }>;
    error?: string;
    /** HTTP response status when publishing reached the relay but failed. */
    status?: number;
}

/**
 * Publish an Event through the unified engine (POST /api/events).
 * Routing decides recipients: the optional target is an implicit single-session
 * route; without one, existing routes for the event type deliver.
 */
export async function publishEvent(
    params: PublishEventParams,
    deps: Partial<TriggerClientDeps> = {},
): Promise<PublishEventResult> {
    const d: TriggerClientDeps = { ...defaultDeps, ...deps };
    const baseUrl = d.getRelayHttpBaseUrl();
    const apiKey = d.getApiKey();
    if (!baseUrl || !apiKey) {
        return { ok: false, error: "Not connected to relay — publishing events requires a relay (PIZZAPI_RELAY_URL + PIZZAPI_API_KEY)" };
    }

    try {
        const url = `${baseUrl}/api/events`;
        const response = await d.fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-api-key": apiKey },
            body: JSON.stringify(params),
        });
        const data = (await response.json().catch(() => ({}))) as PublishEventResult & { error?: string };
        if (response.ok && data.ok) {
            log.info(`Event ${data.eventId} (${params.type}) published — ${data.deliveries?.length ?? 0} deliveries`);
            return { ok: true, eventId: data.eventId, created: data.created, deliveries: data.deliveries };
        }
        return { ok: false, error: data.error ?? `HTTP ${response.status}`, status: response.status };
    } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
}

/**
 * Answer a contract-bearing Delivery (POST /api/deliveries/:id/response).
 * Returns { ok: false, notFound: true } when the delivery is unknown to the
 * engine — i.e. the trigger came through a legacy pathway (partial upgrades).
 */
export async function respondToDelivery(
    deliveryId: string,
    body: { response: string; action?: string },
    deps: Partial<TriggerClientDeps> = {},
): Promise<{ ok: boolean; relayed?: boolean; notFound?: boolean; error?: string }> {
    const d: TriggerClientDeps = { ...defaultDeps, ...deps };
    const baseUrl = d.getRelayHttpBaseUrl();
    const apiKey = d.getApiKey();
    if (!baseUrl || !apiKey) {
        return { ok: false, error: "Not connected to relay — responding requires a relay (PIZZAPI_RELAY_URL + PIZZAPI_API_KEY)" };
    }

    try {
        const url = `${baseUrl}/api/deliveries/${encodeURIComponent(deliveryId)}/response`;
        const response = await d.fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-api-key": apiKey },
            body: JSON.stringify(body),
        });
        if (response.status === 404) return { ok: false, notFound: true, error: "Delivery not found" };
        const data = (await response.json().catch(() => ({}))) as { ok?: boolean; relayed?: boolean; error?: string };
        if (response.ok && data.ok) return { ok: true, relayed: data.relayed };
        return { ok: false, error: data.error ?? `HTTP ${response.status}` };
    } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
}

// ── Subscription helpers ──────────────────────────────────────────────────────

export interface TriggerDef {
    type: string;
    label: string;
    description?: string;
    schema?: Record<string, unknown>;
    params?: Array<{ name: string; label: string; type: string; description?: string; required?: boolean; default?: string | number | boolean; enum?: Array<string | number | boolean>; multiselect?: boolean }>;
}

export interface TriggerSubscription {
    subscriptionId?: string;
    triggerType: string;
    runnerId: string;
    params?: Record<string, unknown>;
    filters?: Array<{ field: string; value: string | number | boolean | Array<string | number | boolean>; op?: "eq" | "contains"; caseSensitive?: boolean }>;
    filterMode?: "and" | "or";
}

export interface AvailableTriggerContext {
    runnerId?: string;
    triggerDefs: TriggerDef[];
}

/** Same data as the plain lookups below, but distinguishes "fetched
 *  successfully, nothing there" from "the fetch itself failed" (no relay
 *  creds, network error, non-OK status) — an outage must not look like an
 *  empty list to callers that print it or decide whether to re-subscribe. */
export interface AvailableTriggerContextStatus extends AvailableTriggerContext {
    ok: boolean;
    error?: string;
}

export interface RunnerTriggerListener {
    listenerId: string;
    triggerType: string;
    params?: Record<string, unknown>;
    filters?: Array<{ field: string; value: string | number | boolean | Array<string | number | boolean>; op?: "eq" | "contains"; caseSensitive?: boolean }>;
    filterMode?: "and" | "or";
    ownerSessionId?: string;
    ownerSessionName?: string | null;
    disabled?: boolean;
}

export interface TriggerSubscriptionsStatus {
    ok: boolean;
    error?: string;
    subscriptions: TriggerSubscription[];
}

export interface RunnerTriggerListenersStatus {
    ok: boolean;
    error?: string;
    listeners: RunnerTriggerListener[];
}

export type SigilDef = ServiceSigilDef;

export interface SubscriptionResult {
    ok: boolean;
    subscriptionId?: string;
    triggerType?: string;
    runnerId?: string;
    error?: string;
}

/**
 * Get available trigger types for a session (from its runner's service catalog).
 */
/**
 * Same as {@link getAvailableTriggerContext} but reports WHY the fetch came
 * back empty (no creds, network error, non-OK status) instead of collapsing
 * every failure mode into "no runner / no triggers".
 */
export async function getAvailableTriggerContextStatus(
    sessionId: string,
    deps: Partial<TriggerClientDeps> = {},
): Promise<AvailableTriggerContextStatus> {
    const d: TriggerClientDeps = { ...defaultDeps, ...deps };
    const baseUrl = d.getRelayHttpBaseUrl();
    const apiKey = d.getApiKey();

    if (!baseUrl || !apiKey) {
        return { ok: false, error: "Not connected to relay (no relay URL or API key configured)", triggerDefs: [] };
    }

    try {
        const url = `${baseUrl}/api/sessions/${encodeURIComponent(sessionId)}/available-triggers`;
        const response = await d.fetch(url, {
            headers: { "x-api-key": apiKey },
        });
        if (!response.ok) return { ok: false, error: `HTTP ${response.status}`, triggerDefs: [] };
        const data = await response.json() as { triggerDefs?: TriggerDef[]; runnerId?: string };
        return {
            ok: true,
            triggerDefs: data.triggerDefs ?? [],
            ...(typeof data.runnerId === "string" ? { runnerId: data.runnerId } : {}),
        };
    } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        log.info(`getAvailableTriggers failed: ${error}`);
        return { ok: false, error, triggerDefs: [] };
    }
}

export async function getAvailableTriggerContext(
    sessionId: string,
    deps: Partial<TriggerClientDeps> = {},
): Promise<AvailableTriggerContext> {
    const { ok: _ok, error: _error, ...context } = await getAvailableTriggerContextStatus(sessionId, deps);
    return context;
}

export async function getAvailableTriggers(
    sessionId: string,
    deps: Partial<TriggerClientDeps> = {},
): Promise<TriggerDef[]> {
    return (await getAvailableTriggerContext(sessionId, deps)).triggerDefs;
}

/**
 * Get available sigil types for a session (from its runner's service catalog).
 */
export async function getAvailableSigils(
    sessionId: string,
    deps: Partial<TriggerClientDeps> = {},
): Promise<SigilDef[]> {
    const d: TriggerClientDeps = { ...defaultDeps, ...deps };
    const baseUrl = d.getRelayHttpBaseUrl();
    const apiKey = d.getApiKey();

    if (!baseUrl || !apiKey) {
        log.info(`getAvailableSigils: no baseUrl/apiKey, returning empty`);
        return [];
    }

    try {
        const url = `${baseUrl}/api/sessions/${encodeURIComponent(sessionId)}/available-sigils`;
        const response = await d.fetch(url, {
            headers: { "x-api-key": apiKey },
        });
        if (!response.ok) return [];
        const data = await response.json() as { sigilDefs?: SigilDef[] };
        return data.sigilDefs ?? [];
    } catch (err) {
        log.info(`getAvailableSigils failed: ${err instanceof Error ? err.message : String(err)}`);
        return [];
    }
}

/**
 * Subscribe a session to an event type (unified model: a Route targeting this
 * session; ADR-0002). The runner learns of the route via reconcile snapshot/
 * delta so services rebuild their in-memory state.
 *
 * @param params Optional service params — forwarded to the owning service (not used for routing).
 * @param filters Optional delivery filters — conditions on the output payload fields.
 * @param filterMode How filters combine: "and" (default) or "or".
 */
export async function subscribeTrigger(
    sessionId: string,
    triggerType: string,
    deps: Partial<TriggerClientDeps> = {},
    params?: Record<string, JsonValue>,
    filters?: Array<{ field: string; value: string | number | boolean | Array<string | number | boolean>; op?: "eq" | "contains" }>,
    filterMode?: "and" | "or",
): Promise<SubscriptionResult> {
    const d: TriggerClientDeps = { ...defaultDeps, ...deps };
    const baseUrl = d.getRelayHttpBaseUrl();
    const apiKey = d.getApiKey();

    if (!baseUrl || !apiKey) {
        return { ok: false, error: "No relay URL or API key configured" };
    }

    try {
        const url = `${baseUrl}/api/routes`;
        const response = await d.fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-api-key": apiKey },
            body: JSON.stringify({
                eventType: triggerType,
                target: {
                    kind: "session",
                    sessionId,
                    ...(triggerType === "time:timer_fired" || triggerType === "time:at" || triggerType === "time:cron"
                        ? { offlinePolicy: "wake" as const }
                        : {}),
                },
                // Subscription semantics: a schedule or service event must not
                // interrupt an active turn unless it opts in — followUp default
                // (matches the runner-broadcast contract).
                deliverAs: "followUp",
                origin: "agent",
                ...(params && Object.keys(params).length > 0 ? { params } : {}),
                ...(filters && filters.length > 0 ? { filters } : {}),
                ...(filterMode ? { filterMode } : {}),
            }),
        });
        const data = (await response.json().catch(() => ({}))) as { ok?: boolean; route?: { routeId: string }; error?: string };
        if (response.ok && data.ok && data.route) {
            return { ok: true, subscriptionId: data.route.routeId, triggerType };
        }
        return { ok: false, error: data.error ?? `HTTP ${response.status}` };
    } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
}

/**
 * Update params/filters on an existing subscription (Route).
 * Targets by subscriptionId (the routeId) or by triggerType (bulk — updates
 * every route of that type targeting the session).
 */
export async function updateTriggerSubscription(
    sessionId: string,
    target: {
        subscriptionId?: string;
        triggerType?: string;
    },
    updates: {
        params?: Record<string, JsonValue>;
        filters?: Array<{ field: string; value: string | number | boolean | Array<string | number | boolean>; op?: "eq" | "contains" }>;
        filterMode?: "and" | "or";
    },
    deps: Partial<TriggerClientDeps> = {},
): Promise<SubscriptionResult> {
    const d: TriggerClientDeps = { ...defaultDeps, ...deps };
    const baseUrl = d.getRelayHttpBaseUrl();
    const apiKey = d.getApiKey();

    if (!baseUrl || !apiKey) {
        return { ok: false, error: "No relay URL or API key configured" };
    }

    try {
        const routeIds = target.subscriptionId
            ? [target.subscriptionId]
            : (await listRoutesForSession(d, sessionId))
                .filter((r) => r.eventType === target.triggerType)
                .map((r) => r.routeId);
        if (routeIds.length === 0) {
            return { ok: false, error: `No route found for type ${target.triggerType ?? "?"}` };
        }

        let lastOk = false;
        let lastId = target.subscriptionId;
        for (const routeId of routeIds) {
            const url = `${baseUrl}/api/routes/${encodeURIComponent(routeId)}`;
            const response = await d.fetch(url, {
                method: "PUT",
                headers: { "Content-Type": "application/json", "x-api-key": apiKey },
                body: JSON.stringify({
                    ...(updates.params && Object.keys(updates.params).length > 0 ? { params: updates.params } : {}),
                    ...(updates.filters && updates.filters.length > 0 ? { filters: updates.filters } : {}),
                    ...(updates.filterMode ? { filterMode: updates.filterMode } : {}),
                }),
            });
            const data = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string };
            lastOk = response.ok && !!data.ok;
            lastId = routeId;
            if (!lastOk) {
                return { ok: false, error: data.error ?? `HTTP ${response.status}` };
            }
        }
        return { ok: true, subscriptionId: lastId, triggerType: target.triggerType };
    } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
}

/** Session-target routes (subscriptions) for a session, via GET /api/routes. */
async function listRoutesForSession(
    d: TriggerClientDeps,
    sessionId: string,
): Promise<Array<{ routeId: string; eventType: string; params?: Record<string, unknown>; filters?: TriggerSubscription["filters"]; filterMode?: "and" | "or" }>> {
    const baseUrl = d.getRelayHttpBaseUrl()!;
    const apiKey = d.getApiKey()!;
    const response = await d.fetch(`${baseUrl}/api/routes`, {
        headers: { "x-api-key": apiKey },
    });
    // Non-OK is a real failure, not "no routes" — throw so callers can tell
    // an outage apart from a genuinely empty list (caught by every caller
    // below, so this is not a behavior change for them).
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = (await response.json().catch(() => ({}))) as { routes?: Array<any> };
    return (data.routes ?? [])
        .filter((r) => r?.target?.kind === "session" && r.target.sessionId === sessionId)
        .map((r) => ({
            routeId: r.routeId as string,
            eventType: r.eventType as string,
            ...(r.params && typeof r.params === "object" && !Array.isArray(r.params) ? { params: r.params as Record<string, unknown> } : {}),
            ...(Array.isArray(r.filters) ? { filters: r.filters as TriggerSubscription["filters"] } : {}),
            ...(r.filterMode === "or" ? { filterMode: "or" as const } : r.filterMode === "and" ? { filterMode: "and" as const } : {}),
        }));
}

/**
 * Same as {@link listTriggerSubscriptions} but distinguishes a fetch failure
 * (no creds, network error, non-OK status) from a genuinely empty list.
 */
export async function listTriggerSubscriptionsStatus(
    sessionId: string,
    deps: Partial<TriggerClientDeps> = {},
): Promise<TriggerSubscriptionsStatus> {
    const d: TriggerClientDeps = { ...defaultDeps, ...deps };
    if (!d.getRelayHttpBaseUrl() || !d.getApiKey()) {
        return { ok: false, error: "Not connected to relay (no relay URL or API key configured)", subscriptions: [] };
    }
    try {
        const routes = await listRoutesForSession(d, sessionId);
        return {
            ok: true,
            subscriptions: routes.map((r) => ({
                subscriptionId: r.routeId,
                triggerType: r.eventType,
                runnerId: "",
                ...(r.params ? { params: r.params } : {}),
                ...(r.filters ? { filters: r.filters } : {}),
                ...(r.filterMode ? { filterMode: r.filterMode } : {}),
            })),
        };
    } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        log.info(`listTriggerSubscriptions failed: ${error}`);
        return { ok: false, error, subscriptions: [] };
    }
}

/**
 * List active trigger subscriptions (Routes) for a session.
 */
export async function listTriggerSubscriptions(
    sessionId: string,
    deps: Partial<TriggerClientDeps> = {},
): Promise<TriggerSubscription[]> {
    return (await listTriggerSubscriptionsStatus(sessionId, deps)).subscriptions;
}

/**
 * Same as {@link listRunnerTriggerListeners} but distinguishes a fetch
 * failure (no creds, network error, non-OK status) from a genuinely empty
 * list — an outage must not look like "this runner has no listeners".
 */
export async function listRunnerTriggerListenersStatus(
    runnerId: string,
    deps: Partial<TriggerClientDeps> = {},
): Promise<RunnerTriggerListenersStatus> {
    const d: TriggerClientDeps = { ...defaultDeps, ...deps };
    const baseUrl = d.getRelayHttpBaseUrl();
    const apiKey = d.getApiKey();
    if (!baseUrl || !apiKey) {
        return { ok: false, error: "Not connected to relay (no relay URL or API key configured)", listeners: [] };
    }
    try {
        const response = await d.fetch(`${baseUrl}/api/runners/${encodeURIComponent(runnerId)}/trigger-listeners`, {
            headers: { "x-api-key": apiKey },
        });
        if (!response.ok) return { ok: false, error: `HTTP ${response.status}`, listeners: [] };
        const data = (await response.json().catch(() => ({}))) as { listeners?: RunnerTriggerListener[] };
        return { ok: true, listeners: data.listeners ?? [] };
    } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        log.info(`listRunnerTriggerListeners failed: ${error}`);
        return { ok: false, error, listeners: [] };
    }
}

/** List runner-global trigger listeners for a runner. */
export async function listRunnerTriggerListeners(
    runnerId: string,
    deps: Partial<TriggerClientDeps> = {},
): Promise<RunnerTriggerListener[]> {
    return (await listRunnerTriggerListenersStatus(runnerId, deps)).listeners;
}

/**
 * Unsubscribe a session from an event type (deletes the Route).
 * Targets by subscriptionId (the routeId) or by triggerType (bulk).
 */
export async function unsubscribeTrigger(
    sessionId: string,
    target: {
        subscriptionId?: string;
        triggerType?: string;
    },
    deps: Partial<TriggerClientDeps> = {},
): Promise<SubscriptionResult> {
    const d: TriggerClientDeps = { ...defaultDeps, ...deps };
    const baseUrl = d.getRelayHttpBaseUrl();
    const apiKey = d.getApiKey();

    if (!baseUrl || !apiKey) {
        return { ok: false, error: "No relay URL or API key configured" };
    }

    try {
        const routeIds = target.subscriptionId
            ? [target.subscriptionId]
            : (await listRoutesForSession(d, sessionId))
                .filter((r) => r.eventType === target.triggerType)
                .map((r) => r.routeId);
        if (routeIds.length === 0) {
            // Idempotent: nothing to unsubscribe is success (matches the
            // legacy endpoint's semantics).
            return { ok: true, triggerType: target.triggerType };
        }

        let lastId = target.subscriptionId;
        for (const routeId of routeIds) {
            const url = `${baseUrl}/api/routes/${encodeURIComponent(routeId)}`;
            const response = await d.fetch(url, {
                method: "DELETE",
                headers: { "x-api-key": apiKey },
            });
            const data = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string };
            if (!response.ok || !data.ok) {
                return { ok: false, error: data.error ?? `HTTP ${response.status}` };
            }
            lastId = routeId;
        }
        return { ok: true, subscriptionId: lastId, triggerType: target.triggerType };
    } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
}

/**
 * Clear a session's server-side trigger history (DELETE /api/sessions/:id/triggers).
 *
 * This is the authoritative call for "this is a new conversation generation,
 * forget the old trigger history" — it must be driven from the CLI's
 * generation-aware transition cleanup (performSessionTransitionCleanup), not
 * reactively from a UI event handler. Calling it from the UI only (keyed off
 * a specific exec_result like new_session) raced with the server-authoritative
 * cleanup: a late history write from the old generation could land after the
 * UI's DELETE, or the DELETE itself could arrive late and wipe the new
 * generation's just-recorded history.
 *
 * This call is fire-and-forget at the call site (see lifecycle-handlers.ts)
 * and the request itself can be delayed in transit, so `before` travels with
 * it as a cutoff captured at the moment the caller decided to transition. The
 * server only hides history recorded at or before that instant, so a
 * slow-to-arrive request can never erase the next generation's
 * already-recorded history no matter how long it takes to get here (see GM
 * a8yAXXwa / trigger-store.ts).
 *
 * `before` MUST be expressed in the relay's clock, not this host's raw local
 * one — the server compares it directly against relay-local timestamps, and
 * cross-host clock skew breaks that comparison in either direction (see
 * trigger-store.ts's `clearTriggerHistory` doc comment). The default below
 * (bare `Date.now()`) is an uncorrected fallback for callers with no offset
 * tracking; the authoritative call site in `performSessionTransitionCleanup`
 * always passes an explicit, relay-clock-corrected value using the same
 * `serverClockOffset` tracking `delink-management.ts` uses for epoch-based
 * delink filtering (see GM a8yAXXwa round 2).
 */
export async function clearTriggerHistory(
    sessionId: string,
    deps: Partial<TriggerClientDeps> = {},
    before: number = Date.now(),
): Promise<SubscriptionResult> {
    const d: TriggerClientDeps = { ...defaultDeps, ...deps };
    const baseUrl = d.getRelayHttpBaseUrl();
    const apiKey = d.getApiKey();

    if (!baseUrl || !apiKey) {
        return { ok: false, error: "No relay URL or API key configured" };
    }

    try {
        const url = `${baseUrl}/api/sessions/${encodeURIComponent(sessionId)}/triggers?before=${encodeURIComponent(String(before))}`;
        const response = await d.fetch(url, {
            method: "DELETE",
            headers: { "x-api-key": apiKey },
        });
        const data = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string };
        if (!response.ok || !data.ok) {
            return { ok: false, error: data.error ?? `HTTP ${response.status}` };
        }
        return { ok: true };
    } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
}
