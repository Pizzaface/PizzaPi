import { beforeEach, describe, expect, mock, test } from "bun:test";
import {
    _resetRelayRedisCacheForTesting,
    _injectRedisForTesting,
    getLatestCachedSnapshotEvent,
    initializeRelayRedisCache,
} from "./redis";

// ── In-memory Redis mock ─────────────────────────────────────────────────────

const rowsByKey = new Map<string, string[]>();
const lRangeCalls: Array<{ key: string; start: number; end: number }> = [];

const mockLlen = mock((key: string) => Promise.resolve((rowsByKey.get(key) ?? []).length));
const mockLrange = mock((key: string, start: number, end: number) => {
    lRangeCalls.push({ key, start, end });
    const rows = rowsByKey.get(key) ?? [];
    return Promise.resolve(rows.slice(start, end + 1));
});

const mockRedisClient = {
    isOpen: true,
    lLen: mockLlen,
    lRange: mockLrange,
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

function rowForEvent(event: unknown): string {
    return JSON.stringify({ ts: Date.now(), event });
}

function noiseEvent(index: number): Record<string, unknown> {
    return { type: "tool_use", id: `tc-${index}` };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("getLatestCachedSnapshotEvent", () => {
    beforeEach(async () => {
        rowsByKey.clear();
        lRangeCalls.length = 0;
        mockLlen.mockClear();
        mockLrange.mockClear();
        _resetRelayRedisCacheForTesting();
        _injectRedisForTesting(mockRedisClient);
        process.env.PIZZAPI_RELAY_SNAPSHOT_SCAN_CHUNK_SIZE = "4";
        await initializeRelayRedisCache();
    });

    test("returns latest snapshot and only scans the newest chunk when snapshot is near tail", async () => {
        const sessionId = "s-tail";
        const key = keyForSession(sessionId);
        const rows = Array.from({ length: 10 }, (_, i) => rowForEvent(noiseEvent(i)));
        rows.push(rowForEvent({ type: "session_active", state: { messages: [] } }));
        rowsByKey.set(key, rows);

        const snapshot = await getLatestCachedSnapshotEvent(sessionId);

        expect(snapshot).not.toBeNull();
        expect(snapshot?.type).toBe("session_active");
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
        expect(snapshot?.type).toBe("agent_end");
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
