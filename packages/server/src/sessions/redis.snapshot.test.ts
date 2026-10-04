import { beforeEach, describe, expect, mock, test } from "bun:test";
import {
    _resetRelayRedisCacheForTesting,
    _injectRedisForTesting,
    appendRelayEventToCache,
    getCachedRelayEvents,
    getCachedRelayEventsAfterSeq,
    getLatestCachedRelayEventSeq,
    getLatestCachedSnapshotEvent,
    initializeRelayRedisCache,
} from "./redis";

// ── In-memory Redis mock ─────────────────────────────────────────────────────

const rowsByKey = new Map<string, string[]>();
const bytesByKey = new Map<string, number>();
const lRangeCalls: Array<{ key: string; start: number; end: number }> = [];

const mockLlen = mock((key: string) => Promise.resolve((rowsByKey.get(key) ?? []).length));
const mockLrange = mock((key: string, start: number, end: number) => {
    lRangeCalls.push({ key, start, end });
    const rows = rowsByKey.get(key) ?? [];
    const normalizedEnd = end < 0 ? rows.length - 1 : end;
    return Promise.resolve(rows.slice(start, normalizedEnd + 1));
});
const mockEval = mock((_script: string, opts: { keys: string[]; arguments: string[] }) => {
    const [listKey, bytesKey] = opts.keys;
    const [payload, payloadBytesRaw, maxCountRaw, maxBytesRaw] = opts.arguments;
    const compactSnapshotRaw = opts.arguments[5];
    const payloadBytes = Number.parseInt(payloadBytesRaw, 10);
    const maxCount = Number.parseInt(maxCountRaw, 10);
    const maxBytes = Number.parseInt(maxBytesRaw, 10);
    const rows = rowsByKey.get(listKey) ?? [];
    let total = bytesByKey.get(bytesKey) ?? 0;
    if (compactSnapshotRaw === "1") {
        rows.length = 0;
        total = 0;
    }
    rows.push(payload);
    total += payloadBytes;

    const popOldest = () => {
        const row = rows.shift();
        if (!row) return;
        total -= Buffer.byteLength(row, "utf8");
    };

    while (rows.length > maxCount) popOldest();
    while (total > maxBytes && rows.length > 1) popOldest();

    rowsByKey.set(listKey, rows);
    bytesByKey.set(bytesKey, Math.max(0, total));
    return Promise.resolve(total);
});

