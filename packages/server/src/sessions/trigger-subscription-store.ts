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

import { createClient } from "redis";
import { createLogger } from "@pizzapi/tools";

const log = createLogger("trigger-subscription-store");

const SESSION_SUBS_KEY = (sessionId: string) =>
    `pizzapi:trigger-subs:${sessionId}`;
const RUNNER_TYPE_INDEX_KEY = (runnerId: string, triggerType: string) =>
    `pizzapi:trigger-subs:runner:${runnerId}:${triggerType}`;

const DEFAULT_TTL_SECONDS = 24 * 60 * 60; // 24 hours

// ── Redis client (lazy, shared pattern) ─────────────────────────────────

type RedisClient = ReturnType<typeof createClient>;
let client: RedisClient | null = null;
let initPromise: Promise<void> | null = null;

function redisUrl(): string {
    const configured = process.env.PIZZAPI_REDIS_URL?.trim();
    return configured && configured.length > 0 ? configured : "redis://127.0.0.1:6379";
}

function isRedisDisabled(): boolean {
    const configured = process.env.PIZZAPI_REDIS_URL?.trim().toLowerCase();
    return configured === "off" || configured === "disabled" || configured === "none";
}

async function getClient(): Promise<RedisClient | null> {
    if (isRedisDisabled()) return null;
    if (client?.isOpen) return client;
    if (initPromise) {
        await initPromise;
        return client?.isOpen ? client : null;
    }
    initPromise = (async () => {
        try {
            client = createClient({ url: redisUrl() });
            client.on("error", (err) => log.warn("Redis error:", err));
            await client.connect();
        } catch (err) {
            log.warn("Failed to connect trigger subscription Redis:", err);
            client = null;
        }
    })();
    await initPromise;
    return client?.isOpen ? client : null;
}

// ── Public API ───────────────────────────────────────────────────────────

/**
 * Subscribe a session to a trigger type from a specific runner.
 * - Adds `triggerType → runnerId` to the session's subscription hash
 * - Adds `sessionId` to the runner+type reverse index set
 * - Refreshes TTL on both keys
 */
export async function subscribeSessionToTrigger(
    sessionId: string,
    runnerId: string,
    triggerType: string,
    ttlSeconds = DEFAULT_TTL_SECONDS,
): Promise<void> {
    const redis = await getClient();
    if (!redis) return;

    const sessionKey = SESSION_SUBS_KEY(sessionId);
    const indexKey = RUNNER_TYPE_INDEX_KEY(runnerId, triggerType);

    try {
        await redis.hSet(sessionKey, triggerType, runnerId);
        await redis.expire(sessionKey, ttlSeconds);
        await redis.sAdd(indexKey, sessionId);
        await redis.expire(indexKey, ttlSeconds);
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
        // Look up the runnerId so we can clean up the reverse index
        const runnerId = await redis.hGet(sessionKey, triggerType);
        await redis.hDel(sessionKey, triggerType);
        if (runnerId) {
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
): Promise<Array<{ triggerType: string; runnerId: string }>> {
    const redis = await getClient();
    if (!redis) return [];

    const sessionKey = SESSION_SUBS_KEY(sessionId);

    try {
        const hash = await redis.hGetAll(sessionKey);
        return Object.entries(hash).map(([triggerType, runnerId]) => ({ triggerType, runnerId }));
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
        for (const [triggerType, runnerId] of Object.entries(hash)) {
            const indexKey = RUNNER_TYPE_INDEX_KEY(runnerId, triggerType);
            pipeline.sRem(indexKey, sessionId);
        }
        pipeline.del(sessionKey);
        await pipeline.exec();
    } catch (err) {
        log.warn("Failed to clear session subscriptions (best-effort):", err);
    }
}

/** Reset for testing. */
export function _resetTriggerSubscriptionStoreForTesting(): void {
    if (client?.isOpen) {
        client.disconnect().catch(() => {});
    }
    client = null;
    initPromise = null;
}
