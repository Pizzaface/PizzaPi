import { describe, test, expect, spyOn, beforeAll, mock } from "bun:test";
import {
    deleteRelayEventCaches,
    initializeRelayRedisCache,
    _resetRelayRedisCacheForTesting,
    _injectRedisForTesting,
} from "./redis";

// ── In-memory Redis mock ─────────────────────────────────────────────────────

const mockDel = mock((keys: string | string[]) => Promise.resolve(1));

const mockRedisClient = {
    isOpen: true,
    del: mockDel,
    multi: mock(() => ({
        rPush: mock(() => {}),
        lTrim: mock(() => {}),
        pExpire: mock(() => {}),
        exec: mock(() => Promise.resolve()),
    })),
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("deleteRelayEventCaches Performance", () => {
    beforeAll(async () => {
        _resetRelayRedisCacheForTesting();
        _injectRedisForTesting(mockRedisClient);
        await initializeRelayRedisCache();
    });

    test("should call del once with all keys (optimized)", async () => {
        mockDel.mockClear();

        const sessionIds = ["s1", "s2", "s3"];
        await deleteRelayEventCaches(sessionIds);

        expect(mockDel).toHaveBeenCalledTimes(1);
        expect(mockDel.mock.calls[0]).toEqual([
            [
                "pizzapi:relay:session:s1:events",
                "pizzapi:relay:session:s2:events",
                "pizzapi:relay:session:s3:events",
            ],
        ]);
    });

    test("should handle redis errors gracefully", async () => {
        _resetRelayRedisCacheForTesting();
        _injectRedisForTesting(mockRedisClient);

        mockDel.mockImplementationOnce(() => Promise.reject(new Error("Redis error")));
        const consoleSpy = spyOn(console, "warn").mockImplementation(() => {});

        const sessionIds = ["s1"];
        await deleteRelayEventCaches(sessionIds);

        expect(consoleSpy).toHaveBeenCalled();
        const allArgs = consoleSpy.mock.calls[0].join(" ");
        expect(allArgs).toContain("Failed to delete relay event caches from Redis");

        consoleSpy.mockRestore();
    });
});
