import { describe, test, expect, beforeEach, mock } from "bun:test";
import {
    _injectRedisForTesting,
    _resetRedisKvStoreForTesting,
    consumeNonceOnce,
    getValue,
    setValue,
    deleteValue,
} from "./redis-kv-store";

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

    set: mock((key: string, value: string, opts?: { NX?: boolean; PX?: number }) => {
        if (opts?.NX) {
            const entry = store.get(key);
            if (entry && Date.now() <= entry.expiresAt) {
                return Promise.resolve(null);
            }
        }
        const ttlMs = opts?.PX ?? 0;
        const expiresAt = ttlMs > 0 ? Date.now() + ttlMs : Number.MAX_SAFE_INTEGER;
        store.set(key, { value, expiresAt });
        return Promise.resolve("OK");
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

    del: mock((key: string) => {
        store.delete(key);
        return Promise.resolve(1);
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

describe("consumeNonceOnce", () => {
    beforeEach(resetState);

    test("returns true on first consume and false on replay", async () => {
        const namespace = "webhook";
        const nonce = "abc-123";
        const ttlMs = 5 * 60 * 1000;

        const first = await consumeNonceOnce(namespace, nonce, ttlMs);
        expect(first).toBe(true);

        const replay = await consumeNonceOnce(namespace, nonce, ttlMs);
        expect(replay).toBe(false);
    });

    test("namespaces isolate nonces", async () => {
        const nonce = "shared-nonce";
        const ttlMs = 60_000;

        expect(await consumeNonceOnce("a", nonce, ttlMs)).toBe(true);
        expect(await consumeNonceOnce("b", nonce, ttlMs)).toBe(true);
        expect(await consumeNonceOnce("a", nonce, ttlMs)).toBe(false);
    });

    test("falls back to in-memory store when Redis is disabled", async () => {
        const previous = process.env.PIZZAPI_REDIS_URL;
        process.env.PIZZAPI_REDIS_URL = "off";
        _resetRedisKvStoreForTesting();

        const first = await consumeNonceOnce("webhook", "disabled-nonce", 60_000);
        expect(first).toBe(true);
        expect(await consumeNonceOnce("webhook", "disabled-nonce", 60_000)).toBe(false);

        process.env.PIZZAPI_REDIS_URL = previous;
    });
});

describe("generic kv helpers", () => {
    beforeEach(resetState);

    test("setValue/getValue/deleteValue round-trip", async () => {
        await setValue("pizzapi:test:k1", "v1");
        expect(await getValue("pizzapi:test:k1")).toBe("v1");

        await deleteValue("pizzapi:test:k1");
        expect(await getValue("pizzapi:test:k1")).toBeNull();
    });

    test("setValue respects TTL", async () => {
        await setValue("pizzapi:test:k2", "v2", 50);
        expect(await getValue("pizzapi:test:k2")).toBe("v2");

        await new Promise((r) => setTimeout(r, 80));
        expect(await getValue("pizzapi:test:k2")).toBeNull();
    });
});
