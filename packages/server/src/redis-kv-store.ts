/**
 * Small Redis-backed key/value + nonce store with in-memory fallback.
 *
 * Consumers get a lazy-connecting Redis client and a graceful fallback to
 * process-local state when Redis is disabled or unavailable.
 */

import { connectRedisClient, isRedisDisabled, type RedisClient } from "./redis-client.js";
import { createLogger } from "@pizzapi/tools";

const log = createLogger("redis-kv");

let _redis: RedisClient | null = null;
let _initPromise: Promise<void> | null = null;

async function getClient(): Promise<RedisClient | null> {
    if (_redis?.isOpen) return _redis;
    if (_initPromise) {
        await _initPromise;
        return _redis;
    }
    _initPromise = connectRedisClient().then((c) => {
        _redis = c;
    });
    await _initPromise;
    return _redis;
}

/** Inject a mock client for tests. */
export function _injectRedisForTesting(client: unknown): void {
    _redis = client as RedisClient;
    _initPromise = Promise.resolve();
}

/** Reset module-level state for tests. */
export function _resetRedisKvStoreForTesting(): void {
    _redis = null;
    _initPromise = null;
    nonceMemoryStore.clear();
}

// ── Generic key/value helpers ───────────────────────────────────────────────

export async function getValue(key: string): Promise<string | null> {
    if (isRedisDisabled()) return null;
    const redis = await getClient();
    if (!redis) return null;
    try {
        return await redis.get(key);
    } catch (err) {
        log.warn(`Redis GET ${key} failed:`, err);
        return null;
    }
}

export async function setValue(key: string, value: string, ttlMs?: number): Promise<void> {
    if (isRedisDisabled()) return;
    const redis = await getClient();
    if (!redis) return;
    try {
        if (ttlMs && ttlMs > 0) {
            await redis.set(key, value, { PX: ttlMs });
        } else {
            await redis.set(key, value);
        }
    } catch (err) {
        log.warn(`Redis SET ${key} failed:`, err);
    }
}

export async function deleteValue(key: string): Promise<void> {
    if (isRedisDisabled()) return;
    const redis = await getClient();
    if (!redis) return;
    try {
        await redis.del(key);
    } catch (err) {
        log.warn(`Redis DEL ${key} failed:`, err);
    }
}

// ── Nonce store (SET NX PX) ─────────────────────────────────────────────────

const nonceMemoryStore = new Map<string, number>();
let nonceSweepTimer: ReturnType<typeof setInterval> | null = null;
let nonceSweepScheduled = false;

function scheduleNonceSweep(): void {
    if (nonceSweepScheduled) return;
    nonceSweepScheduled = true;
    nonceSweepTimer = setInterval(() => {
        const cutoff = Date.now() - 24 * 60 * 60 * 1000;
        for (const [key, ts] of nonceMemoryStore) {
            if (ts < cutoff) nonceMemoryStore.delete(key);
        }
    }, 2 * 60 * 1000);
    if (nonceSweepTimer && typeof nonceSweepTimer === "object" && "unref" in nonceSweepTimer) {
        (nonceSweepTimer as any).unref();
    }
}

/**
 * Consume a nonce once. Returns `true` if this call was the first to consume
 * it, `false` if it has already been seen (in Redis or the in-memory fallback).
 */
export async function consumeNonceOnce(namespace: string, nonce: string, ttlMs: number): Promise<boolean> {
    const localKey = `${namespace}:${nonce}`;
    const redisKey = `pizzapi:nonce:${namespace}:${nonce}`;
    const now = Date.now();

    scheduleNonceSweep();

    const redis = await getClient();
    if (redis && !isRedisDisabled()) {
        try {
            const result = await redis.set(redisKey, String(now), { NX: true, PX: ttlMs });
            const consumed = result === "OK";
            if (!consumed) {
                nonceMemoryStore.set(localKey, now);
            }
            return consumed;
        } catch (err) {
            log.warn("Redis nonce store unavailable, falling back to memory:", err);
        }
    }

    if (nonceMemoryStore.has(localKey)) return false;
    nonceMemoryStore.set(localKey, now);
    return true;
}

// ── Rate-limit helper (INCR + PEXPIRE) ──────────────────────────────────────

export interface RedisRateLimitWindow {
    count: number;
    resetTime: number;
}

/**
 * Read the current Redis-backed rate-limit counter and its reset time.
 * Returns `null` when Redis is disabled/unavailable or the key does not exist.
 */
export async function getRateLimitWindow(key: string): Promise<RedisRateLimitWindow | null> {
    if (isRedisDisabled()) return null;
    const redis = await getClient();
    if (!redis) return null;

    const redisKey = `pizzapi:ratelimit:${key}`;
    try {
        const [val, pttl] = await Promise.all([redis.get(redisKey), redis.pTTL(redisKey)]);
        if (val === null) return null;
        const count = Number.parseInt(val, 10);
        if (!Number.isFinite(count)) return null;
        const now = Date.now();
        return {
            count,
            resetTime: now + (pttl > 0 ? pttl : 0),
        };
    } catch (err) {
        log.warn(`Redis rate-limit read for ${key} failed:`, err);
        return null;
    }
}

/**
 * Atomically increment a Redis-backed rate-limit counter and return the new
 * count + window reset time. Returns `null` when Redis is disabled/unavailable
 * so callers can fall back to their in-memory path.
 */
export async function incrementRateLimitCounter(key: string, windowMs: number): Promise<RedisRateLimitWindow | null> {
    if (isRedisDisabled()) return null;
    const redis = await getClient();
    if (!redis) return null;

    const redisKey = `pizzapi:ratelimit:${key}`;
    const now = Date.now();

    try {
        // Lua keeps the read+incr+ttl dance atomic without a WATCH/MULTI race.
        const script = `
            local current = redis.call('GET', KEYS[1])
            local reset = 0
            if current == false then
                redis.call('SET', KEYS[1], 1, 'PX', ARGV[1])
                reset = redis.call('PTTL', KEYS[1])
                return {1, reset}
            end
            local new = redis.call('INCR', KEYS[1])
            reset = redis.call('PTTL', KEYS[1])
            if reset <= 0 then
                redis.call('PEXPIRE', KEYS[1], ARGV[1])
                reset = ARGV[1]
            end
            return {new, reset}
        `;
        const result = (await redis.eval(script, {
            keys: [redisKey],
            arguments: [String(windowMs)],
        })) as [number, number];
        const count = result[0];
        const ttlRemaining = result[1];
        return {
            count,
            resetTime: now + (ttlRemaining > 0 ? ttlRemaining : windowMs),
        };
    } catch (err) {
        log.warn("Redis rate-limit increment failed:", err);
        return null;
    }
}
