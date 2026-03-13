// ============================================================================
// sio-state-children.test.ts — Tests for child session Redis helpers
//
// Tests the addChildSession/getChildSessions/removeChildSession functions
// and the parentSessionId field in parseSessionFromHash.
//
// We mock the Redis client at module level so no live Redis is needed.
// ============================================================================

import { describe, it, expect, beforeEach, mock } from "bun:test";

// ── Minimal Redis mock ──────────────────────────────────────────────────────

const store = new Map<string, string>();
const setStore = new Map<string, Set<string>>();
const ttlStore = new Map<string, number>();

const mockMulti = () => {
    const ops: Array<() => void> = [];
    return {
        hSet: mock((key: string, fields: Record<string, string>) => {
            ops.push(() => {
                for (const [k, v] of Object.entries(fields)) {
                    store.set(`${key}:${k}`, v);
                }
                // Also store as hash for hGetAll
                const existing = JSON.parse(store.get(`__hash__:${key}`) ?? "{}");
                Object.assign(existing, fields);
                store.set(`__hash__:${key}`, JSON.stringify(existing));
            });
            return mockMulti();
        }),
        sAdd: mock((key: string, ...members: string[]) => {
            ops.push(() => {
                const s = setStore.get(key) ?? new Set();
                for (const m of members.flat()) s.add(m);
                setStore.set(key, s);
            });
            return mockMulti();
        }),
        sRem: mock((key: string, ...members: string[]) => {
            ops.push(() => {
                const s = setStore.get(key);
                if (s) for (const m of members.flat()) s.delete(m);
            });
            return mockMulti();
        }),
        expire: mock((key: string, ttl: number) => {
            ops.push(() => ttlStore.set(key, ttl));
            return mockMulti();
        }),
        exec: mock(async () => {
            for (const op of ops) op();
            return ops.map(() => "OK");
        }),
    };
};

const mockRedis = {
    isOpen: true,
    sAdd: mock(async (key: string, ...members: string[]) => {
        const s = setStore.get(key) ?? new Set();
        for (const m of members.flat()) s.add(m);
        setStore.set(key, s);
    }),
    sMembers: mock(async (key: string) => {
        return Array.from(setStore.get(key) ?? []);
    }),
    sRem: mock(async (key: string, ...members: string[]) => {
        const s = setStore.get(key);
        if (s) for (const m of members.flat()) s.delete(m);
    }),
    expire: mock(async (key: string, ttl: number) => {
        ttlStore.set(key, ttl);
    }),
    multi: mock(() => mockMulti()),
    on: mock(() => mockRedis),
    connect: mock(async () => {}),
    // For other sio-state functions that might be called during import
    set: mock(async () => {}),
    get: mock(async () => null),
    del: mock(async () => {}),
    exists: mock(async () => 0),
    hGetAll: mock(async () => ({})),
    hGet: mock(async () => null),
    incr: mock(async () => 1),
    eval: mock(async () => 0),
};

mock.module("redis", () => ({
    createClient: () => mockRedis,
}));

const {
    initStateRedis,
    addChildSession,
    getChildSessions,
    removeChildSession,
} = await import("./sio-state.js");

// ── Tests ───────────────────────────────────────────────────────────────────

describe("child session helpers (sio-state)", () => {
    beforeEach(async () => {
        store.clear();
        setStore.clear();
        ttlStore.clear();
        await initStateRedis();
    });

    it("addChildSession adds a child to the parent's set", async () => {
        await addChildSession("parent-1", "child-1");
        const children = await getChildSessions("parent-1");
        expect(children).toContain("child-1");
    });

    it("addChildSession supports multiple children", async () => {
        await addChildSession("parent-1", "child-1");
        await addChildSession("parent-1", "child-2");
        await addChildSession("parent-1", "child-3");
        const children = await getChildSessions("parent-1");
        expect(children.sort()).toEqual(["child-1", "child-2", "child-3"]);
    });

    it("getChildSessions returns empty array for parentless sessions", async () => {
        const children = await getChildSessions("nonexistent-parent");
        expect(children).toEqual([]);
    });

    it("removeChildSession removes a specific child", async () => {
        await addChildSession("parent-1", "child-1");
        await addChildSession("parent-1", "child-2");
        await removeChildSession("parent-1", "child-1");
        const children = await getChildSessions("parent-1");
        expect(children).toEqual(["child-2"]);
    });

    it("removeChildSession is safe on nonexistent child", async () => {
        await addChildSession("parent-1", "child-1");
        await removeChildSession("parent-1", "nonexistent");
        const children = await getChildSessions("parent-1");
        expect(children).toEqual(["child-1"]);
    });

    it("addChildSession is idempotent (adding same child twice)", async () => {
        await addChildSession("parent-1", "child-1");
        await addChildSession("parent-1", "child-1");
        const children = await getChildSessions("parent-1");
        expect(children).toEqual(["child-1"]);
    });
});
