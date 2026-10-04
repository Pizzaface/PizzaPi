import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createClient } from "redis";
import { getBestSnapshot } from "../ws/namespaces/snapshot-provider.js";
import {
    _injectRedisForTesting,
    _resetRelayRedisCacheForTesting,
    appendRelayEventToCache,
    deleteRelayEventCaches,
    getCachedRelayEventsAfterSeq,
    getLatestCachedRelayEventSeq,
    getLatestCachedSnapshotEvent,
    initializeRelayRedisCache,
} from "./redis.js";

const redisUrl = process.env.PIZZAPI_RELAY_CACHE_TEST_REDIS_URL;
const maybeDescribe = redisUrl ? describe : describe.skip;

function assertSafeRedisUrl(url: string): void {
    const parsed = new URL(url);
    if (parsed.protocol !== "redis:") throw new Error("Redis integration test URL must use redis://");
    if (parsed.hostname !== "127.0.0.1" && parsed.hostname !== "localhost") {
        throw new Error("Redis integration test URL must point at localhost");
    }
    if (parsed.pathname === "" || parsed.pathname === "/0") {
        throw new Error("Redis integration test URL must use a non-default DB");
    }
}

function keyForSession(sessionId: string): string {
    return `pizzapi:relay:session:${sessionId}:events`;
}

function bytesKeyForSession(sessionId: string): string {
    return `${keyForSession(sessionId)}:bytes`;
}

const prefix = `cache-it-${process.pid}-${Date.now()}`;
const sessions: string[] = [];
let redis: ReturnType<typeof createClient> | undefined;
const previousEnv = {
    redisUrl: process.env.PIZZAPI_REDIS_URL,
    maxBytes: process.env.PIZZAPI_RELAY_EVENT_CACHE_MAX_BYTES,
    bufferSize: process.env.PIZZAPI_RELAY_EVENT_BUFFER_SIZE,
    ttlMs: process.env.PIZZAPI_RELAY_EVENT_TTL_MS,
};

async function resetSession(sessionId: string): Promise<void> {
    sessions.push(sessionId);
    await redis!.del([keyForSession(sessionId), bytesKeyForSession(sessionId)]);
}

async function cachedRows(sessionId: string): Promise<string[]> {
    return redis!.lRange(keyForSession(sessionId), 0, -1);
}

