/**
 * Route-sourced reconcile feed (ADR-0002, Phase 6).
 *
 * Runner services rebuild their in-memory state (timers, watchers) from
 * `trigger_subscriptions_snapshot` (on runner registration) and
 * `trigger_subscription_delta` events (on route changes). The reconcile
 * protocol keeps the subscription vocabulary, but since the legacy
 * subscription store is gone, the source of truth is the routes store:
 * every session-target Route IS a subscription (routeId = subscriptionId).
 *
 * ponytail: session targets carry the owning runnerId (stamped at write
 * time), so runner-scoped queries are linear scans over a small table —
 * add a runnerId column + index if route counts ever matter.
 */

import type { Route } from "@pizzapi/protocol";
import type { TriggerSubscriptionEntry } from "@pizzapi/protocol";
import { createLogger } from "@pizzapi/tools";
import { connectRedisClient, type RedisClient } from "../redis-client.js";
import { listRoutes } from "./store.js";
import { routeMatchesOwner } from "@pizzapi/protocol";
import { getRunnerOwner } from "../runner-owner.js";

const log = createLogger("routes-reconcile");

let _redis: RedisClient | null = null;
let _redisInit: Promise<RedisClient | null> | null = null;

async function getClient(): Promise<RedisClient | null> {
    if (_redis?.isOpen) return _redis;
    if (!_redisInit) {
        _redisInit = connectRedisClient().then((client) => {
            _redis = client;
            return client;
        });
    }
    try {
        return await _redisInit;
    } finally {
        _redisInit = null;
    }
}

/** Globally monotonic reconcile revision (Redis INCR; local fallback). */
const REVISION_KEY = "pizzapi:trigger:reconcile-revision";
let _localRevision = 0;
let _lastKnownRedisRevision = 0;

export async function nextReconcileRevision(): Promise<number> {
    const redis = await getClient();
    if (redis) {
        try {
            const revision = Number(await redis.incr(REVISION_KEY));
            _lastKnownRedisRevision = revision;
            return revision;
        } catch (err) {
            log.warn("reconcile revision INCR failed, using local counter:", err);
        }
    }
    if (_localRevision < _lastKnownRedisRevision) {
        _localRevision = _lastKnownRedisRevision;
    }
    return ++_localRevision;
}

/** Inject/reset Redis state for revision-order unit tests. */
export function _injectRedisForTesting(client: unknown): void {
    _redis = client as RedisClient;
    _redisInit = null;
}

export function _resetRedisForTesting(): void {
    _redis = null;
    _redisInit = null;
    _localRevision = 0;
    _lastKnownRedisRevision = 0;
}

/** Map a session-target route to the subscription shape services reconcile. */
export function routeToSubscription(route: Route): TriggerSubscriptionEntry | null {
    if (route.disabled === true) return null;
    if (route.target.kind !== "session") return null;
    if (!route.target.runnerId) return null; // never reachable without a runner
    return {
        subscriptionId: route.routeId,
        sessionId: route.target.sessionId,
        triggerType: route.eventType,
        runnerId: route.target.runnerId,
        ...(route.params ? { params: route.params as TriggerSubscriptionEntry["params"] } : {}),
        ...(route.filters && route.filters.length > 0 ? { filters: route.filters } : {}),
        ...(route.filterMode ? { filterMode: route.filterMode } : {}),
    };
}

/**
 * Snapshot for one runner: session-target routes stamped with this runner,
 * including schedules whose owning session is offline (schedules outlive
 * sessions by design). Replaces getSubscriptionsForRunnerSessions +
 * getSessionIdsWithSubscriptionsForRunner from the legacy store.
 */
export async function subscriptionsForRunner(runnerId: string): Promise<TriggerSubscriptionEntry[]> {
    // Tenant scope: a runner only reconciles routes owned by its current owner
    // (config routes without an owner are operator-level). A reclaimed runner
    // must not keep arming the previous owner's schedules.
    const owner = await runnerOwnerFor(runnerId);
    const routes = (await listRoutes()).filter((r) => routeMatchesOwner(r, owner ?? undefined));
    return routes
        .map(routeToSubscription)
        .filter((s): s is TriggerSubscriptionEntry => s !== null && s.runnerId === runnerId);
}

async function runnerOwnerFor(runnerId: string): Promise<string | null> {
    // Lazy import on purpose: this module sits at the store layer and is pulled
    // in by sio-registry/sessions.ts. A static import of the socket registry
    // creates a cycle back into sessions/store.js, which surfaces as
    // "Export named X not found" in any test that partially mocks that module.
    const { getRunnerData } = await import("../ws/sio-registry/runners.js");
    const live = await getRunnerData(runnerId).catch(() => null);
    if (live?.userId) return live.userId;
    return getRunnerOwner(runnerId);
}

/** Session ids that hold at least one route on this runner (offline included). */
export async function sessionIdsWithRoutesForRunner(runnerId: string): Promise<string[]> {
    const seen = new Set<string>();
    for (const sub of await subscriptionsForRunner(runnerId)) seen.add(sub.sessionId);
    return [...seen];
}

/**
 * Last-resort runner resolution for a session whose live and persisted
 * records are gone: any session-target route for the session carries the
 * runner it was (re)owned on.
 */
export async function durableRouteRunnerId(sessionId: string): Promise<string | null> {
    const routes = await listRoutes();
    for (const route of routes) {
        if (route.target.kind === "session" && route.target.sessionId === sessionId && route.target.runnerId) {
            return route.target.runnerId;
        }
    }
    return null;
}
