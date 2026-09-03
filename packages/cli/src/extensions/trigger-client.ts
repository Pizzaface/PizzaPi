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
    fetch: globalThis.fetch.bind(globalThis),
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
export async function getAvailableTriggers(
    sessionId: string,
    deps: Partial<TriggerClientDeps> = {},
): Promise<TriggerDef[]> {
    const d: TriggerClientDeps = { ...defaultDeps, ...deps };
    const baseUrl = d.getRelayHttpBaseUrl();
    const apiKey = d.getApiKey();

    if (!baseUrl || !apiKey) {
        log.info(`getAvailableTriggers: no baseUrl/apiKey, returning empty`);
        return [];
    }

    try {
        const url = `${baseUrl}/api/sessions/${encodeURIComponent(sessionId)}/available-triggers`;
        const response = await d.fetch(url, {
            headers: { "x-api-key": apiKey },
        });
        if (!response.ok) return [];
        const data = await response.json() as { triggerDefs?: TriggerDef[] };
        return data.triggerDefs ?? [];
    } catch (err) {
        log.info(`getAvailableTriggers failed: ${err instanceof Error ? err.message : String(err)}`);
        return [];
    }
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
                target: { kind: "session", sessionId },
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
): Promise<Array<{ routeId: string; eventType: string }>> {
    const baseUrl = d.getRelayHttpBaseUrl()!;
    const apiKey = d.getApiKey()!;
    const response = await d.fetch(`${baseUrl}/api/routes`, {
        headers: { "x-api-key": apiKey },
    });
    if (!response.ok) return [];
    const data = (await response.json().catch(() => ({}))) as { routes?: Array<any> };
    return (data.routes ?? [])
        .filter((r) => r?.target?.kind === "session" && r.target.sessionId === sessionId)
        .map((r) => ({ routeId: r.routeId as string, eventType: r.eventType as string }));
}

/**
 * List active trigger subscriptions (Routes) for a session.
 */
export async function listTriggerSubscriptions(
    sessionId: string,
    deps: Partial<TriggerClientDeps> = {},
): Promise<TriggerSubscription[]> {
    const d: TriggerClientDeps = { ...defaultDeps, ...deps };
    if (!d.getRelayHttpBaseUrl() || !d.getApiKey()) return [];
    try {
        const routes = await listRoutesForSession(d, sessionId);
        return routes.map((r) => ({ subscriptionId: r.routeId, triggerType: r.eventType, runnerId: "" }));
    } catch (err) {
        log.info(`listTriggerSubscriptions failed: ${err instanceof Error ? err.message : String(err)}`);
        return [];
    }
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
