import { describe, test, expect, beforeEach, mock } from "bun:test";
import {
    runnerSecrets,
    validateAndPersistRunnerSecret,
    deleteRunnerSecret,
    getRunnerSecret,
    _resetRunnerSecretsForTesting,
} from "./context";
import {
    _injectRedisForTesting,
    _resetRedisKvStoreForTesting,
} from "../../redis-kv-store";

// ── In-memory Redis mock ─────────────────────────────────────────────────────

const store = new Map<string, string>();

const mockRedisClient = {
    isOpen: true,

    get: mock((key: string) => {
        return Promise.resolve(store.get(key) ?? null);
    }),

    set: mock((key: string, value: string, _opts?: unknown) => {
        store.set(key, value);
        return Promise.resolve("OK");
    }),

    del: mock((key: string) => {
        store.delete(key);
        return Promise.resolve(1);
    }),
};

function resetState() {
    store.clear();
    _resetRedisKvStoreForTesting();
    _injectRedisForTesting(mockRedisClient);
    _resetRunnerSecretsForTesting();
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("runner secret persistence", () => {
    beforeEach(resetState);

    test("claims and persists a new runner secret", async () => {
        const result = await validateAndPersistRunnerSecret("runner-1", "secret-1");
        expect(result).toBe("claimed");
        expect(runnerSecrets.get("runner-1")).toBe("secret-1");
        expect(await getRunnerSecret("runner-1")).toBe("secret-1");
    });

    test("rejects a mismatched secret", async () => {
        await validateAndPersistRunnerSecret("runner-2", "secret-2");
        const result = await validateAndPersistRunnerSecret("runner-2", "wrong");
        expect(result).toBe("mismatch");
    });

    test("matches a previously stored secret from local cache", async () => {
        await validateAndPersistRunnerSecret("runner-3", "secret-3");
        const result = await validateAndPersistRunnerSecret("runner-3", "secret-3");
        expect(result).toBe("match");
    });

    test("loads a secret from Redis when local cache misses", async () => {
        store.set("pizzapi:runner:secret:runner-4", "secret-4");
        const result = await validateAndPersistRunnerSecret("runner-4", "secret-4");
        expect(result).toBe("match");
        expect(runnerSecrets.get("runner-4")).toBe("secret-4");
    });

    test("falls back to in-memory store when Redis is disabled", async () => {
        const previous = process.env.PIZZAPI_REDIS_URL;
        process.env.PIZZAPI_REDIS_URL = "off";
        _resetRedisKvStoreForTesting();
        _resetRunnerSecretsForTesting();

        const result = await validateAndPersistRunnerSecret("runner-disabled", "secret-d");
        expect(result).toBe("claimed");
        expect(runnerSecrets.get("runner-disabled")).toBe("secret-d");

        const mismatch = await validateAndPersistRunnerSecret("runner-disabled", "wrong");
        expect(mismatch).toBe("mismatch");

        process.env.PIZZAPI_REDIS_URL = previous;
    });
});
