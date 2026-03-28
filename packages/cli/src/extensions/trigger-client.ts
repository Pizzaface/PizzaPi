/**
 * Trigger Client — HTTP client for firing triggers into sessions.
 *
 * Provides a clean `fireTrigger(sessionId, params)` API that:
 * 1. Tries POST /api/sessions/:id/trigger via HTTP with API key auth
 * 2. Falls back to Socket.IO session_trigger emission if HTTP is unavailable
 *
 * Usage pattern for runner services (e.g. Godmother):
 *
 *   import { fireTrigger } from "../extensions/trigger-client.js";
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

import { randomUUID } from "node:crypto";
import { createLogger } from "@pizzapi/tools";
import { getRelaySocket as getRelaySocketDefault } from "./remote.js";
import { loadConfig } from "../config.js";

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
    triggerId?: string;
    /** Which transport was used for delivery */
    method: "http" | "socketio";
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

    const trimmed = configured.trim().replace(/\/$/, "").replace(/\/ws\/sessions$/, "");
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
 * Fire a trigger into a session via HTTP or Socket.IO fallback.
 *
 * Tries HTTP first (POST /api/sessions/:id/trigger with x-api-key auth).
 * Falls back to Socket.IO direct emission when:
 * - No base URL or API key is configured (offline mode)
 * - The HTTP request throws (network error, timeout)
 * - HTTP returns a 5xx or 503 error
 *
 * Auth errors (401/403) and not-found errors (404) are returned as definitive
 * failures without falling back to Socket.IO.
 *
 * @param sessionId Target session ID
 * @param params Trigger parameters
 * @param deps Optional dependency injection for testing
 */
