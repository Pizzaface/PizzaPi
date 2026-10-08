/**
 * Regression test for GM XbwvZylH: a failed first connectRedisClient() call
 * (e.g. Redis briefly unreachable at startup) must not be cached as "null"
 * for the lifetime of the process. The next getClient() call should retry.
 */
import { afterAll, afterEach, describe, expect, it, mock } from "bun:test";

let connectCalls = 0;
let connectImpl: () => Promise<any> = async () => null;

mock.module("./redis-client.js", () => ({
    connectRedisClient: () => {
        connectCalls++;
        return connectImpl();
    },
    isRedisDisabled: () => false,
}));

const kvStorePromise = import("./redis-kv-store.js");

afterAll(() => mock.restore());
afterEach(async () => {
    const kv = await kvStorePromise;
    kv._resetRedisKvStoreForTesting();
    connectCalls = 0;
    connectImpl = async () => null;
});

describe("redis-kv-store lazy client", () => {
    it("retries connectRedisClient after a failed first attempt instead of caching null forever", async () => {
        const kv = await kvStorePromise;

        // First attempt fails.
        connectImpl = async () => null;
        expect(await kv.getValue("probe")).toBeNull();
        expect(connectCalls).toBe(1);

        // Redis comes back; the very next call should use a fresh client
        // instead of returning the permanently-cached null.
        const store = new Map<string, string>();
        const client = {
            isOpen: true,
            get: async (key: string) => store.get(key) ?? null,
            set: async (key: string, value: string) => {
                store.set(key, value);
                return "OK";
            },
        };
        connectImpl = async () => client;

        await kv.setValue("probe", "ok");
        expect(await kv.getValue("probe")).toBe("ok");
        expect(connectCalls).toBe(2);
    });
});
