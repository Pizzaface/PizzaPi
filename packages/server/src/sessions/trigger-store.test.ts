import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createClient } from "redis";
import { RedisMemoryServer } from "redis-memory-server";
import {
    _injectRedisForTesting,
    _resetRedisForTesting,
    clearTriggerHistory,
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

// ── Cutoff-scoped clear (GM a8yAXXwa) ───────────────────────────────────────
//
// The server-side DELETE /api/sessions/:id/triggers handler is fired by the
// CLI without awaiting it (performSessionTransitionCleanup). If that clear
// physically deleted the list whenever it happened to actually run, a DELETE
// delayed in transit past the point where the new conversation generation's
// first trigger is pushed and recorded would still wipe that new entry out
// the moment it finally arrived. These tests simulate that delay directly
// against the store.
describe("clearTriggerHistory — cutoff scoping", () => {
    test("a clear delayed past a new push does not erase the entry pushed after its cutoff", async () => {
        const sessionId = "history-delayed-clear";
        const historyKey = `pizzapi:triggers:history:${sessionId}`;
        const cutoffKey = `pizzapi:triggers:clearedBefore:${sessionId}`;
        await redis!.del(historyKey);
        await redis!.del(cutoffKey);

        await pushTriggerHistory(sessionId, { ...baseEntry, triggerId: "old-gen", type: "lifecycle:ask" });

        // The cutoff is captured the instant the transition is decided — i.e.
        // before the (unawaited) DELETE carrying it is even sent, let alone
        // before it's processed here.
        const before = Date.now();
        // A real network round trip for the DELETE buys many milliseconds of
        // margin in production; a tiny delay here keeps this test's "new-gen"
        // push out of the same millisecond as `before` without depending on
        // how fast the in-memory Redis happens to respond.
        await new Promise((resolve) => setTimeout(resolve, 5));

        // Gate the Redis commands clearTriggerHistory might issue (`eval` in
        // the fix, `del` in the pre-fix blind-delete version) so the clear's
        // actual effect on Redis only happens once the test releases it —
        // simulating a DELETE request that is fired but arrives late.
        let releaseGate: () => void;
        const gate = new Promise<void>((resolve) => { releaseGate = resolve; });
        const realRedis = redis!;
        _injectRedisForTesting({
            isOpen: true,
            get: (k: string) => realRedis.get(k),
            del: async (k: string) => { await gate; return realRedis.del(k); },
            expire: (k: string, s: number) => realRedis.expire(k, s),
            eval: async (script: string, options: { keys: string[]; arguments: string[] }) => { await gate; return realRedis.eval(script, options); },
            lRange: (k: string, s: number, e: number) => realRedis.lRange(k, s, e),
            // Pushes are NOT delayed — only the clear is. These pass straight
            // through so the new-generation push below lands immediately.
            lPush: (k: string, v: string) => realRedis.lPush(k, v),
            lTrim: (k: string, s: number, e: number) => realRedis.lTrim(k, s, e),
        });

        // Fire-and-forget, exactly like performSessionTransitionCleanup does —
        // its Redis command is stuck behind the gate for now.
        const clearPromise = clearTriggerHistory(sessionId, before);

        // The new conversation generation starts and records its own trigger
        // before the delayed clear actually reaches Redis.
        await pushTriggerHistory(sessionId, { ...baseEntry, triggerId: "new-gen", type: "lifecycle:ask" });

        // Now let the delayed clear land.
        releaseGate!();
        await clearPromise;
        _injectRedisForTesting(realRedis);

        const history = await getTriggerHistory(sessionId);
        expect(history.map((h) => h.triggerId)).toEqual(["new-gen"]);
    });

    test("an ordinary (non-delayed) clear still hides history recorded before its cutoff", async () => {
        const sessionId = "history-ordinary-clear";
        const historyKey = `pizzapi:triggers:history:${sessionId}`;
        const cutoffKey = `pizzapi:triggers:clearedBefore:${sessionId}`;
        await redis!.del(historyKey);
        await redis!.del(cutoffKey);

        await pushTriggerHistory(sessionId, { ...baseEntry, triggerId: "old-gen", type: "lifecycle:ask" });
        await clearTriggerHistory(sessionId, Date.now());
        expect(await getTriggerHistory(sessionId)).toEqual([]);

        // See the "delayed clear" test above for why this needs real margin.
        await new Promise((resolve) => setTimeout(resolve, 5));
        await pushTriggerHistory(sessionId, { ...baseEntry, triggerId: "new-gen", type: "lifecycle:ask" });
        const history = await getTriggerHistory(sessionId);
        expect(history.map((h) => h.triggerId)).toEqual(["new-gen"]);
    });

    test("omitting the cutoff falls back to an unconditional delete (legacy callers)", async () => {
        const sessionId = "history-legacy-clear";
        const historyKey = `pizzapi:triggers:history:${sessionId}`;
        await redis!.del(historyKey);

        await pushTriggerHistory(sessionId, { ...baseEntry, triggerId: "a", type: "lifecycle:ask" });
        await clearTriggerHistory(sessionId);
        expect(await getTriggerHistory(sessionId)).toEqual([]);
    });

    test("clamps a future cutoff to now so it can't hide history that hasn't landed yet", async () => {
        const sessionId = "history-future-clamp";
        const historyKey = `pizzapi:triggers:history:${sessionId}`;
        const cutoffKey = `pizzapi:triggers:clearedBefore:${sessionId}`;
        await redis!.del(historyKey);
        await redis!.del(cutoffKey);

        // A clock-skewed-forward (or malicious) caller sends a cutoff a minute
        // in the future — it must be clamped to "now", not stored verbatim.
        await clearTriggerHistory(sessionId, Date.now() + 60_000);
        // A tiny real delay so the push below lands in a strictly later
        // millisecond than the clamped cutoff — without the clamp, a cutoff
        // a minute in the future would still hide it easily.
        await new Promise((resolve) => setTimeout(resolve, 5));
        await pushTriggerHistory(sessionId, { ...baseEntry, triggerId: "after-clear", type: "lifecycle:ask" });

        const history = await getTriggerHistory(sessionId);
        expect(history.map((h) => h.triggerId)).toEqual(["after-clear"]);
    });
});
