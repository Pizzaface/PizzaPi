// ============================================================================
// sio-state/client.ts — Redis client lifecycle
// ============================================================================

import { createClient, type RedisClientType } from "redis";
import { createLogger } from "@pizzapi/tools";

const log = createLogger("sio-state");

// Read lazily so the value is resolved at connect-time, not module-load time.
export function getRedisUrl(): string { return process.env.PIZZAPI_REDIS_URL ?? "redis://localhost:6379"; }

let redis: RedisClientType | null = null;

/**
 * Initialize a dedicated Redis client for Socket.IO state.
 *
 * @param createClientOverride — Optional override for `createClient`.  The test
 *   harness passes the real function captured at preload time so that
 *   `initStateRedis()` is immune to `mock.module("redis", …)` contamination
 *   from other test files in the same Bun worker.
 */
export async function initStateRedis(createClientOverride?: typeof createClient): Promise<void> {
    const factory = createClientOverride ?? createClient;
    redis = factory({
        url: getRedisUrl(),
        socket: {
            reconnectStrategy: (attempt: number) => Math.min(1000 * 2 ** attempt, 30_000),
        },
    }) as RedisClientType;

    redis.on("error", (err: Error) => {
        log.error("Redis error:", err);
    });

    await redis.connect();
    log.info(`Redis connected at ${getRedisUrl()}`);
}

/** Return the state Redis client (or null if not initialized). */
export function getStateRedis(): RedisClientType | null {
    return redis;
}

/**
 * Close the dedicated state Redis client and reset the module-level reference.
 * Safe to call even if no client was initialized (no-op in that case).
 */
export async function closeStateRedis(): Promise<void> {
    if (redis) {
        await redis.quit();
        redis = null;
    }
}

/** Assert that the Redis client is initialized and connected. */
export function requireRedis(): RedisClientType {
    if (!redis || !redis.isOpen) {
        throw new Error("[sio-state] Redis client not initialized or disconnected");
    }
    return redis;
}