const mockRedisClient = {
    isOpen: true,
    lLen: mockLlen,
    lRange: mockLrange,
    eval: mockEval,
    del: mock(() => Promise.resolve(1)),
    multi: mock(() => ({
        rPush: mock(() => {}),
        lTrim: mock(() => {}),
        pExpire: mock(() => {}),
        exec: mock(() => Promise.resolve()),
    })),
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function keyForSession(sessionId: string): string {
    return `pizzapi:relay:session:${sessionId}:events`;
}

function rowForEvent(event: unknown, seq?: number): string {
    return JSON.stringify(
        typeof seq === "number"
            ? { seq, event }
            : { ts: Date.now(), event },
    );
}

function noiseEvent(index: number): Record<string, unknown> {
    return { type: "tool_use", id: `tc-${index}` };
}

async function resetMockRedis(): Promise<void> {
    rowsByKey.clear();
    bytesByKey.clear();
    lRangeCalls.length = 0;
    mockLlen.mockClear();
    mockLrange.mockClear();
    mockEval.mockClear();
    _resetRelayRedisCacheForTesting();
    _injectRedisForTesting(mockRedisClient);
    process.env.PIZZAPI_RELAY_SNAPSHOT_SCAN_CHUNK_SIZE = "4";
    delete process.env.PIZZAPI_RELAY_EVENT_CACHE_MAX_BYTES;
    delete process.env.PIZZAPI_RELAY_EVENT_BUFFER_SIZE;
    await initializeRelayRedisCache();
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("getCachedRelayEventsAfterSeq", () => {
    beforeEach(resetMockRedis);

    test("returns only events newer than the requested seq", async () => {
        const sessionId = "s-delta";
        const key = keyForSession(sessionId);
        rowsByKey.set(key, [
            rowForEvent({ type: "heartbeat", status: "older" }, 10),
            rowForEvent({ type: "message_start", id: "m-1" }, 11),
            rowForEvent({ type: "message_end", id: "m-1" }, 12),
        ]);

        const events = await getCachedRelayEventsAfterSeq(sessionId, 10);

        expect(events).toEqual([
            { seq: 11, event: { type: "message_start", id: "m-1" } },
            { seq: 12, event: { type: "message_end", id: "m-1" } },
        ]);
    });

    test("falls back to empty when legacy cache rows do not carry seq data", async () => {
        const sessionId = "s-legacy";
        const key = keyForSession(sessionId);
        rowsByKey.set(key, [
            rowForEvent({ type: "session_active", state: { messages: [] } }),
            rowForEvent({ type: "message_start", id: "m-1" }, 3),
        ]);

        const events = await getCachedRelayEventsAfterSeq(sessionId, 1);

        expect(events).toEqual([]);
    });

    test("replays a contiguous suffix when the viewer cursor is already beyond an older gap marker", async () => {
        const sessionId = "s-gap-behind-cursor";
        const key = keyForSession(sessionId);
        rowsByKey.set(key, [
            JSON.stringify({ seq: 2, gap: "oversize" }),
            rowForEvent({ type: "message_start", id: "m-3" }, 3),
            rowForEvent({ type: "message_end", id: "m-3" }, 4),
        ]);

        expect(await getCachedRelayEventsAfterSeq(sessionId, 2)).toEqual([
            { seq: 3, event: { type: "message_start", id: "m-3" } },
            { seq: 4, event: { type: "message_end", id: "m-3" } },
        ]);
        expect(await getCachedRelayEventsAfterSeq(sessionId, 1)).toEqual([]);
    });
});

describe("appendRelayEventToCache byte cap", () => {
    beforeEach(async () => {
        await resetMockRedis();
        process.env.PIZZAPI_RELAY_EVENT_CACHE_MAX_BYTES = "500";
        process.env.PIZZAPI_RELAY_EVENT_BUFFER_SIZE = "1000";
    });

    test("trims oldest rows to keep each session cache byte-bounded", async () => {
        const sessionId = "s-byte-cap";
        const key = keyForSession(sessionId);

        for (let seq = 1; seq <= 8; seq++) {
            await appendRelayEventToCache(sessionId, { type: "message_update", content: "x".repeat(120), seq }, { seq });
        }

        const rows = rowsByKey.get(key) ?? [];
        const totalBytes = rows.reduce((sum, row) => sum + Buffer.byteLength(row, "utf8"), 0);
        const cached = await getCachedRelayEvents(sessionId);

        expect(totalBytes).toBeLessThanOrEqual(500);
        expect(cached.at(-1)?.seq).toBe(8);
        expect(cached[0]?.seq).toBeGreaterThan(1);
    });

    test("stores an oversize gap marker instead of a huge payload and forces snapshot fallback", async () => {
        const sessionId = "s-oversize-gap";
        const key = keyForSession(sessionId);

        await appendRelayEventToCache(sessionId, { type: "session_active", state: { messages: [] } }, { seq: 1 });
        await appendRelayEventToCache(sessionId, { type: "message_update", content: "x".repeat(2_000) }, { seq: 2 });
        await appendRelayEventToCache(sessionId, { type: "message_end" }, { seq: 3 });

        const rows = rowsByKey.get(key) ?? [];
        expect(rows.join("\n")).not.toContain("x".repeat(2_000));
        expect(await getLatestCachedRelayEventSeq(sessionId)).toBe(3);
        expect(await getCachedRelayEventsAfterSeq(sessionId, 1)).toEqual([]);
        expect(await getLatestCachedSnapshotEvent(sessionId)).toBeNull();
    });

    test("full snapshots replace older cache rows instead of accumulating", async () => {
        const sessionId = "s-snapshot-compaction";
        const key = keyForSession(sessionId);

        await appendRelayEventToCache(sessionId, { type: "session_active", state: { messages: [{ content: "old" }] } }, { seq: 1 });
        await appendRelayEventToCache(sessionId, { type: "message_update", content: "delta" }, { seq: 2 });
        await appendRelayEventToCache(sessionId, { type: "session_active", state: { messages: [{ content: "new" }] } }, { seq: 3 });

        const rows = rowsByKey.get(key) ?? [];
        const cached = await getCachedRelayEvents(sessionId);
        const snapshot = await getLatestCachedSnapshotEvent(sessionId);

        expect(rows).toHaveLength(1);
        expect(cached.map((event) => event.seq)).toEqual([3]);
        expect(snapshot?.snapshotSeq).toBe(3);
        expect(snapshot?.event).toMatchObject({ type: "session_active", state: { messages: [{ content: "new" }] } });
    });

    test("marks oversize full snapshots as gaps and keeps subsequent events within the byte cap", async () => {
        const sessionId = "s-oversize-snapshot";
        const key = keyForSession(sessionId);

        await appendRelayEventToCache(sessionId, { type: "session_active", state: { messages: [{ content: "x".repeat(2_000) }] } }, { seq: 4 });

        const rows = rowsByKey.get(key) ?? [];
        const totalBytes = rows.reduce((sum, row) => sum + Buffer.byteLength(row, "utf8"), 0);
        expect(totalBytes).toBeLessThanOrEqual(500);
        expect(await getLatestCachedRelayEventSeq(sessionId)).toBe(4);
        expect(await getLatestCachedSnapshotEvent(sessionId)).toBeNull();

        await appendRelayEventToCache(sessionId, { type: "heartbeat" }, { seq: 5 });
        expect(await getCachedRelayEventsAfterSeq(sessionId, 3)).toEqual([]);
        expect(await getCachedRelayEventsAfterSeq(sessionId, 4)).toEqual([
            { seq: 5, event: { type: "heartbeat" } },
        ]);
        expect(await getLatestCachedSnapshotEvent(sessionId)).toBeNull();
    });
});

describe("getLatestCachedSnapshotEvent", () => {
    beforeEach(resetMockRedis);

    test("returns events cached after the snapshot in chronological order", async () => {
        const sessionId = "s-after";
        const key = keyForSession(sessionId);
        rowsByKey.set(key, [
            rowForEvent(noiseEvent(0)),
            rowForEvent({ type: "session_active", state: { messages: [] } }),
            JSON.stringify({ seq: 7, event: { type: "message_start" } }),
            JSON.stringify({ seq: 8, event: { type: "message_end" } }),
        ]);

        const snapshot = await getLatestCachedSnapshotEvent(sessionId);

        expect(snapshot?.event.type).toBe("session_active");
        expect(snapshot?.eventsAfter.map((e) => e.seq)).toEqual([7, 8]);
    });

    test("returns latest snapshot and only scans the newest chunk when snapshot is near tail", async () => {
        const sessionId = "s-tail";
        const key = keyForSession(sessionId);
        const rows = Array.from({ length: 10 }, (_, i) => rowForEvent(noiseEvent(i)));
        rows.push(rowForEvent({ type: "session_active", state: { messages: [] } }));
        rowsByKey.set(key, rows);

        const snapshot = await getLatestCachedSnapshotEvent(sessionId);

        expect(snapshot).not.toBeNull();
        expect(snapshot?.event.type).toBe("session_active");
        expect(lRangeCalls).toHaveLength(1);
        expect(lRangeCalls[0]).toEqual({ key, start: 7, end: 10 });
    });

    test("scans older chunks when needed and returns oldest snapshot", async () => {
        const sessionId = "s-head";
        const key = keyForSession(sessionId);
        const rows = [
            rowForEvent({ type: "agent_end", messages: [{ role: "assistant", content: "done" }] }),
            ...Array.from({ length: 9 }, (_, i) => rowForEvent(noiseEvent(i))),
        ];
        rowsByKey.set(key, rows);

        const snapshot = await getLatestCachedSnapshotEvent(sessionId);

        expect(snapshot).not.toBeNull();
        expect(snapshot?.event.type).toBe("agent_end");
        expect(lRangeCalls).toEqual([
            { key, start: 6, end: 9 },
            { key, start: 2, end: 5 },
            { key, start: 0, end: 1 },
        ]);
    });

    test("ignores malformed rows and returns null when no snapshot exists", async () => {
        const sessionId = "s-none";
        const key = keyForSession(sessionId);
        rowsByKey.set(key, [
            "not-json",
            rowForEvent(noiseEvent(1)),
            rowForEvent({ type: "agent_end", messages: "not-array" }),
        ]);

        const snapshot = await getLatestCachedSnapshotEvent(sessionId);

        expect(snapshot).toBeNull();
        expect(lRangeCalls.length).toBeGreaterThan(0);
    });
});
