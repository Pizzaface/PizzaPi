import { createClient } from "redis";
import { getEphemeralTtlMs } from "./store.js";

const DEFAULT_REDIS_URL = "redis://127.0.0.1:6379";
const DEFAULT_EVENT_BUFFER_SIZE = 1000;
const DEFAULT_EVENT_TTL_MS = 24 * 60 * 60 * 1000;

interface CachedRelayEventEnvelope {
    ts: number;
    event: unknown;
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
        console.warn(`${message}:`, error);
    } else {
        console.warn(message);
    }
}

function activeClient(): RelayRedisClient | null {
    if (!client || !client.isOpen) return null;
    return client;
}

export async function initializeRelayRedisCache(): Promise<void> {
    if (isRedisDisabled()) {
        console.log("Relay Redis cache disabled (PIZZAPI_REDIS_URL=off).");
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
            console.log(`Relay Redis cache connected at ${url}.`);
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
    await Promise.all(sessionIds.map((sessionId) => deleteRelayEventCache(sessionId)));
}
