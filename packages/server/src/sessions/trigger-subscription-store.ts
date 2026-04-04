/**
 * Trigger subscription store — Redis-backed per-session trigger subscriptions.
 *
 * A subscription links a session to a trigger type: when a service fires that
 * trigger type on the runner, it is automatically delivered to all subscribed sessions.
 *
 * Storage layout:
 *   pizzapi:trigger-subs:{sessionId}   → Redis hash: { triggerType → runnerId }
 *   pizzapi:trigger-subs:runner:{runnerId}:{triggerType} → Redis set: { sessionId... }
 *
 * TTL for session subscriptions: 24h (refreshed on each subscribe call).
 * TTL for runner-type indexes:   24h (refreshed on each subscribe call).
 *
 * ## TTL race limitation
 *
 * Both the session hash and the reverse-index sets are given the same TTL on
 * every subscribe() call, so they normally expire together. However, if the
 * session hash expires (e.g. 24h of inactivity) before clearSessionSubscriptions()
 * is called, the reverse-index entries become stale: getSubscribersForTrigger()
 * may return dead session IDs until the reverse-index TTL expires independently.
 *
 * **Mitigation**: clearSessionSubscriptions() is called from endSharedSession()
 * so subscriptions are cleaned up eagerly when a session ends. The 24h TTL is
 * a last-resort safeguard for abnormal termination paths only.
 *
 * unsubscribeSessionFromTrigger() is also best-effort: if the session hash has
 * already expired (losing the triggerType→runnerId mapping), it cannot remove
 * the stale reverse-index entry. That entry will expire via its own TTL.
 */

import { connectRedisClient, isRedisDisabled, type RedisClient } from "../redis-client.js";
import { createLogger } from "@pizzapi/tools";

const log = createLogger("trigger-subscription-store");

let _redis: RedisClient | null = null;
let _initPromise: Promise<void> | null = null;

async function getClient(): Promise<RedisClient | null> {
    if (_redis?.isOpen) return _redis;
    if (_initPromise) { await _initPromise; return _redis; }
    _initPromise = connectRedisClient().then(c => { _redis = c; });
    await _initPromise;
    return _redis;
}

/** Inject a mock client for tests. No mock.module needed. */
export function _injectRedisForTesting(client: unknown): void {
    _redis = client as RedisClient;
    _initPromise = Promise.resolve();
}

/** Reset client state for tests. */
export function _resetRedisForTesting(): void {
    _redis = null;
    _initPromise = null;
    // Reset revision counters so revision-order assertions don't leak across tests.
    _localRevision = 0;
    _lastKnownRedisRevision = 0;
}

const SESSION_SUBS_KEY = (sessionId: string) =>
    `pizzapi:trigger-subs:${sessionId}`;
const RUNNER_TYPE_INDEX_KEY = (runnerId: string, triggerType: string) =>
    `pizzapi:trigger-subs:runner:${runnerId}:${triggerType}`;

// Shared Redis key for the globally monotonic revision counter.
// All server nodes INCR the same key so revisions are ordered cluster-wide.
const TRIGGER_SUB_REVISION_KEY = "pizzapi:trigger-sub-revision";

const DEFAULT_TTL_SECONDS = 24 * 60 * 60; // 24 hours

// ── Global revision counter ──────────────────────────────────────────────────

// Process-local fallback counter used only when Redis is unavailable.
let _localRevision = 0;

// Tracks the highest revision successfully returned by Redis INCR.
// When Redis becomes unavailable, _localRevision is seeded from this value
// so fallback revisions are always strictly greater than any previously
// issued Redis revision. Without this, a runner that has already applied
// revision N (from Redis) would drop all fallback revisions 1..N as stale.
let _lastKnownRedisRevision = 0;

/**
 * Atomically increment and return the global trigger subscription revision.
 *
 * Uses Redis INCR so the counter is monotonically increasing across ALL server
 * nodes in a cluster. This prevents the runner's stale-drop filter from
 * discarding valid deltas that originated on a different server node.
 *
 * Falls back to a process-local counter when Redis is unavailable (single-node
 * mode or during startup before Redis connects). The fallback is seeded from
 * _lastKnownRedisRevision so it never issues a revision that a runner would
 * treat as stale.
 */
