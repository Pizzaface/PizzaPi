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
 * a last-resort safeguard for abnormal termination paths only. Schedule
 * subscriptions (time:*) are deliberately preserved across session end — see
 * clearSessionSubscriptions({ preserveDurable }).
 *
 * unsubscribeSessionFromTrigger() is also best-effort: if the session hash has
 * already expired (losing the triggerType→runnerId mapping), it cannot remove
 * the stale reverse-index entry. That entry will expire via its own TTL.
 */

import { connectRedisClient, isRedisDisabled, type RedisClient } from "../redis-client.js";
import { createLogger } from "@pizzapi/tools";
import { getKysely } from "../auth.js";

const log = createLogger("trigger-subscription-store");

// ── Durable mirror (SQLite) ─────────────────────────────────────────
//
// Redis is a cache, not the source of truth. Production runs Redis with
// `--save "" --appendonly no` and no volume, so a relay redeploy starts with an
// empty Redis — and the runner would then receive an authoritative EMPTY
// reconnect snapshot, which makes services drop every timer/cron they hold and
// discard their durable state. A standing schedule would be destroyed on both
// sides by a routine deploy.
//
// Every subscription is therefore mirrored into SQLite (the same durability the
// runner_trigger_listener table already gets) and Redis is rehydrated from it
// when a runner registers, before any snapshot is built.

const SUBSCRIPTION_TABLE = "trigger_subscription" as const;

export async function ensureTriggerSubscriptionTable(): Promise<void> {
    await getKysely().schema
        .createTable(SUBSCRIPTION_TABLE)
        .ifNotExists()
        .addColumn("id", "text", (col) => col.primaryKey())
        .addColumn("sessionId", "text", (col) => col.notNull())
        .addColumn("runnerId", "text", (col) => col.notNull())
        .addColumn("triggerType", "text", (col) => col.notNull())
        .addColumn("subscriptionJson", "text", (col) => col.notNull())
        .addColumn("updatedAt", "text", (col) => col.notNull())
        .execute();

    await getKysely().schema
        .createIndex("trigger_subscription_runner_idx")
        .ifNotExists()
        .on(SUBSCRIPTION_TABLE)
        .columns(["runnerId"])
        .execute();

    await getKysely().schema
        .createIndex("trigger_subscription_session_idx")
        .ifNotExists()
        .on(SUBSCRIPTION_TABLE)
        .columns(["sessionId"])
        .execute();
}

/** Mirror a subscription into SQLite. Best-effort: Redis stays authoritative
 *  for the live request, so a mirror failure must not fail the API call. */
async function persistSubscriptionRow(sessionId: string, value: SubscriptionValue): Promise<void> {
    try {
        const row = {
            id: value.subscriptionId,
            sessionId,
            runnerId: value.runnerId,
            triggerType: value.triggerType,
            subscriptionJson: serializeSubValue(value),
            updatedAt: new Date().toISOString(),
        };
        await getKysely()
            .insertInto(SUBSCRIPTION_TABLE)
            .values(row)
            .onConflict((oc) => oc.column("id").doUpdateSet({
                sessionId: row.sessionId,
                runnerId: row.runnerId,
                triggerType: row.triggerType,
                subscriptionJson: row.subscriptionJson,
                updatedAt: row.updatedAt,
            }))
            .execute();
    } catch (err) {
        log.warn("Failed to persist trigger subscription (best-effort):", err);
    }
}

async function deleteSubscriptionRows(where: { subscriptionIds?: string[]; sessionId?: string; preserveDurable?: boolean }): Promise<void> {
    try {
        let query = getKysely().deleteFrom(SUBSCRIPTION_TABLE);
        if (where.subscriptionIds && where.subscriptionIds.length > 0) {
            query = query.where("id", "in", where.subscriptionIds);
        } else if (where.sessionId) {
            query = query.where("sessionId", "=", where.sessionId);
        } else {
            return;
        }
        if (where.preserveDurable) {
            for (const prefix of DURABLE_TRIGGER_PREFIXES) {
                query = query.where("triggerType", "not like", `${prefix}%`);
            }
        }
        await query.execute();
    } catch (err) {
        log.warn("Failed to delete persisted trigger subscriptions (best-effort):", err);
    }
}

/** A schedule plus the session that owns it, for runner-wide listing. */
export interface RunnerScheduleEntry {
    subscriptionId: string;
    sessionId: string;
    runnerId: string;
    triggerType: string;
    params?: SubscriptionParams;
    filters?: SubscriptionFilter[];
    filterMode?: SubscriptionFilterMode;
}

