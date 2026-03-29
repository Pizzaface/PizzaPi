// ============================================================================
// runner-assoc.test.ts — Tests for the durable runner association feature
//
// These tests validate the JSON serialization/parsing logic used by the
// runner association Redis keys.  The actual Redis calls are integration-level
// (require a live Redis), so we test the contract: given a stored value,
// does getRunnerAssociation return the correct result?
//
// We mock the Redis client at module level so no live Redis is needed.
// ============================================================================

import { describe, it, expect, beforeEach, mock } from "bun:test";

// ── Minimal Redis mock ──────────────────────────────────────────────────────

const store = new Map<string, { value: string; ttl: number }>();

const mockRedis = {
    isOpen: true,
    set: mock(async (key: string, value: string, opts?: { EX?: number }) => {
        store.set(key, { value, ttl: opts?.EX ?? -1 });
    }),
    get: mock(async (key: string) => {
        return store.get(key)?.value ?? null;
    }),
    del: mock(async (key: string) => {
        store.delete(key);
    }),
    expire: mock(async (key: string, ttl: number) => {
        const entry = store.get(key);
        if (entry) entry.ttl = ttl;
    }),
    exists: mock(async (key: string) => (store.has(key) ? 1 : 0)),
    on: mock(() => mockRedis),
    connect: mock(async () => {}),
};

// Import the functions under test — no mock.module needed; we pass mockRedis
// directly to initStateRedis() (dependency injection).
import {
    initStateRedis,
    setRunnerAssociation,
    getRunnerAssociation,
    deleteRunnerAssociation,
    refreshRunnerAssociationTTL,
} from "./sio-state.js";

// ── Tests ───────────────────────────────────────────────────────────────────

describe("runner association (sio-state)", () => {
    beforeEach(async () => {
        store.clear();
        mockRedis.set.mockClear();
        mockRedis.get.mockClear();
        mockRedis.del.mockClear();
        mockRedis.expire.mockClear();

        // Inject the mock Redis client directly (no mock.module needed).
        await initStateRedis(mockRedis as never);
    });

    describe("setRunnerAssociation", () => {
        it("stores runnerId and runnerName as JSON with TTL", async () => {
            await setRunnerAssociation("sess-1", "runner-1", "My Runner");

            const key = "pizzapi:sio:runner-assoc:sess-1";
            const entry = store.get(key);
            expect(entry).toBeDefined();
            expect(JSON.parse(entry!.value)).toEqual({
                runnerId: "runner-1",
                runnerName: "My Runner",
            });
            // TTL should be 24 hours
            expect(entry!.ttl).toBe(24 * 60 * 60);
        });

        it("stores null runnerName", async () => {
            await setRunnerAssociation("sess-2", "runner-2", null);

            const key = "pizzapi:sio:runner-assoc:sess-2";
            const entry = store.get(key);
            expect(JSON.parse(entry!.value)).toEqual({
                runnerId: "runner-2",
                runnerName: null,
            });
        });

        it("overwrites previous association", async () => {
            await setRunnerAssociation("sess-1", "runner-old", "Old");
            await setRunnerAssociation("sess-1", "runner-new", "New");

            const key = "pizzapi:sio:runner-assoc:sess-1";
            const entry = store.get(key);
            expect(JSON.parse(entry!.value)).toEqual({
                runnerId: "runner-new",
                runnerName: "New",
            });
        });
    });

    describe("getRunnerAssociation", () => {
        it("returns runnerId and runnerName when key exists", async () => {
            await setRunnerAssociation("sess-1", "runner-1", "My Runner");

            const result = await getRunnerAssociation("sess-1");
            expect(result).toEqual({
                runnerId: "runner-1",
                runnerName: "My Runner",
            });
        });

        it("returns null runnerName when stored as null", async () => {
            await setRunnerAssociation("sess-1", "runner-1", null);

            const result = await getRunnerAssociation("sess-1");
            expect(result).toEqual({
                runnerId: "runner-1",
                runnerName: null,
            });
        });

        it("returns null when key does not exist", async () => {
            const result = await getRunnerAssociation("nonexistent");
            expect(result).toBeNull();
        });

        it("returns null for malformed JSON", async () => {
            store.set("pizzapi:sio:runner-assoc:bad-json", {
                value: "not-valid-json{",
                ttl: 100,
            });

            const result = await getRunnerAssociation("bad-json");
            expect(result).toBeNull();
        });

        it("returns null when JSON lacks runnerId", async () => {
            store.set("pizzapi:sio:runner-assoc:no-id", {
                value: JSON.stringify({ runnerName: "orphan" }),
                ttl: 100,
            });

            const result = await getRunnerAssociation("no-id");
            expect(result).toBeNull();
        });

        it("returns null when runnerId is not a string", async () => {
            store.set("pizzapi:sio:runner-assoc:bad-id", {
                value: JSON.stringify({ runnerId: 123, runnerName: "bad" }),
                ttl: 100,
            });

            const result = await getRunnerAssociation("bad-id");
            expect(result).toBeNull();
        });

        it("treats non-string runnerName as null", async () => {
            store.set("pizzapi:sio:runner-assoc:num-name", {
                value: JSON.stringify({ runnerId: "r1", runnerName: 42 }),
                ttl: 100,
            });

            const result = await getRunnerAssociation("num-name");
            expect(result).toEqual({ runnerId: "r1", runnerName: null });
        });
    });

    describe("deleteRunnerAssociation", () => {
        it("removes the key", async () => {
            await setRunnerAssociation("sess-1", "runner-1", "R");

            await deleteRunnerAssociation("sess-1");

            const result = await getRunnerAssociation("sess-1");
            expect(result).toBeNull();
            expect(store.has("pizzapi:sio:runner-assoc:sess-1")).toBe(false);
        });

        it("does not throw when key does not exist", async () => {
            // Should not throw
            await deleteRunnerAssociation("nonexistent");
        });
    });

    describe("refreshRunnerAssociationTTL", () => {
        it("refreshes TTL on existing key", async () => {
            await setRunnerAssociation("sess-1", "runner-1", "R");

            // Simulate TTL decay
            const entry = store.get("pizzapi:sio:runner-assoc:sess-1")!;
            entry.ttl = 100; // Almost expired

            await refreshRunnerAssociationTTL("sess-1");

            // TTL should be refreshed to 24 hours
            expect(entry.ttl).toBe(24 * 60 * 60);
        });
    });

    describe("round-trip: set → get → delete → get", () => {
        it("full lifecycle works correctly", async () => {
            // Initially empty
            expect(await getRunnerAssociation("sess-lifecycle")).toBeNull();

            // Set
            await setRunnerAssociation("sess-lifecycle", "runner-x", "Runner X");
            expect(await getRunnerAssociation("sess-lifecycle")).toEqual({
                runnerId: "runner-x",
                runnerName: "Runner X",
            });

            // Overwrite
            await setRunnerAssociation("sess-lifecycle", "runner-y", "Runner Y");
            expect(await getRunnerAssociation("sess-lifecycle")).toEqual({
                runnerId: "runner-y",
                runnerName: "Runner Y",
            });

            // Delete
            await deleteRunnerAssociation("sess-lifecycle");
            expect(await getRunnerAssociation("sess-lifecycle")).toBeNull();
        });
    });
});