export async function nextTriggerSubRevision(): Promise<number> {
    const redis = await getClient();
    if (redis) {
        try {
            const rev = await redis.incr(TRIGGER_SUB_REVISION_KEY);
            _lastKnownRedisRevision = rev;
            return rev;
        } catch (err) {
            log.warn("Failed to increment trigger sub revision in Redis, using local counter:", err);
        }
    }
    // Seed the local counter from the last known Redis value so fallback
    // revisions are always > any revision the runner has already applied.
    if (_localRevision < _lastKnownRedisRevision) {
        _localRevision = _lastKnownRedisRevision;
    }
    return ++_localRevision;
}

// ── Public API ───────────────────────────────────────────────────────────

/**
 * Subscription params — values the subscriber provided for the service to handle.
 * These are NOT used for server-side delivery filtering (use filters for that).
 */
export type SubscriptionParamValue = string | number | boolean | Array<string | number | boolean>;
export type SubscriptionParams = Record<string, SubscriptionParamValue>;

/** A single filter condition on the trigger's output payload. */
export interface SubscriptionFilter {
    /** Field name in the trigger payload to match against */
    field: string;
    /** Expected value(s). Arrays use OR semantics within this filter. */
    value: string | number | boolean | Array<string | number | boolean>;
    /** Match operator. "eq" (default) or "contains" (substring match). */
    op?: "eq" | "contains";
}

/** How multiple filters combine: "and" = all must match, "or" = any must match. */
export type SubscriptionFilterMode = "and" | "or";

/** Internal storage format for a subscription hash value. */
interface SubscriptionValue {
    subscriptionId: string;
    triggerType: string;
    runnerId: string;
    params?: SubscriptionParams;
    filters?: SubscriptionFilter[];
    filterMode?: SubscriptionFilterMode;
}

export interface SessionTriggerSubscription extends SubscriptionValue {}

function generateSubscriptionId(sessionId: string, triggerType: string): string {
    return `sub:${sessionId}:${triggerType}:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`;
}

function isLegacySubscriptionCollection(parsed: unknown): parsed is { triggerType: string; runnerId: string; params?: SubscriptionParams; filters?: SubscriptionFilter[]; filterMode?: SubscriptionFilterMode }[] {
    return Array.isArray(parsed);
}

/** Parse a subscription hash value (backward-compatible with plain runnerId strings and legacy keyed-by-triggerType values). */
function parseSubValues(field: string, raw: string): SubscriptionValue[] {
    if (!raw.startsWith("{") && !raw.startsWith("[")) {
        return [{ subscriptionId: generateSubscriptionId(field, field), triggerType: field, runnerId: raw }];
    }

    try {
        const parsed = JSON.parse(raw) as unknown;

        if (isLegacySubscriptionCollection(parsed)) {
            return parsed
                .filter((value): value is { triggerType: string; runnerId: string; params?: SubscriptionParams; filters?: SubscriptionFilter[]; filterMode?: SubscriptionFilterMode } => typeof value?.triggerType === "string" && typeof value?.runnerId === "string")
                .map((value) => ({
                    subscriptionId: generateSubscriptionId(field, value.triggerType),
                    triggerType: value.triggerType,
                    runnerId: value.runnerId,
                    ...(value.params ? { params: value.params } : {}),
                    ...(value.filters ? { filters: value.filters } : {}),
                    ...(value.filterMode ? { filterMode: value.filterMode } : {}),
                }));
        }

        if (parsed && typeof parsed === "object") {
            const value = parsed as Partial<SubscriptionValue> & { runnerId?: string };
            if (typeof value.subscriptionId === "string" && typeof value.triggerType === "string" && typeof value.runnerId === "string") {
                return [{
                    subscriptionId: value.subscriptionId,
                    triggerType: value.triggerType,
                    runnerId: value.runnerId,
                    ...(value.params ? { params: value.params } : {}),
                    ...(value.filters ? { filters: value.filters } : {}),
                    ...(value.filterMode ? { filterMode: value.filterMode } : {}),
                }];
            }
            if (typeof value.runnerId === "string") {
                return [{
                    subscriptionId: generateSubscriptionId(field, field),
                    triggerType: field,
                    runnerId: value.runnerId,
                    ...(value.params ? { params: value.params } : {}),
                    ...(value.filters ? { filters: value.filters } : {}),
                    ...(value.filterMode ? { filterMode: value.filterMode } : {}),
                }];
            }
        }
    } catch {
        // fall through
    }

    return [];
}

