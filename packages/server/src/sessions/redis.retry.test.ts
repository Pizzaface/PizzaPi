/**
 * Regression test for GM XbwvZylH: relay Redis cache must retry after an
 * initial null Redis connection instead of caching the unavailable state.
 */
import { afterAll, afterEach, describe, expect, it, mock } from "bun:test";

let connectCalls = 0;
let connectImpl: () => Promise<any> = async () => null;

mock.module("../redis-client.js", () => ({
    connectRedisClient: () => {
        connectCalls++;
        return connectImpl();
    },
    isRedisDisabled: () => false,
    redisUrl: () => "redis://test",
}));

const redisCachePromise = import("./redis.js");

afterAll(() => mock.restore());
afterEach(async () => {
    const cache = await redisCachePromise;
    cache._resetRelayRedisCacheForTesting();
    connectCalls = 0;
    connectImpl = async () => null;
});

describe("relay Redis cache lazy client", () => {
    it("retries connectRedisClient after a failed first attempt instead of caching null forever", async () => {
        const cache = await redisCachePromise;

        await cache.initializeRelayRedisCache();
        expect(connectCalls).toBe(1);

        const rows = new Map<string, string[]>();
        const client = {
            isOpen: true,
            eval: async (_script: string, opts: { keys: string[]; arguments: string[] }) => {
                const [listKey] = opts.keys;
                const [payload] = opts.arguments;
                const list = rows.get(listKey) ?? [];
                list.push(payload);
                rows.set(listKey, list);
                return 1;
            },
            lRange: async (key: string) => rows.get(key) ?? [],
        };
        connectImpl = async () => client;

        await cache.appendRelayEventToCache("retry-session", { type: "heartbeat" }, { seq: 1 });
        expect(await cache.getCachedRelayEvents("retry-session")).toEqual([
            { seq: 1, event: { type: "heartbeat" } },
        ]);
        expect(connectCalls).toBe(2);
    });
});