/**
 * Every durable schedule (time:*) on a runner, read straight from the durable
 * table.
 *
 * The UI previously discovered schedules by fanning out over sessions, which
 * meant a schedule was only visible if its owning session happened to be in the
 * page of sessions being listed — so an old or ownerless schedule silently
 * vanished from the surface that is supposed to let you cancel it. Schedules
 * belong to a runner, so they are listed by runner.
 */
export async function listRunnerSchedules(runnerId: string): Promise<RunnerScheduleEntry[]> {
    try {
        const rows = await getKysely()
            .selectFrom(SUBSCRIPTION_TABLE)
            .select(["sessionId", "subscriptionJson", "triggerType"])
            .where("runnerId", "=", runnerId)
            .execute();
        const entries: RunnerScheduleEntry[] = [];
        for (const row of rows) {
            if (!isDurableTriggerType(row.triggerType)) continue;
            const sub = parseSubValues(row.sessionId, row.subscriptionJson)[0];
            if (!sub) continue;
            entries.push({
                subscriptionId: sub.subscriptionId,
                sessionId: row.sessionId,
                runnerId: sub.runnerId,
                triggerType: sub.triggerType,
                ...(sub.params ? { params: sub.params } : {}),
                ...(sub.filters && sub.filters.length > 0 ? { filters: sub.filters } : {}),
                ...(sub.filterMode ? { filterMode: sub.filterMode } : {}),
            });
        }
        return entries;
    } catch (err) {
        log.warn("Failed to list runner schedules:", err);
        return [];
    }
}

/**
 * Rebuild this runner's Redis subscription state from the durable table.
 *
 * Called when a runner registers, BEFORE the reconnect snapshot is built, so a
 * relay restart with an empty Redis cannot silently cancel standing schedules.
 * Additive and idempotent: entries are keyed by subscriptionId, and Redis wins
 * where it already has the key.
 */
export async function rehydrateRunnerSubscriptions(runnerId: string): Promise<number> {
    const redis = await getClient();
    if (!redis) return 0;
    let rows: Array<{ sessionId: string; subscriptionJson: string }> = [];
    try {
        rows = await getKysely()
            .selectFrom(SUBSCRIPTION_TABLE)
            .select(["sessionId", "subscriptionJson"])
            .where("runnerId", "=", runnerId)
            .execute();
    } catch (err) {
        log.warn("Failed to read persisted trigger subscriptions:", err);
        return 0;
    }
    if (rows.length === 0) return 0;

    let restored = 0;
    try {
        const pipeline = redis.multi();
        for (const row of rows) {
            const sub = parseSubValues(row.sessionId, row.subscriptionJson)[0];
            if (!sub) continue;
            const sessionKey = SESSION_SUBS_KEY(row.sessionId);
            pipeline.hSet(sessionKey, sub.subscriptionId, row.subscriptionJson);
            pipeline.expire(sessionKey, DEFAULT_TTL_SECONDS);
            const indexKey = RUNNER_TYPE_INDEX_KEY(sub.runnerId, sub.triggerType);
            pipeline.sAdd(indexKey, row.sessionId);
            pipeline.expire(indexKey, DEFAULT_TTL_SECONDS);
            const runnerSessionsKey = RUNNER_SESSIONS_INDEX_KEY(sub.runnerId);
            pipeline.sAdd(runnerSessionsKey, row.sessionId);
            pipeline.expire(runnerSessionsKey, DEFAULT_TTL_SECONDS);
            restored++;
        }
        await pipeline.exec();
    } catch (err) {
        log.warn("Failed to rehydrate trigger subscriptions into Redis:", err);
        return 0;
    }
    if (restored > 0) log.info(`Rehydrated ${restored} trigger subscription(s) for runner ${runnerId} from durable storage`);
    return restored;
}

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

/** Reverse index of all sessionIds that have any trigger subscription on a runner.
 *  Used to rebuild runner timer/cron state for sessions that are offline at reconnect time. */
const RUNNER_SESSIONS_INDEX_KEY = (runnerId: string) =>
    `pizzapi:trigger-subs:runner-sessions:${runnerId}`;

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
export type SubscriptionParamValue = null | string | number | boolean | SubscriptionParamValue[] | { [key: string]: SubscriptionParamValue };
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

/** True if the session still has at least one subscription on the given runner. */
async function sessionHasRunnerSubscriptions(sessionId: string, runnerId: string): Promise<boolean> {
    const redis = await getClient();
    if (!redis) return false;
    const subs = await listSessionSubscriptions(sessionId);
    return subs.some((sub) => sub.runnerId === runnerId);
}

/** Remove sessionId from the runner-sessions index if it no longer has any
 *  subscriptions on that runner. Best-effort: stale entries are harmless
 *  because getSubscriptionsForRunnerSessions filters them out at read time. */
