/**
 * Regression test for GM XbwvZylH: trigger history Redis must retry after an
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

const triggerStorePromise = import("./trigger-store.js");

afterAll(() => mock.restore());
afterEach(async () => {
    const store = await triggerStorePromise;
    store._resetRedisForTesting();
    connectCalls = 0;
    connectImpl = async () => null;
});

describe("trigger history Redis lazy client", () => {
    it("retries connectRedisClient after a failed first attempt instead of caching null forever", async () => {
        const store = await triggerStorePromise;

        await store.pushTriggerHistory("retry-session", {
            triggerId: "first",
            type: "ask_user_question",
            source: "child",
            payload: {},
            deliverAs: "steer",
            ts: "2026-10-08T00:00:00.000Z",
            direction: "inbound",
        });
        expect(connectCalls).toBe(1);

        const rows = new Map<string, string[]>();
        const client = {
            isOpen: true,
            lPush: async (key: string, value: string) => {
                rows.set(key, [value, ...(rows.get(key) ?? [])]);
                return rows.get(key)!.length;
            },
            lTrim: async (key: string, start: number, end: number) => {
                rows.set(key, (rows.get(key) ?? []).slice(start, end + 1));
                return "OK";
            },
            expire: async () => true,
            lRange: async (key: string, start: number, end: number) => {
                const list = rows.get(key) ?? [];
                return list.slice(start, end < 0 ? undefined : end + 1);
            },
        };
        connectImpl = async () => client;

        await store.pushTriggerHistory("retry-session", {
            triggerId: "second",
            type: "ask_user_question",
            source: "child",
            payload: {},
            deliverAs: "steer",
            ts: "2026-10-08T00:00:01.000Z",
            direction: "inbound",
        });

        const history = await store.getTriggerHistory("retry-session");
        expect(history.map((entry) => entry.triggerId)).toEqual(["second"]);
        expect(connectCalls).toBe(2);
    });
});
