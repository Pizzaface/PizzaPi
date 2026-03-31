import { connectRedisClient, isRedisDisabled, redisUrl, type RedisClient } from "../redis-client.js";
import { getEphemeralTtlMs } from "./store.js";
import { createLogger } from "@pizzapi/tools";

const log = createLogger("redis");

const DEFAULT_EVENT_BUFFER_SIZE = 1000;
const DEFAULT_EVENT_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_SNAPSHOT_SCAN_CHUNK_SIZE = 64;

export interface CachedRelayEventRecord {
    seq?: number;
    event: unknown;
}

interface ParsedCachedRelayEventRecord {
    seq?: number;
    event: unknown;
}

function isSnapshotEvent(event: unknown): event is Record<string, unknown> {
    if (!event || typeof event !== "object") return false;
    const evt = event as Record<string, unknown>;
    if (evt.type === "agent_end") {
        return Array.isArray(evt.messages);
    }
    if (evt.type === "session_active") {
        return Object.prototype.hasOwnProperty.call(evt, "state") && evt.state !== undefined;
    }
    return false;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
    if (!value) return fallback;
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function eventBufferSize(): number {
    return parsePositiveInt(process.env.PIZZAPI_RELAY_EVENT_BUFFER_SIZE, DEFAULT_EVENT_BUFFER_SIZE);
}

function nonEphemeralEventTtlMs(): number {
    return parsePositiveInt(process.env.PIZZAPI_RELAY_EVENT_TTL_MS, DEFAULT_EVENT_TTL_MS);
}

function ttlMsForSession(isEphemeral: boolean | undefined): number {
    return isEphemeral === false ? nonEphemeralEventTtlMs() : getEphemeralTtlMs();
}

function snapshotScanChunkSize(): number {
    return parsePositiveInt(process.env.PIZZAPI_RELAY_SNAPSHOT_SCAN_CHUNK_SIZE, DEFAULT_SNAPSHOT_SCAN_CHUNK_SIZE);
}

function eventsKey(sessionId: string): string {
    return `pizzapi:relay:session:${sessionId}:events`;
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

/** Inject a mock client for tests. */
export function _injectRedisForTesting(client: unknown): void {
    _redis = client as RedisClient;
    _initPromise = Promise.resolve();
}

/** Reset client state for tests. */
export function _resetRedisForTesting(): void {
    _redis = null;
    _initPromise = null;
}

let unavailableLogged = false;

function logUnavailableOnce(message: string, error?: unknown) {
    if (unavailableLogged) return;
    unavailableLogged = true;
    if (error) {
        log.warn(`${message}:`, error);
    } else {
        log.warn(message);
    }
}

export async function initializeRelayRedisCache(): Promise<void> {
    if (isRedisDisabled()) {
        log.info("Relay Redis cache disabled (PIZZAPI_REDIS_URL=off).");
        return;
    }

    const redis = await getClient();
    if (redis) {
        unavailableLogged = false;
        log.info(`Relay Redis cache connected at ${redisUrl()}.`);
    } else {
        logUnavailableOnce("Relay Redis cache unavailable; continuing without event replay");
    }
}

export async function appendRelayEventToCache(
    sessionId: string,
    event: unknown,
    opts: { isEphemeral?: boolean; seq?: number } = {},
): Promise<void> {
    if (isRedisDisabled()) return;

    const redis = await getClient();
    if (!redis) return;

    const payload: ParsedCachedRelayEventRecord = {
        event,
    };
    if (typeof opts.seq === "number" && Number.isFinite(opts.seq)) {
        payload.seq = opts.seq;
    }
    const ttlMs = ttlMsForSession(opts.isEphemeral);

    try {
        const key = eventsKey(sessionId);
        const multi = redis.multi();
        multi.rPush(key, JSON.stringify(payload));
        multi.lTrim(key, -eventBufferSize(), -1);
        multi.pExpire(key, ttlMs);
        await multi.exec();
    } catch (error) {
        logUnavailableOnce("Failed to append relay event to Redis cache", error);
    }
}

function parseCachedRelayEventRow(row: string): CachedRelayEventRecord | null {
    try {
        const parsed = JSON.parse(row) as unknown;
        if (!parsed || typeof parsed !== "object") {
            return { event: parsed };
        }

        const record = parsed as Record<string, unknown>;
        if (Object.prototype.hasOwnProperty.call(record, "event")) {
            return {
                seq: typeof record.seq === "number" && Number.isFinite(record.seq) ? record.seq : undefined,
                event: record.event,
            };
        }

        return { event: parsed };
    } catch {
        return null;
    }
}

function isSequencedCachedRelayEvent(record: CachedRelayEventRecord): record is CachedRelayEventRecord & { seq: number } {
    return typeof record.seq === "number" && Number.isFinite(record.seq);
}

export async function getCachedRelayEvents(sessionId: string): Promise<CachedRelayEventRecord[]> {
    if (isRedisDisabled()) return [];

    const redis = await getClient();
    if (!redis) return [];

    try {
        const rows = await redis.lRange(eventsKey(sessionId), 0, -1);
        const events: CachedRelayEventRecord[] = [];
        for (const row of rows) {
            const parsed = parseCachedRelayEventRow(row);
            if (parsed) {
                events.push(parsed);
            }
        }
        return events;
    } catch (error) {
        logUnavailableOnce("Failed to read relay event cache from Redis", error);
        return [];
    }
}

/**
 * Read only the newest portion(s) of the relay cache and return the latest
 * full snapshot event (session_active/agent_end), if present.
 *
 * This avoids parsing the entire event list on each viewer switch when the
 * newest snapshot is near the tail (common case).
 */
export async function getCachedRelayEventsAfterSeq(
    sessionId: string,
    afterSeq: number,
): Promise<CachedRelayEventRecord[]> {
    if (isRedisDisabled()) return [];

    const redis = await getClient();
    if (!redis) return [];

    try {
        const rows = await redis.lRange(eventsKey(sessionId), 0, -1);
        const events: CachedRelayEventRecord[] = [];
        let sawLegacyRow = false;

        for (const row of rows) {
            const parsed = parseCachedRelayEventRow(row);
            if (!parsed) continue;
            if (!isSequencedCachedRelayEvent(parsed)) {
                sawLegacyRow = true;
                continue;
            }
            if (parsed.seq > afterSeq) {
                events.push(parsed);
            }
        }

        if (afterSeq > 0 && sawLegacyRow) {
            return [];
        }

        return events;
    } catch (error) {
        logUnavailableOnce("Failed to read relay event cache from Redis", error);
        return [];
    }
}

export async function getLatestCachedSnapshotEvent(sessionId: string): Promise<Record<string, unknown> | null> {
    if (isRedisDisabled()) return null;

    const redis = await getClient();
    if (!redis) return null;

    try {
        const key = eventsKey(sessionId);
        const length = await redis.lLen(key);
        if (!Number.isFinite(length) || length <= 0) return null;

        const chunkSize = snapshotScanChunkSize();
        for (let end = length - 1; end >= 0; end -= chunkSize) {
            const start = Math.max(0, end - chunkSize + 1);
            const rows = await redis.lRange(key, start, end);
            for (let i = rows.length - 1; i >= 0; i--) {
                const row = rows[i];
                const parsed = parseCachedRelayEventRow(row);
                if (parsed && isSnapshotEvent(parsed.event)) {
                    return parsed.event;
                }
            }
        }

        return null;
    } catch (error) {
        logUnavailableOnce("Failed to read latest snapshot from Redis cache", error);
        return null;
    }
}

export async function deleteRelayEventCache(sessionId: string): Promise<void> {
    if (isRedisDisabled()) return;
    const redis = await getClient();
    if (!redis) return;

    try {
        await redis.del(eventsKey(sessionId));
    } catch (error) {
        logUnavailableOnce("Failed to delete relay event cache from Redis", error);
    }
}

export async function deleteRelayEventCaches(sessionIds: string[]): Promise<void> {
    if (sessionIds.length === 0) return;
    if (isRedisDisabled()) return;
    const redis = await getClient();
    if (!redis) return;

    try {
        const keys = sessionIds.map((sessionId) => eventsKey(sessionId));
        await redis.del(keys);
    } catch (error) {
        logUnavailableOnce("Failed to delete relay event caches from Redis", error);
    }
}

/**
 * Reset all module-level state so that the next call to
 * `initializeRelayRedisCache()` starts fresh with the current module
 * mock environment.  Intended for use in test hooks only.
 */
export function _resetRelayRedisCacheForTesting(): void {
    _resetRedisForTesting();
    unavailableLogged = false;
}