async function maybeDropRunnerSessionIndex(sessionId: string, runnerId: string): Promise<void> {
    const redis = await getClient();
    if (!redis) return;
    if (!(await sessionHasRunnerSubscriptions(sessionId, runnerId))) {
        await redis.sRem(RUNNER_SESSIONS_INDEX_KEY(runnerId), sessionId);
    }
}

/**
 * Subscribe a session to a trigger type from a specific runner.
 * - Cleans up the old reverse-index entry if the session was previously subscribed
 *   to the same trigger type via a different runner (rebind case)
 * - Adds `triggerType → {runnerId, params?}` to the session's subscription hash
 * - Adds `sessionId` to the runner+type reverse index set
 * - Adds `sessionId` to the per-runner session index so reconnect snapshots can
 *   rebuild schedules for offline sessions
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
    const runnerSessionsKey = RUNNER_SESSIONS_INDEX_KEY(runnerId);

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
        pipeline.sAdd(runnerSessionsKey, sessionId);
        pipeline.expire(runnerSessionsKey, ttlSeconds);
        await pipeline.exec();
        // Mirror to durable storage so a relay redeploy (empty Redis) cannot
        // silently cancel this subscription.
        await persistSubscriptionRow(sessionId, {
            subscriptionId,
            triggerType,
            runnerId,
            params,
            ...(filters && filters.length > 0 ? { filters } : {}),
            ...(filterMode && filterMode !== "and" ? { filterMode } : {}),
        });
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
        await deleteSubscriptionRows({ subscriptionIds: matching.map((sub) => sub.subscriptionId) });
        for (const runnerId of new Set(matching.map((sub) => sub.runnerId))) {
            await maybeDropRunnerSessionIndex(sessionId, runnerId);
        }
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
        await persistSubscriptionRow(sessionId, {
            subscriptionId: prev.subscriptionId,
            triggerType,
            runnerId: prev.runnerId,
            params: updates.params,
            ...(updates.filters && updates.filters.length > 0 ? { filters: updates.filters } : {}),
            ...(updates.filterMode && updates.filterMode !== "and" ? { filterMode: updates.filterMode } : {}),
        });

        return { updated: true, subscriptionId: prev.subscriptionId, triggerType, runnerId: prev.runnerId };
    } catch (err) {
        log.warn("Failed to update session subscription:", err);
        return { updated: false };
    }
}

/** Trigger-type prefixes whose subscriptions outlive the session that made them. */
export const DURABLE_TRIGGER_PREFIXES = ["time:"] as const;

/** True when this trigger type is a durable schedule (survives its owning session). */
export function isDurableTriggerType(triggerType: string): boolean {
    return DURABLE_TRIGGER_PREFIXES.some((prefix) => triggerType.startsWith(prefix));
}

/** True when the session still owns at least one durable schedule. */
export async function sessionHasScheduleSubscription(sessionId: string): Promise<boolean> {
    const subs = await listSessionSubscriptions(sessionId);
    return subs.some((sub) => isDurableTriggerType(sub.triggerType));
}

/**
 * Remove subscriptions for a session (e.g. on session end).
 * Cleans up session hash and all reverse index entries.
 *
 * `preserveDurable` keeps schedule subscriptions (time:*) alive: a schedule
 * must outlive the session that created it — when it next fires, the relay
 * either wakes that session or the time service starts a new one to carry it
 * out. Without this, the orphan sweep (2 min after a worker dies) would delete
 * standing schedules outright and nothing could ever run them.
 *
 * Best-effort: if the session hash has already expired (TTL elapsed before
 * this is called), the reverse-index entries are left to expire on their own.
 * In normal operation this is called eagerly from endSharedSession() so the
 * hash is still present.
 */