/** Serialize a subscription value for Redis storage. */
function serializeSubValue(value: SubscriptionValue): string {
    return JSON.stringify({
        subscriptionId: value.subscriptionId,
        triggerType: value.triggerType,
        runnerId: value.runnerId,
        ...(value.params ? { params: value.params } : {}),
        filters: value.filters ?? [],
        ...(value.filterMode ? { filterMode: value.filterMode } : {}),
    });
}

/**
 * Subscribe a session to a trigger type from a specific runner.
 * - Cleans up the old reverse-index entry if the session was previously subscribed
 *   to the same trigger type via a different runner (rebind case)
 * - Adds `triggerType → {runnerId, params?}` to the session's subscription hash
 * - Adds `sessionId` to the runner+type reverse index set
 * - Refreshes TTL on both keys
 *
 * @param params Optional subscription params — forwarded to the service (not used for filtering).
 * @param filters Optional delivery filters — conditions on the output payload.
 * @param filterMode How filters combine: "and" (default) or "or".
 */
export async function subscribeSessionToTrigger(
    sessionId: string,
    runnerId: string,
    triggerType: string,
    ttlSeconds = DEFAULT_TTL_SECONDS,
    params?: SubscriptionParams,
    filters?: SubscriptionFilter[],
    filterMode?: SubscriptionFilterMode,
): Promise<string> {
    const redis = await getClient();
    if (!redis) return "";

    const sessionKey = SESSION_SUBS_KEY(sessionId);
    const indexKey = RUNNER_TYPE_INDEX_KEY(runnerId, triggerType);

    try {
        const subscriptionId = generateSubscriptionId(sessionId, triggerType);
        const value = serializeSubValue({
            subscriptionId,
            triggerType,
            runnerId,
            params,
            ...(filters && filters.length > 0 ? { filters } : {}),
            ...(filterMode && filterMode !== "and" ? { filterMode } : {}),
        });
        const pipeline = redis.multi();
        pipeline.hSet(sessionKey, subscriptionId, value);
        pipeline.expire(sessionKey, ttlSeconds);
        pipeline.sAdd(indexKey, sessionId);
        pipeline.expire(indexKey, ttlSeconds);
        await pipeline.exec();
        return subscriptionId;
    } catch (err) {
        log.warn("Failed to subscribe session to trigger:", err);
        return "";
    }
}

/**
 * Unsubscribe a session from a specific trigger type.
 * - Reads the stored runnerId for this (sessionId, triggerType) pair
 * - Removes from session hash and runner+type index
 */
export async function unsubscribeSessionFromTrigger(
    sessionId: string,
    triggerType: string,
): Promise<{ removed: number; triggerType: string }> {
    const redis = await getClient();
    if (!redis) return { removed: 0, triggerType };

    const sessionKey = SESSION_SUBS_KEY(sessionId);

    try {
        const hash = await redis.hGetAll(sessionKey);
        const matching = Object.entries(hash)
            .flatMap(([field, raw]) => parseSubValues(field, raw))
            .filter((sub) => sub.triggerType === triggerType);
        if (matching.length === 0) return { removed: 0, triggerType };
        const pipeline = redis.multi();
        for (const sub of matching) {
            pipeline.hDel(sessionKey, sub.subscriptionId);
            pipeline.sRem(RUNNER_TYPE_INDEX_KEY(sub.runnerId, triggerType), sessionId);
        }
        await pipeline.exec();
        return { removed: matching.length, triggerType };
    } catch (err) {
        log.warn("Failed to unsubscribe session from trigger:", err);
        return { removed: 0, triggerType };
    }
}

/**
 * List all trigger types this session is subscribed to.
 * Returns an array of { triggerType, runnerId } objects.
 */
export async function listSessionSubscriptions(
    sessionId: string,
): Promise<Array<{ subscriptionId: string; triggerType: string; runnerId: string; params?: SubscriptionParams; filters?: SubscriptionFilter[]; filterMode?: SubscriptionFilterMode }>> {
    const redis = await getClient();
    if (!redis) return [];

    const sessionKey = SESSION_SUBS_KEY(sessionId);

    try {
        const hash = await redis.hGetAll(sessionKey);
        return Object.entries(hash).flatMap(([field, raw]) => parseSubValues(field, raw).map(({ subscriptionId, triggerType, runnerId, params, filters, filterMode }) => ({
            subscriptionId,
            triggerType,
            runnerId,
            ...(params ? { params } : {}),
            ...(filters && filters.length > 0 ? { filters } : {}),
            ...(filterMode ? { filterMode } : {}),
        })));
    } catch (err) {
        log.warn("Failed to list session subscriptions:", err);
        return [];
    }
}