export async function fireTrigger(
    sessionId: string,
    params: FireTriggerParams,
    deps: Partial<TriggerClientDeps> = {},
): Promise<FireTriggerResult> {
    const d: TriggerClientDeps = { ...defaultDeps, ...deps };

    const baseUrl = d.getRelayHttpBaseUrl();
    const apiKey = d.getApiKey();

    // Attempt HTTP delivery first
    if (baseUrl && apiKey) {
        try {
            const url = `${baseUrl}/api/sessions/${encodeURIComponent(sessionId)}/trigger`;
            const response = await d.fetch(url, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "x-api-key": apiKey,
                },
                body: JSON.stringify({
                    type: params.type,
                    payload: params.payload,
                    deliverAs: params.deliverAs ?? "steer",
                    expectsResponse: params.expectsResponse ?? false,
                    ...(params.source ? { source: params.source } : {}),
                    ...(params.summary ? { summary: params.summary } : {}),
                }),
            });

            if (response.ok) {
                const data = await response.json() as { ok: boolean; triggerId?: string };
                log.info(`Trigger ${data.triggerId} fired to session ${sessionId} via HTTP`);
                return { ok: true, triggerId: data.triggerId, method: "http" };
            }

            const errorBody = await response.json().catch(() => ({ error: "Unknown error" })) as { error?: string };
            const errorMsg = errorBody.error ?? `HTTP ${response.status}`;
            log.info(`HTTP trigger failed for session ${sessionId}: ${errorMsg}`);

            // Auth / not-found errors are definitive — no Socket.IO fallback
            if (response.status === 401 || response.status === 403) {
                return { ok: false, method: "http", error: `Authentication failed: ${errorMsg}` };
            }
            if (response.status === 404) {
                return { ok: false, method: "http", error: `Session not found: ${errorMsg}` };
            }
            // For 5xx / 503 / other errors, fall through to Socket.IO
        } catch (err) {
            log.info(
                `HTTP trigger request failed for session ${sessionId}: ` +
                (err instanceof Error ? err.message : String(err)),
            );
            // Network failure — fall through to Socket.IO
        }
    }

    // Socket.IO fallback (offline mode or HTTP transient failure).
    //
    // NOTE: session_trigger is fire-and-forget over Socket.IO — there is no
    // server-side acknowledgement event for trigger delivery failures (unlike
    // session_message which has session_message_error). This path returns
    // { ok: true } as soon as the emit succeeds at the socket layer, which
    // means a disconnected or non-existent target session will not surface as
    // an error here. Prefer the HTTP path (which validates the session exists
    // and returns 404/503 on failure) whenever a relay URL and API key are set.
    const conn = d.getRelaySocket();
    if (conn) {
        const triggerId = `ext_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
        try {
            conn.socket.emit("session_trigger" as any, {
                token: conn.token,
                trigger: {
                    type: params.type,
                    sourceSessionId: `external:${params.source ?? "trigger-client"}`,
                    sourceSessionName: params.summary ?? `Service (${params.source ?? "trigger-client"})`,
                    targetSessionId: sessionId,
                    payload: params.payload,
                    deliverAs: params.deliverAs ?? "steer",
                    expectsResponse: params.expectsResponse ?? false,
                    triggerId,
                    ts: new Date().toISOString(),
                },
            });
            log.info(`Trigger ${triggerId} fired to session ${sessionId} via Socket.IO fallback`);
            return { ok: true, triggerId, method: "socketio" };
        } catch (err) {
            return {
                ok: false,
                method: "socketio",
                error: `Socket.IO emit failed: ${err instanceof Error ? err.message : String(err)}`,
            };
        }
    }

    return {
        ok: false,
        method: "http",
        error: "Not connected to relay and HTTP is unavailable — cannot fire trigger",
    };
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
    };
}

// ── Subscription helpers ──────────────────────────────────────────────────────

export interface TriggerDef {
    type: string;
    label: string;
    description?: string;
    schema?: Record<string, unknown>;
}

export interface TriggerSubscription {
    triggerType: string;
    runnerId: string;
}

export interface SubscriptionResult {
    ok: boolean;
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
 * Subscribe a session to a trigger type.
 * The trigger type must be declared by a service on the session's runner.
 */
export async function subscribeTrigger(
    sessionId: string,
    triggerType: string,
    deps: Partial<TriggerClientDeps> = {},
): Promise<SubscriptionResult> {
    const d: TriggerClientDeps = { ...defaultDeps, ...deps };
    const baseUrl = d.getRelayHttpBaseUrl();
    const apiKey = d.getApiKey();

    if (!baseUrl || !apiKey) {
        return { ok: false, error: "No relay URL or API key configured" };
    }

    try {
        const url = `${baseUrl}/api/sessions/${encodeURIComponent(sessionId)}/trigger-subscriptions`;
        const response = await d.fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-api-key": apiKey },
            body: JSON.stringify({ triggerType }),
        });
        const data = await response.json() as { ok?: boolean; triggerType?: string; runnerId?: string; error?: string };
        if (response.ok && data.ok) {
            return { ok: true, triggerType: data.triggerType, runnerId: data.runnerId };
        }
        return { ok: false, error: data.error ?? `HTTP ${response.status}` };
    } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
}

/**
 * List active trigger subscriptions for a session.
 */
export async function listTriggerSubscriptions(
    sessionId: string,
    deps: Partial<TriggerClientDeps> = {},
): Promise<TriggerSubscription[]> {
    const d: TriggerClientDeps = { ...defaultDeps, ...deps };
    const baseUrl = d.getRelayHttpBaseUrl();
    const apiKey = d.getApiKey();

    if (!baseUrl || !apiKey) return [];

    try {
        const url = `${baseUrl}/api/sessions/${encodeURIComponent(sessionId)}/trigger-subscriptions`;
        const response = await d.fetch(url, {
            headers: { "x-api-key": apiKey },
        });
        if (!response.ok) return [];
        const data = await response.json() as { subscriptions?: TriggerSubscription[] };
        return data.subscriptions ?? [];
    } catch (err) {
        log.info(`listTriggerSubscriptions failed: ${err instanceof Error ? err.message : String(err)}`);
        return [];
    }
}

/**
 * Unsubscribe a session from a trigger type.
 */
export async function unsubscribeTrigger(
    sessionId: string,
    triggerType: string,
    deps: Partial<TriggerClientDeps> = {},
): Promise<SubscriptionResult> {
    const d: TriggerClientDeps = { ...defaultDeps, ...deps };
    const baseUrl = d.getRelayHttpBaseUrl();
    const apiKey = d.getApiKey();

    if (!baseUrl || !apiKey) {
        return { ok: false, error: "No relay URL or API key configured" };
    }

    try {
        const url = `${baseUrl}/api/sessions/${encodeURIComponent(sessionId)}/trigger-subscriptions/${encodeURIComponent(triggerType)}`;
        const response = await d.fetch(url, {
            method: "DELETE",
            headers: { "x-api-key": apiKey },
        });
        const data = await response.json() as { ok?: boolean; triggerType?: string; error?: string };
        if (response.ok && data.ok) {
            return { ok: true, triggerType: data.triggerType };
        }
        return { ok: false, error: data.error ?? `HTTP ${response.status}` };
    } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
}