maybeDescribe("redis relay cache integration", () => {
    beforeAll(async () => {
        assertSafeRedisUrl(redisUrl!);
        process.env.PIZZAPI_REDIS_URL = redisUrl;
        redis = createClient({ url: redisUrl });
        await redis.connect();
        _resetRelayRedisCacheForTesting();
        _injectRedisForTesting(redis);
        await initializeRelayRedisCache();
    });

    beforeEach(() => {
        process.env.PIZZAPI_RELAY_EVENT_CACHE_MAX_BYTES = "500";
        process.env.PIZZAPI_RELAY_EVENT_BUFFER_SIZE = "1000";
        process.env.PIZZAPI_RELAY_EVENT_TTL_MS = "120000";
    });

    afterAll(async () => {
        try {
            if (redis) {
                const unique = [...new Set(sessions)];
                if (unique.length > 0) {
                    await deleteRelayEventCaches(unique);
                }
            }
        } finally {
            _resetRelayRedisCacheForTesting();
            if (previousEnv.redisUrl === undefined) delete process.env.PIZZAPI_REDIS_URL;
            else process.env.PIZZAPI_REDIS_URL = previousEnv.redisUrl;
            if (previousEnv.maxBytes === undefined) delete process.env.PIZZAPI_RELAY_EVENT_CACHE_MAX_BYTES;
            else process.env.PIZZAPI_RELAY_EVENT_CACHE_MAX_BYTES = previousEnv.maxBytes;
            if (previousEnv.bufferSize === undefined) delete process.env.PIZZAPI_RELAY_EVENT_BUFFER_SIZE;
            else process.env.PIZZAPI_RELAY_EVENT_BUFFER_SIZE = previousEnv.bufferSize;
            if (previousEnv.ttlMs === undefined) delete process.env.PIZZAPI_RELAY_EVENT_TTL_MS;
            else process.env.PIZZAPI_RELAY_EVENT_TTL_MS = previousEnv.ttlMs;
            if (redis?.isOpen) await redis.quit();
        }
    });

    test("Lua eviction keeps actual list bytes and byte counter under the cap", async () => {
        const sessionId = `${prefix}-evict`;
        await resetSession(sessionId);

        for (let seq = 1; seq <= 8; seq++) {
            await appendRelayEventToCache(sessionId, { type: "message_update", content: "x".repeat(120) }, { seq, isEphemeral: false });
        }

        const rows = await cachedRows(sessionId);
        const actualBytes = rows.reduce((sum, row) => sum + Buffer.byteLength(row, "utf8"), 0);
        const counter = Number(await redis!.get(bytesKeyForSession(sessionId)));

        expect(actualBytes).toBeLessThanOrEqual(500);
        expect(counter).toBe(actualBytes);
        expect(JSON.parse(rows.at(-1)!).seq).toBe(8);
        expect(JSON.parse(rows[0]).seq).toBeGreaterThan(1);
        expect(await redis!.pTTL(keyForSession(sessionId))).toBeGreaterThan(0);
        expect(await redis!.pTTL(bytesKeyForSession(sessionId))).toBeGreaterThan(0);
    });

    test("oversize non-snapshot events become markers; cursors beyond the marker replay the later suffix", async () => {
        const sessionId = `${prefix}-gap`;
        await resetSession(sessionId);

        await appendRelayEventToCache(sessionId, { type: "session_active", state: { messages: [] } }, { seq: 1, isEphemeral: false });
        await appendRelayEventToCache(sessionId, { type: "turn_end", message: { content: "x".repeat(2_000) } }, { seq: 2, isEphemeral: false });
        await appendRelayEventToCache(sessionId, { type: "message_end", message: { content: "done" } }, { seq: 3, isEphemeral: false });

        const rows = await cachedRows(sessionId);
        expect(rows.join("\n")).not.toContain("x".repeat(2_000));
        expect(rows.some((row) => JSON.parse(row).gap === "oversize")).toBe(true);
        expect(await getLatestCachedRelayEventSeq(sessionId)).toBe(3);
        expect(await getCachedRelayEventsAfterSeq(sessionId, 1)).toEqual([]);
        expect(await getCachedRelayEventsAfterSeq(sessionId, 2)).toEqual([
            { seq: 3, event: { type: "message_end", message: { content: "done" } } },
        ]);
        expect(await getLatestCachedSnapshotEvent(sessionId)).toBeNull();
    });

    test("oversize snapshots stay out of the cache and force lossless runner recovery", async () => {
        const sessionId = `${prefix}-snapshot`;
        await resetSession(sessionId);

        await appendRelayEventToCache(sessionId, { type: "session_active", state: { messages: [{ content: "x".repeat(2_000) }] } }, { seq: 7, isEphemeral: false });

        const rows = await cachedRows(sessionId);
        const actualBytes = rows.reduce((sum, row) => sum + Buffer.byteLength(row, "utf8"), 0);
        expect(rows).toHaveLength(1);
        expect(actualBytes).toBeLessThanOrEqual(500);
        expect(await redis!.get(bytesKeyForSession(sessionId))).toBe(String(actualBytes));
        expect(await getLatestCachedRelayEventSeq(sessionId)).toBe(7);
        expect(await getLatestCachedSnapshotEvent(sessionId)).toBeNull();

        await appendRelayEventToCache(sessionId, { type: "heartbeat" }, { seq: 8, isEphemeral: false });
        expect(await getCachedRelayEventsAfterSeq(sessionId, 6)).toEqual([]);
        // A resuming viewer must ask the runner for a fresh snapshot, not claim
        // this gap is current or silently fall back to an older lastState.
        expect(await getBestSnapshot(sessionId, {
            lastSeq: 6,
            latestSeq: 8,
            lastState: JSON.stringify({ messages: [{ content: "stale" }] }),
        })).toBeNull();
        expect(await getCachedRelayEventsAfterSeq(sessionId, 7)).toEqual([
            { seq: 8, event: { type: "heartbeat" } },
        ]);
    });

    test("full snapshots replace older rows instead of accumulating repeated transcripts", async () => {
        const sessionId = `${prefix}-compact`;
        await resetSession(sessionId);

        await appendRelayEventToCache(sessionId, { type: "session_active", state: { messages: [{ content: "old" }] } }, { seq: 1, isEphemeral: false });
        await appendRelayEventToCache(sessionId, { type: "message_update", content: "delta" }, { seq: 2, isEphemeral: false });
        await appendRelayEventToCache(sessionId, { type: "session_active", state: { messages: [{ content: "new" }] } }, { seq: 3, isEphemeral: false });

        const rows = await cachedRows(sessionId);
        const parsed = rows.map((row) => JSON.parse(row));

        expect(parsed.map((row) => row.seq)).toEqual([3]);
        expect(parsed[0].event.state.messages).toEqual([{ content: "new" }]);
    });

    test("first append after legacy rows drops unknown-size legacy data and initializes byte counter", async () => {
        const sessionId = `${prefix}-legacy`;
        await resetSession(sessionId);
        await redis!.rPush(keyForSession(sessionId), JSON.stringify({ event: { type: "legacy", content: "x".repeat(2_000) } }));

        await appendRelayEventToCache(sessionId, { type: "message_end", message: { content: "fresh" } }, { seq: 9, isEphemeral: false });

        const rows = await cachedRows(sessionId);
        const actualBytes = rows.reduce((sum, row) => sum + Buffer.byteLength(row, "utf8"), 0);

        expect(rows).toHaveLength(1);
        expect(JSON.parse(rows[0]).seq).toBe(9);
        expect(await redis!.get(bytesKeyForSession(sessionId))).toBe(String(actualBytes));
    });
});