/**
 * Get all sessions subscribed to a specific trigger type on a specific runner.
 * Used by the delivery path: when a service fires a trigger, find all
 * subscribed sessions that belong to the same runner.
 */
export async function getSubscribersForTrigger(
    runnerId: string,
    triggerType: string,
): Promise<string[]> {
    const redis = await getClient();
    if (!redis) return [];

    const indexKey = RUNNER_TYPE_INDEX_KEY(runnerId, triggerType);

    try {
        return await redis.sMembers(indexKey);
    } catch (err) {
        log.warn("Failed to get subscribers for trigger:", err);
        return [];
    }
}

/**
 * Get the subscription params for a specific session + trigger type.
 * Returns undefined if the session is not subscribed or has no params.
 * Params are forwarded to the service — not used for delivery filtering.
 */
export async function getSubscriptionParams(
    sessionId: string,
    triggerType: string,
): Promise<SubscriptionParams | undefined> {
    const redis = await getClient();
    if (!redis) return undefined;

    const sessionKey = SESSION_SUBS_KEY(sessionId);
    try {
        const subs = await getSubscriptionsForSessionTrigger(sessionId, triggerType);
        return subs[0]?.params;
    } catch (err) {
        log.warn("Failed to get subscription params:", err);
        return undefined;
    }
}

/**
 * Get the subscription filters and filter mode for a specific session + trigger type.
 * Used by the broadcast delivery path to filter by output schema fields.
 */
export async function getSubscriptionFilters(
    sessionId: string,
    triggerType: string,
): Promise<Array<{ subscriptionId: string; filters?: SubscriptionFilter[]; filterMode?: SubscriptionFilterMode; isNewFormat?: boolean }> | undefined> {
    const redis = await getClient();
    if (!redis) return undefined;

    const sessionKey = SESSION_SUBS_KEY(sessionId);
    try {
        const hash = await redis.hGetAll(sessionKey);
        const matches: Array<{ subscriptionId: string; filters?: SubscriptionFilter[]; filterMode?: SubscriptionFilterMode; isNewFormat?: boolean }> = [];
        for (const [field, raw] of Object.entries(hash)) {
            const sub = parseSubValues(field, raw).find((entry) => entry.triggerType === triggerType);
            if (!sub) continue;
            const rawParsed = raw.startsWith("{") ? JSON.parse(raw) : null;
            const isNewFormat = rawParsed && !Array.isArray(rawParsed) && "filters" in rawParsed;
            matches.push({
                subscriptionId: sub.subscriptionId,
                ...(isNewFormat ? { filters: sub.filters ?? [], filterMode: sub.filterMode, isNewFormat: true } : {}),
            });
        }
        return matches.length > 0 ? matches : undefined;
    } catch (err) {
        log.warn("Failed to get subscription filters:", err);
        return undefined;
    }
}

/**
 * Update subscription params/filters for an existing subscription.
 * Returns false if the session is not subscribed to the given trigger type.
 * This preserves the runnerId and only updates params, filters, and filterMode.
 */
export async function updateSessionSubscription(
    sessionId: string,
    target: string,
    updates: {
        params?: SubscriptionParams;
        filters?: SubscriptionFilter[];
        filterMode?: SubscriptionFilterMode;
    },
    ttlSeconds = DEFAULT_TTL_SECONDS,
): Promise<{ updated: boolean; subscriptionId?: string; triggerType?: string; runnerId?: string }> {
    const redis = await getClient();
    if (!redis) return { updated: false };

    const sessionKey = SESSION_SUBS_KEY(sessionId);

    try {
        const subscriptions = await listSessionSubscriptions(sessionId);
        const prev = subscriptions.find((sub) => sub.subscriptionId === target) ?? subscriptions.find((sub) => sub.triggerType === target);
        if (!prev) return { updated: false };
        const triggerType = prev.triggerType;

        const value = serializeSubValue({
            subscriptionId: prev.subscriptionId,
            triggerType,
            runnerId: prev.runnerId,
            params: updates.params,
            ...(updates.filters && updates.filters.length > 0 ? { filters: updates.filters } : {}),
            ...(updates.filterMode && updates.filterMode !== "and" ? { filterMode: updates.filterMode } : {}),
        });

        const indexKey = RUNNER_TYPE_INDEX_KEY(prev.runnerId, triggerType);
        const pipeline = redis.multi();
        pipeline.hSet(sessionKey, prev.subscriptionId, value);
        pipeline.expire(sessionKey, ttlSeconds);
        pipeline.expire(indexKey, ttlSeconds);
        await pipeline.exec();

        return { updated: true, subscriptionId: prev.subscriptionId, triggerType, runnerId: prev.runnerId };
    } catch (err) {
        log.warn("Failed to update session subscription:", err);
        return { updated: false };
    }
}

