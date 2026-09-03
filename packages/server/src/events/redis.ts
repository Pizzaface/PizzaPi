/**
 * Shared Redis client for the unified trigger system (ADR-0002).
 *
 * One client per process, shared by the distributed wake lock (transport.ts)
 * and the dead-runner markers (runner-liveness.ts). Follows the redis-client.ts
 * factory contract: module-level singleton, lazy connect, test injection —
 * never a second connection per feature.
 */

import { connectRedisClient, type RedisClient } from "../redis-client.js";

let _redis: RedisClient | null = null;
let _redisInit: Promise<RedisClient | null> | null = null;

/** The shared events-domain client; null when Redis is disabled/unavailable. */
export async function getEventsRedis(): Promise<RedisClient | null> {
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

/** Inject a mock client for unit tests (redis-client.ts contract). */
export function _injectRedisForTesting(client: unknown): void {
    _redis = client as RedisClient;
    _redisInit = null;
}

/** Reset client state for unit tests. */
export function _resetRedisForTesting(): void {
    _redis = null;
    _redisInit = null;
}