export async function clearSessionSubscriptions(
    sessionId: string,
    opts: { preserveDurable?: boolean } = {},
): Promise<void> {
    const redis = await getClient();
    if (!redis) return;

    const sessionKey = SESSION_SUBS_KEY(sessionId);

    try {
        const hash = await redis.hGetAll(sessionKey);
        const removedRunnerIds = new Set<string>();
        const keptRunnerIds = new Set<string>();
        const pipeline = redis.multi();
        let keptAny = false;

        for (const [field, raw] of Object.entries(hash)) {
            const subs = parseSubValues(field, raw);
            // A legacy array-format field can hold several subscriptions. Only
            // drop the field when every subscription in it is removable, so a
            // preserved schedule is never collateral damage.
            const keep = opts.preserveDurable === true && subs.some((sub) => isDurableTriggerType(sub.triggerType));
            if (keep) {
                keptAny = true;
                for (const sub of subs) keptRunnerIds.add(sub.runnerId);
                continue;
            }
            pipeline.hDel(sessionKey, field);
            for (const sub of subs) {
                pipeline.sRem(RUNNER_TYPE_INDEX_KEY(sub.runnerId, sub.triggerType), sessionId);
                removedRunnerIds.add(sub.runnerId);
            }
        }

        if (!keptAny) pipeline.del(sessionKey);
        for (const runnerId of removedRunnerIds) {
            // Only forget the session on runners where nothing survives.
            if (!keptRunnerIds.has(runnerId)) pipeline.sRem(RUNNER_SESSIONS_INDEX_KEY(runnerId), sessionId);
        }
        await pipeline.exec();
        // Mirror the same selective removal into durable storage.
        await deleteSubscriptionRows({ sessionId, preserveDurable: opts.preserveDurable === true });
    } catch (err) {
        log.warn("Failed to clear session subscriptions (best-effort):", err);
    }
}

/**
 * Get all sessionIds that have at least one trigger subscription on this runner,
 * whether or not the session is currently connected. Used to build the reconnect
 * trigger_subscriptions_snapshot so schedules owned by offline sessions survive
 * a runner restart.
 *
 * Best-effort: the index may briefly contain sessions whose subscriptions have
 * all been removed — harmless, since listing their subscriptions yields nothing.
 */
export async function getSessionIdsWithSubscriptionsForRunner(runnerId: string): Promise<string[]> {
    const redis = await getClient();
    if (!redis) return [];
    try {
        return await redis.sMembers(RUNNER_SESSIONS_INDEX_KEY(runnerId));
    } catch (err) {
        log.warn("Failed to list sessions with subscriptions for runner:", err);
        return [];
    }
}

/**
 * Refresh the TTLs of every subscription key belonging to the given sessions,
 * plus this runner's session index and the reverse per-type indexes it uses.
 *
 * Called periodically while a runner is connected so standing schedules
 * (time:cron etc.) do not expire out of Redis after DEFAULT_TTL_SECONDS — the
 * TTL is a garbage collector for abnormal termination, not a lifetime cap on a
 * live schedule. Callers pass only sessions that still exist so subscriptions
 * of truly-dead sessions age out normally.
 */
export async function refreshRunnerSubscriptionTtls(
    runnerId: string,
    sessionIds: string[],
    ttlSeconds = DEFAULT_TTL_SECONDS,
): Promise<void> {
    const redis = await getClient();
    if (!redis) return;
    try {
        const typeKeys = new Set<string>();
        for (const sessionId of sessionIds) {
            for (const sub of await listSessionSubscriptions(sessionId)) {
                if (sub.runnerId === runnerId) typeKeys.add(RUNNER_TYPE_INDEX_KEY(runnerId, sub.triggerType));
            }
        }
        const pipeline = redis.multi();
        pipeline.expire(RUNNER_SESSIONS_INDEX_KEY(runnerId), ttlSeconds);
        for (const sessionId of sessionIds) {
            pipeline.expire(SESSION_SUBS_KEY(sessionId), ttlSeconds);
        }
        for (const key of typeKeys) {
            pipeline.expire(key, ttlSeconds);
        }
        await pipeline.exec();
    } catch (err) {
        log.warn("Failed to refresh runner subscription TTLs:", err);
    }
}

/**
 * Get all active subscriptions for all sessions on a specific runner.
 * Used to build the trigger_subscriptions_snapshot sent after runner registration.
 *
 * The sessionIds parameter should merge getConnectedSessionsForRunner() with
 * getSessionIdsWithSubscriptionsForRunner() so offline sessions' schedules are
 * included.
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
        await deleteSubscriptionRows({ subscriptionIds: [subscriptionId] });
        await maybeDropRunnerSessionIndex(sessionId, sub.runnerId);
    } catch (err) {
        log.warn("Failed to unsubscribe session subscription:", err);
    }
}

/** @deprecated Use `_resetRedisForTesting` instead. */
export function _resetTriggerSubscriptionStoreForTesting(): void {
    _resetRedisForTesting();
}

/**
 * Drop every Redis subscription key, leaving durable storage untouched.
 *
 * Test-only: reproduces a relay redeploy, where Redis restarts empty (it runs
 * with `--save "" --appendonly no` and no volume) while SQLite survives.
 */
export async function _dropRedisCacheForTesting(): Promise<void> {
    const redis = await getClient();
    if (!redis) return;
    const keys = await redis.keys("pizzapi:trigger-subs*");
    if (keys.length > 0) await redis.del(keys);
}