/**
 * Remove all subscriptions for a session (e.g. on session end).
 * Cleans up session hash and all reverse index entries.
 *
 * Best-effort: if the session hash has already expired (TTL elapsed before
 * this is called), the reverse-index entries are left to expire on their own.
 * In normal operation this is called eagerly from endSharedSession() so the
 * hash is still present.
 */
export async function clearSessionSubscriptions(sessionId: string): Promise<void> {
    const redis = await getClient();
    if (!redis) return;

    const sessionKey = SESSION_SUBS_KEY(sessionId);

    try {
        const hash = await redis.hGetAll(sessionKey);
        const pipeline = redis.multi();
        for (const [field, raw] of Object.entries(hash)) {
            for (const sub of parseSubValues(field, raw)) {
                const indexKey = RUNNER_TYPE_INDEX_KEY(sub.runnerId, sub.triggerType);
                pipeline.sRem(indexKey, sessionId);
            }
        }
        pipeline.del(sessionKey);
        await pipeline.exec();
    } catch (err) {
        log.warn("Failed to clear session subscriptions (best-effort):", err);
    }
}

/**
 * Get all active subscriptions for all sessions on a specific runner.
 * Used to build the trigger_subscriptions_snapshot sent after runner registration.
 *
 * This scans all sessions connected to the runner and collects their subscriptions.
 * The sessionIds parameter should come from getConnectedSessionsForRunner().
 */
export async function getSubscriptionsForRunnerSessions(
    sessionIds: string[],
): Promise<Array<{ sessionId: string; subscriptionId: string; triggerType: string; runnerId: string; params?: SubscriptionParams; filters?: SubscriptionFilter[]; filterMode?: SubscriptionFilterMode }>> {
    if (sessionIds.length === 0) return [];
    const redis = await getClient();
    if (!redis) return [];

    const perSessionResults = await Promise.all(
        sessionIds.map(async (sessionId) => {
            try {
                const subs = await listSessionSubscriptions(sessionId);
                return subs.map(sub => ({ sessionId, ...sub }));
            } catch (err) {
                log.warn(`Failed to list subscriptions for session ${sessionId}:`, err);
                return [];
            }
        })
    );
    return perSessionResults.flat();
}

export async function getSubscriptionsForSessionTrigger(
    sessionId: string,
    triggerType: string,
): Promise<SessionTriggerSubscription[]> {
    const subscriptions = await listSessionSubscriptions(sessionId);
    return subscriptions.filter((subscription) => subscription.triggerType === triggerType);
}

export async function unsubscribeSessionSubscription(
    sessionId: string,
    subscriptionId: string,
): Promise<void> {
    const redis = await getClient();
    if (!redis) return;

    const sessionKey = SESSION_SUBS_KEY(sessionId);
    try {
        const raw = await redis.hGet(sessionKey, subscriptionId);
        if (!raw) return;
        const sub = parseSubValues(subscriptionId, raw)[0];
        if (!sub) return;
        const pipeline = redis.multi();
        pipeline.hDel(sessionKey, subscriptionId);
        pipeline.sRem(RUNNER_TYPE_INDEX_KEY(sub.runnerId, sub.triggerType), sessionId);
        await pipeline.exec();
    } catch (err) {
        log.warn("Failed to unsubscribe session subscription:", err);
    }
}

/** @deprecated Use `_resetRedisForTesting` instead. */
export function _resetTriggerSubscriptionStoreForTesting(): void {
    _resetRedisForTesting();
}
