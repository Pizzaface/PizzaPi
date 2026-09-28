import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createClient } from "redis";
import { RedisMemoryServer } from "redis-memory-server";
import {
    _injectRedisForTesting,
    _resetRedisForTesting,
    getTriggerHistory,
    pushTriggerHistory,
    recordTriggerResponse,
    type TriggerHistoryEntry,
} from "./trigger-store.js";

let redisServer: RedisMemoryServer | undefined;
let redis: ReturnType<typeof createClient> | undefined;

beforeAll(async () => {
    redisServer = await RedisMemoryServer.create({
        instance: { ip: "127.0.0.1", port: 0 },
        autoStart: true,
    } as any);
    redis = createClient({ url: `redis://${await redisServer.getHost()}:${await redisServer.getPort()}` });
    await redis.connect();
    _injectRedisForTesting(redis);
});

afterAll(async () => {
    _resetRedisForTesting();
    try {
        if (redis?.isOpen) await redis.quit();
    } finally {
        await redisServer?.stop();
    }
});

const baseEntry: Omit<TriggerHistoryEntry, "triggerId" | "type"> = {
    source: "child",
    payload: {},
    deliverAs: "steer",
    ts: "2026-09-27T00:00:00.000Z",
    direction: "inbound",
};

async function clear(sessionId: string): Promise<void> {
    await redis!.del(`pizzapi:triggers:history:${sessionId}`);
}

describe("recordTriggerResponse", () => {
    test("finds by identity and mutates atomically after a concurrent LPUSH", async () => {
        const sessionId = "history-race";
        await clear(sessionId);
        const payload = JSON.parse('{"options":[],"nested":{"empty":[]},"large":9007199254740993}');
        await pushTriggerHistory(sessionId, {
            ...baseEntry,
            payload,
            triggerId: "question",
            type: "ask_user_question",
        });

        const key = `pizzapi:triggers:history:${sessionId}`;
        const completion = JSON.stringify({
            ...baseEntry,
            triggerId: "completion",
            type: "lifecycle:session_complete",
        });
        let completionInserted = false;
        const insertCompletion = async () => {
            if (!completionInserted) {
                completionInserted = true;
                await redis!.lPush(key, completion);
            }
        };

        // Delegate every operation to real Redis, but force LPUSH into the
        // vulnerable gap: after the legacy LRANGE snapshot and before LSET.
        _injectRedisForTesting({
            isOpen: true,
            lRange: async (listKey: string, start: number, end: number) => {
                const snapshot = await redis!.lRange(listKey, start, end);
                await insertCompletion();
                return snapshot;
            },
            lSet: (listKey: string, index: number, value: string) => redis!.lSet(listKey, index, value),
            eval: async (script: string, options: { keys: string[]; arguments: string[] }) => {
                // The atomic implementation has no stale-index gap. Insert
                // immediately before EVAL to exercise the same final list state.
                await insertCompletion();
                return redis!.eval(script, options);
            },
        });

        await recordTriggerResponse(sessionId, "question", { action: "approve", text: "Answered" });
        _injectRedisForTesting(redis!);

        const history = await getTriggerHistory(sessionId);
        expect(history.map(({ triggerId }) => triggerId)).toEqual(["completion", "question"]);
        expect(history[0].response).toBeUndefined();
        expect(history[1].response).toMatchObject({ action: "approve", text: "Answered" });
        expect(history[1].response?.ts).toBeString();
        expect(history[1].payload).toEqual(payload);
        expect(await redis!.ttl(`pizzapi:triggers:history:${sessionId}`)).toBeGreaterThan(0);
    });

    test("keeps malformed rows skippable and does not recreate a cleared list", async () => {
        const sessionId = "history-clear";
        const key = `pizzapi:triggers:history:${sessionId}`;
        await redis!.del(key);
        await redis!.rPush(key, ["not-json", JSON.stringify({ ...baseEntry, triggerId: "question", type: "ask_user_question" })]);

        await recordTriggerResponse(sessionId, "question", { action: "approve" });
        const rows = await redis!.lRange(key, 0, -1);
        expect(rows).toHaveLength(2);
        expect(rows[0]).toBe("not-json");
        expect(JSON.parse(rows[1]).response.action).toBe("approve");

        await redis!.del(key);
        await recordTriggerResponse(sessionId, "question", { action: "approve" });
        expect(await redis!.exists(key)).toBe(0);
    });
});

// Unit seam: assert the production function delegates its search and mutation
// in one EVAL call; the tests above execute the same Lua against isolated Redis.
test("uses a single EVAL operation for response lookup and update", async () => {
    let evalCall: { script: string; options: { keys: string[]; arguments: string[] } } | undefined;
    _injectRedisForTesting({
        isOpen: true,
        lRange: async () => [JSON.stringify({ ...baseEntry, triggerId: "unit-trigger", type: "ask_user_question" })],
        eval: async (script: string, options: { keys: string[]; arguments: string[] }) => {
            evalCall = { script, options };
            return 1;
        },
    });

    await recordTriggerResponse("unit-session", "unit-trigger", { action: "approve" });

    expect(evalCall?.options.keys).toEqual(["pizzapi:triggers:history:unit-session"]);
    expect(evalCall?.options.arguments[0]).toBe("unit-trigger");
    expect(evalCall?.options.arguments[1]).toBe("200");
    expect(evalCall?.options.arguments[2]).toContain('"triggerId":"unit-trigger"');
    expect(evalCall?.options.arguments[3]).toContain('"action":"approve"');
    expect(evalCall?.script).toContain("redis.call('LRANGE'");
    expect(evalCall?.script).toContain("redis.call('LSET'");
    _injectRedisForTesting(redis!);
});
