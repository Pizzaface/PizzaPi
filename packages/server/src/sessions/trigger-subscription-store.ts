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
}

const SESSION_SUBS_KEY = (sessionId: string) =>
    `pizzapi:trigger-subs:${sessionId}`;
const RUNNER_TYPE_INDEX_KEY = (runnerId: string, triggerType: string) =>
    `pizzapi:trigger-subs:runner:${runnerId}:${triggerType}`;

const DEFAULT_TTL_SECONDS = 24 * 60 * 60; // 24 hours

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
    runnerId: string;
    params?: SubscriptionParams;
    filters?: SubscriptionFilter[];
    filterMode?: SubscriptionFilterMode;
}

/** Parse a subscription hash value (backward-compatible with plain runnerId strings). */
function parseSubValue(raw: string): SubscriptionValue {
    // Old format: just a runnerId string (no braces)
    if (!raw.startsWith("{")) return { runnerId: raw };
    try {
        const parsed = JSON.parse(raw) as SubscriptionValue;
        if (typeof parsed.runnerId === "string") return parsed;
        return { runnerId: raw };
    } catch {
        return { runnerId: raw };
    }
}

/** Serialize a subscription value for Redis storage. */
function serializeSubValue(value: SubscriptionValue): string {
    // Always serialize the full value — filters/filterMode must be preserved
    // even when params is empty. Always include the `filters` key (even as [])
    // so the delivery path can distinguish new-format subscriptions from legacy
    // ones (which never had a `filters` key).
    const hasParams = value.params && Object.keys(value.params).length > 0;
    const hasFilters = value.filters && value.filters.length > 0;
    if (!hasParams && !hasFilters && !value.filterMode) {
        return JSON.stringify({ runnerId: value.runnerId });
    }
    // Always include filters key so new subscriptions are identifiable
    return JSON.stringify({
        ...value,
        filters: value.filters ?? [],
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
): Promise<void> {
    const redis = await getClient();
    if (!redis) return;

    const sessionKey = SESSION_SUBS_KEY(sessionId);
    const indexKey = RUNNER_TYPE_INDEX_KEY(runnerId, triggerType);

    try {
        const prevRaw = await redis.hGet(sessionKey, triggerType);
        if (prevRaw) {
            const prev = parseSubValue(prevRaw);
            if (prev.runnerId !== runnerId) {
                const oldIndexKey = RUNNER_TYPE_INDEX_KEY(prev.runnerId, triggerType);
                await redis.sRem(oldIndexKey, sessionId);
            }
        }

        const value = serializeSubValue({
            runnerId,
            params,
            ...(filters && filters.length > 0 ? { filters } : {}),
            ...(filterMode && filterMode !== "and" ? { filterMode } : {}),
        });
        const pipeline = redis.multi();
        pipeline.hSet(sessionKey, triggerType, value);
        pipeline.expire(sessionKey, ttlSeconds);
        pipeline.sAdd(indexKey, sessionId);
        pipeline.expire(indexKey, ttlSeconds);
        await pipeline.exec();
    } catch (err) {
        log.warn("Failed to subscribe session to trigger:", err);
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
): Promise<void> {
    const redis = await getClient();
    if (!redis) return;

    const sessionKey = SESSION_SUBS_KEY(sessionId);

    try {
        const raw = await redis.hGet(sessionKey, triggerType);
        await redis.hDel(sessionKey, triggerType);
        if (raw) {
            const { runnerId } = parseSubValue(raw);
            const indexKey = RUNNER_TYPE_INDEX_KEY(runnerId, triggerType);
            await redis.sRem(indexKey, sessionId);
        }
    } catch (err) {
        log.warn("Failed to unsubscribe session from trigger:", err);
    }
}

/**
 * List all trigger types this session is subscribed to.
 * Returns an array of { triggerType, runnerId } objects.
 */
export async function listSessionSubscriptions(
    sessionId: string,
): Promise<Array<{ triggerType: string; runnerId: string; params?: SubscriptionParams; filters?: SubscriptionFilter[]; filterMode?: SubscriptionFilterMode }>> {
    const redis = await getClient();
    if (!redis) return [];

    const sessionKey = SESSION_SUBS_KEY(sessionId);

    try {
        const hash = await redis.hGetAll(sessionKey);
        return Object.entries(hash).map(([triggerType, raw]) => {
            const { runnerId, params, filters, filterMode } = parseSubValue(raw);
            return {
                triggerType,
                runnerId,
                ...(params ? { params } : {}),
                ...(filters && filters.length > 0 ? { filters } : {}),
                ...(filterMode ? { filterMode } : {}),
            };
        });
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
        const raw = await redis.hGet(sessionKey, triggerType);
        if (!raw) return undefined;
        const { params } = parseSubValue(raw);
        return params;
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
): Promise<{ filters?: SubscriptionFilter[]; filterMode?: SubscriptionFilterMode; isNewFormat?: boolean } | undefined> {
    const redis = await getClient();
    if (!redis) return undefined;

    const sessionKey = SESSION_SUBS_KEY(sessionId);
    try {
        const raw = await redis.hGet(sessionKey, triggerType);
        if (!raw) return undefined;
        const parsed = parseSubValue(raw);
        // Detect new-format subscriptions: they always have a `filters` key (even if []).
        // Legacy subscriptions never had a `filters` key in their JSON.
        const rawParsed = raw.startsWith("{") ? JSON.parse(raw) : null;
        const isNewFormat = rawParsed && "filters" in rawParsed;
        if (isNewFormat) {
            return { filters: parsed.filters ?? [], filterMode: parsed.filterMode, isNewFormat: true };
        }
        // Legacy subscription — no filters key present
        return undefined;
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
    triggerType: string,
    updates: {
        params?: SubscriptionParams;
        filters?: SubscriptionFilter[];
        filterMode?: SubscriptionFilterMode;
    },
    ttlSeconds = DEFAULT_TTL_SECONDS,
): Promise<{ updated: boolean; runnerId?: string }> {
    const redis = await getClient();
    if (!redis) return { updated: false };

    const sessionKey = SESSION_SUBS_KEY(sessionId);

    try {
        const prevRaw = await redis.hGet(sessionKey, triggerType);
        if (!prevRaw) return { updated: false };

        const prev = parseSubValue(prevRaw);
        const value = serializeSubValue({
            runnerId: prev.runnerId,
            params: updates.params,
            ...(updates.filters && updates.filters.length > 0 ? { filters: updates.filters } : {}),
            ...(updates.filterMode && updates.filterMode !== "and" ? { filterMode: updates.filterMode } : {}),
        });

        const indexKey = RUNNER_TYPE_INDEX_KEY(prev.runnerId, triggerType);
        const pipeline = redis.multi();
        pipeline.hSet(sessionKey, triggerType, value);
        pipeline.expire(sessionKey, ttlSeconds);
        pipeline.expire(indexKey, ttlSeconds);
        await pipeline.exec();

        return { updated: true, runnerId: prev.runnerId };
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
        for (const [triggerType, raw] of Object.entries(hash)) {
            const { runnerId } = parseSubValue(raw);
            const indexKey = RUNNER_TYPE_INDEX_KEY(runnerId, triggerType);
            pipeline.sRem(indexKey, sessionId);
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
): Promise<Array<{ sessionId: string; triggerType: string; runnerId: string; params?: SubscriptionParams; filters?: SubscriptionFilter[]; filterMode?: SubscriptionFilterMode }>> {
    if (sessionIds.length === 0) return [];
    const redis = await getClient();
    if (!redis) return [];

    const results: Array<{ sessionId: string; triggerType: string; runnerId: string; params?: SubscriptionParams; filters?: SubscriptionFilter[]; filterMode?: SubscriptionFilterMode }> = [];

    for (const sessionId of sessionIds) {
        try {
            const subs = await listSessionSubscriptions(sessionId);
            for (const sub of subs) {
                results.push({ sessionId, ...sub });
            }
        } catch (err) {
            log.warn(`Failed to list subscriptions for session ${sessionId}:`, err);
        }
    }

    return results;
}

/** @deprecated Use `_resetRedisForTesting` instead. */
export function _resetTriggerSubscriptionStoreForTesting(): void {
    _resetRedisForTesting();
}
