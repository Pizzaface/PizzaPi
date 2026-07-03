import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { RateLimiter } from "./security";
import { _injectRedisForTesting, _resetRedisKvStoreForTesting } from "./redis-kv-store";

// ── In-memory Redis mock ─────────────────────────────────────────────────────

interface StoredValue {
    value: string;
    expiresAt: number;
}

const store = new Map<string, StoredValue>();

const mockRedisClient = {
    isOpen: true,

    get: mock((key: string) => {
        const entry = store.get(key);
        if (!entry) return Promise.resolve(null);
        if (Date.now() > entry.expiresAt) {
            store.delete(key);
            return Promise.resolve(null);
        }
        return Promise.resolve(entry.value);
    }),

    pTTL: mock((key: string) => {
        const entry = store.get(key);
        if (!entry) return Promise.resolve(-2);
        const ttl = entry.expiresAt - Date.now();
        if (ttl <= 0) {
            store.delete(key);
            return Promise.resolve(-2);
        }
        return Promise.resolve(ttl);
    }),

    eval: mock((_script: string, opts: { keys: string[]; arguments: string[] }) => {
        const key = opts.keys[0];
        const windowMs = Number(opts.arguments[0]);
        const entry = store.get(key);
        if (!entry || Date.now() > entry.expiresAt) {
            const expiresAt = Date.now() + windowMs;
            store.set(key, { value: "1", expiresAt });
            return Promise.resolve([1, windowMs]);
        }
        const newCount = Number(entry.value) + 1;
        entry.value = String(newCount);
        const ttl = entry.expiresAt - Date.now();
        return Promise.resolve([newCount, ttl]);
    }),
};

function resetState() {
    store.clear();
    _resetRedisKvStoreForTesting();
    _injectRedisForTesting(mockRedisClient);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("RateLimiter with Redis backing", () => {
    beforeEach(resetState);

    test("blocks requests over limit via in-memory path", () => {
        const limiter = new RateLimiter(2, 60_000, 0);
        const key = "redis-rate-test";

        expect(limiter.check(key)).toBe(true);
        expect(limiter.check(key)).toBe(true);
        expect(limiter.check(key)).toBe(false);

        limiter.destroy();
    });

    test("syncs from Redis and blocks when Redis is already over limit", async () => {
        const key = "pre-warmed-key";
        const windowMs = 60_000;
        // Seed Redis as if another node already exhausted the limit.
        store.set(`pizzapi:ratelimit:${key}`, {
            value: String(5),
            expiresAt: Date.now() + windowMs,
        });

        const limiter = new RateLimiter(5, windowMs, 10);

        // Prime the local key set so the background sync knows to watch this key.
        limiter.check(key);

        // Wait for the background sync to pull the Redis count into memory.
        await new Promise((r) => setTimeout(r, 60));

        expect(limiter.check(key)).toBe(false);

        limiter.destroy();
    });

    test("falls back to memory when Redis is disabled", () => {
        const previous = process.env.PIZZAPI_REDIS_URL;
        process.env.PIZZAPI_REDIS_URL = "off";
        _resetRedisKvStoreForTesting();
        const limiter = new RateLimiter(1, 60_000, 0);
        const key = "fallback-key";

        expect(limiter.check(key)).toBe(true);
        expect(limiter.check(key)).toBe(false);

        limiter.destroy();
        process.env.PIZZAPI_REDIS_URL = previous;
    });
});
