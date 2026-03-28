/**
 * Redis client utilities for PizzaPi server modules.
 *
 * This is a **pure factory** — no cached state, no singletons.
 * Each consumer manages its own client lifecycle.
 *
 * Consumers that need a Redis client should:
 * 1. Keep a module-level `let redis: RedisClient | null = null`
 * 2. Export `_injectRedisForTesting(client)` for tests
 * 3. Lazily call `connectRedisClient()` in production
 *
 * Tests call `_injectRedisForTesting(mockClient)` directly —
 * no `mock.module` needed, no cross-file bleed.
 */

import { createClient } from "redis";
import { createLogger } from "@pizzapi/tools";

const log = createLogger("redis-client");

const DEFAULT_REDIS_URL = "redis://127.0.0.1:6379";

// ── Helpers ─────────────────────────────────────────────────────────────────

export type RedisClient = ReturnType<typeof createClient>;

export function isRedisDisabled(): boolean {
    const configured = process.env.PIZZAPI_REDIS_URL?.trim().toLowerCase();
    return configured === "off" || configured === "disabled" || configured === "none";
}

export function redisUrl(): string {
    const configured = process.env.PIZZAPI_REDIS_URL?.trim();
    return configured && configured.length > 0 ? configured : DEFAULT_REDIS_URL;
}

// ── Factory ─────────────────────────────────────────────────────────────────

/**
 * Create and connect a new Redis client. Caller owns the lifecycle.
 * Returns `null` when Redis is disabled or connection fails.
 */
export async function connectRedisClient(): Promise<RedisClient | null> {
    if (isRedisDisabled()) return null;

    try {
        const client = createClient({
            url: redisUrl(),
            socket: {
                reconnectStrategy: (attempt) => Math.min(1000 * 2 ** attempt, 30_000),
            },
        });

        client.on("error", (err) => {
            log.warn("Redis error:", err);
        });

        await client.connect();
        log.info(`Redis client connected at ${redisUrl()}.`);
        return client;
    } catch (err) {
        log.warn("Failed to connect Redis client:", err);
        return null;
    }
}
