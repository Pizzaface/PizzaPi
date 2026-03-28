import { createClient } from "redis";
import { getEphemeralTtlMs } from "./store.js";
import { createLogger } from "@pizzapi/tools";

const log = createLogger("redis");

const DEFAULT_REDIS_URL = "redis://127.0.0.1:6379";
const DEFAULT_EVENT_BUFFER_SIZE = 1000;
const DEFAULT_EVENT_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_SNAPSHOT_SCAN_CHUNK_SIZE = 64;

interface CachedRelayEventEnvelope {
    ts: number;
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

function isRedisDisabled(): boolean {
    const configured = process.env.PIZZAPI_REDIS_URL?.trim().toLowerCase();
    return configured === "off" || configured === "disabled" || configured === "none";
}

function redisUrl(): string {
    const configured = process.env.PIZZAPI_REDIS_URL?.trim();
    return configured && configured.length > 0 ? configured : DEFAULT_REDIS_URL;
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

type RelayRedisClient = ReturnType<typeof createClient>;

let client: RelayRedisClient | null = null;
let initPromise: Promise<void> | null = null;
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

function activeClient(): RelayRedisClient | null {
    if (!client || !client.isOpen) return null;
    return client;
}

export async function initializeRelayRedisCache(): Promise<void> {
    if (isRedisDisabled()) {
        log.info("Relay Redis cache disabled (PIZZAPI_REDIS_URL=off).");
        return;
    }

    if (initPromise) {
        await initPromise;
        return;
    }

    const url = redisUrl();
    initPromise = (async () => {
        const next = createClient({
            url,
            socket: {
                reconnectStrategy: (attempt) => Math.min(1000 * 2 ** attempt, 30_000),
            },
        });

        next.on("error", (error) => {
            logUnavailableOnce("Relay Redis cache unavailable; continuing without event replay", error);
        });

        try {
            await next.connect();
            client = next;
            unavailableLogged = false;
            log.info(`Relay Redis cache connected at ${url}.`);
        } catch (error) {
            logUnavailableOnce("Relay Redis cache unavailable; continuing without event replay", error);
            try {
                next.disconnect();
            } catch {}
        }
    })();

    await initPromise;
    if (!activeClient()) {
        initPromise = null;
    }
}

export async function appendRelayEventToCache(
    sessionId: string,
    event: unknown,
    opts: { isEphemeral?: boolean } = {},
): Promise<void> {
    if (isRedisDisabled()) return;
    if (!initPromise) {
        void initializeRelayRedisCache();
    }

    const redis = activeClient();
    if (!redis) return;

    const payload: CachedRelayEventEnvelope = {
        ts: Date.now(),
        event,
    };
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

export async function getCachedRelayEvents(sessionId: string): Promise<unknown[]> {
    if (isRedisDisabled()) return [];
    if (!initPromise) {
        void initializeRelayRedisCache();
    }

    const redis = activeClient();
    if (!redis) return [];

    try {
        const rows = await redis.lRange(eventsKey(sessionId), 0, -1);
        const events: unknown[] = [];
        for (const row of rows) {
            try {
                const parsed = JSON.parse(row) as CachedRelayEventEnvelope;
                events.push(parsed?.event);
            } catch {
                // Ignore malformed cache entries.
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
export async function getLatestCachedSnapshotEvent(sessionId: string): Promise<Record<string, unknown> | null> {
    if (isRedisDisabled()) return null;
    if (!initPromise) {
        void initializeRelayRedisCache();
    }

    const redis = activeClient();
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
                try {
                    const parsed = JSON.parse(row) as CachedRelayEventEnvelope;
                    if (isSnapshotEvent(parsed?.event)) {
                        return parsed.event;
                    }
                } catch {
                    // Ignore malformed cache entries.
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
    const redis = activeClient();
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
    const redis = activeClient();
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
    client = null;
    initPromise = null;
    unavailableLogged = false;
}
