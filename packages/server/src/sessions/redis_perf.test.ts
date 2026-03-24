import { describe, test, expect, spyOn, beforeAll, afterAll, mock } from "bun:test";
import { createClient } from "redis";
import { deleteRelayEventCaches, initializeRelayRedisCache, closeRelayCache } from "./redis";

// Mock the redis module
const mockDel = mock((keys: string | string[]) => Promise.resolve(1));
const mockConnect = mock(() => Promise.resolve());
const mockOn = mock(() => {});
const mockDisconnect = mock(() => Promise.resolve());
const mockQuit = mock(() => Promise.resolve());
const mockMulti = mock(() => ({
    rPush: mock(() => {}),
    lTrim: mock(() => {}),
    pExpire: mock(() => {}),
    exec: mock(() => Promise.resolve())
}));

// Mock createClient to return our mock client
mock.module("redis", () => ({
    createClient: () => ({
        connect: mockConnect,
        on: mockOn,
        disconnect: mockDisconnect,
        quit: mockQuit,
        del: mockDel,
        multi: mockMulti,
        isOpen: true
    })
}));

describe("deleteRelayEventCaches Performance", () => {
    beforeAll(async () => {
        // Close any existing client from prior test files (e.g. harness integration
        // tests that connected the real redis), then re-initialize with the mock.
        // Without closeRelayCache(), the module-level initPromise guard would skip
        // re-initialization, leaving the real redis client in place.
        await closeRelayCache();
        await initializeRelayRedisCache();
    });

    test("should call del once with all keys (optimized)", async () => {
        // Reset mock calls before test
        mockDel.mockClear();

        const sessionIds = ["s1", "s2", "s3"];
        await deleteRelayEventCaches(sessionIds);

        // Expectation for optimized implementation: called once with all keys
        expect(mockDel).toHaveBeenCalledTimes(1);

        // Check arguments for the call
        expect(mockDel.mock.calls[0]).toEqual([
            [
                "pizzapi:relay:session:s1:events",
                "pizzapi:relay:session:s2:events",
                "pizzapi:relay:session:s3:events"
            ]
        ]);
    });

    test("should handle redis errors gracefully", async () => {
        // Mock del to throw error
        mockDel.mockImplementationOnce(() => Promise.reject(new Error("Redis error")));
        const consoleSpy = spyOn(console, "warn").mockImplementation(() => {});

        const sessionIds = ["s1"];
        await deleteRelayEventCaches(sessionIds);

        // Should verify that it caught the error and logged it
        expect(consoleSpy).toHaveBeenCalled();
        expect(consoleSpy.mock.calls[0][0]).toContain("Failed to delete relay event caches from Redis");

        consoleSpy.mockRestore();
    });
});

// ── Restore real redis module after this file ──────────────────────────────
// Bun 1.3.x does not reset mock.module() between test files in the same
// worker. Without this cleanup, the redis mock set above would persist and
// contaminate harness tests (createTestServer) that need the real redis
// client (with .pSubscribe(), .subscribe(), .quit(), etc.).
afterAll(() => {
    const real = (globalThis as Record<string, unknown>).__realRedisCreateClient;
    if (real) {
        mock.module("redis", () => ({ createClient: real }));
    }
});
