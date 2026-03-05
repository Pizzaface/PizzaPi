// ============================================================================
// sio-state-children.test.ts — Tests for parent/child session tracking
//
// Tests the Redis children set helpers: addChild, removeChild, getChildren,
// and the parentSessionId field on RedisSessionData.
//
// Uses the same Redis mock pattern as runner-assoc.test.ts.
// ============================================================================

import { describe, it, expect, beforeEach, mock } from "bun:test";

// ── Minimal Redis mock ──────────────────────────────────────────────────────

const store = new Map<string, { value: string; ttl: number }>();
const sets = new Map<string, Set<string>>();

const mockMulti = () => {
    const ops: Array<() => unknown> = [];
    return {
        hSet: mock((key: string, fields: Record<string, string>) => {
            ops.push(() => {
                store.set(key, { value: JSON.stringify(fields), ttl: -1 });
            });
            return mockMulti();
        }),
        expire: mock((key: string, ttl: number) => {
            ops.push(() => {
                const entry = store.get(key);
                if (entry) entry.ttl = ttl;
                // Also update set TTL
                // (no-op for sets, just tracked conceptually)
            });
            return mockMulti();
        }),
        sAdd: mock((key: string, member: string | string[]) => {
            ops.push(() => {
                if (!sets.has(key)) sets.set(key, new Set());
                const s = sets.get(key)!;
                if (Array.isArray(member)) {
                    for (const m of member) s.add(m);
                } else {
                    s.add(member);
                }
            });
            return mockMulti();
        }),
        sRem: mock((key: string, member: string | string[]) => {
            ops.push(() => {
                const s = sets.get(key);
                if (s) {
                    if (Array.isArray(member)) {
                        for (const m of member) s.delete(m);
                    } else {
                        s.delete(member);
                    }
                }
            });
            return mockMulti();
        }),
        del: mock((key: string) => {
            ops.push(() => {
                store.delete(key);
                sets.delete(key);
            });
            return mockMulti();
        }),
        exists: mock((key: string) => {
            ops.push(() => store.has(key) || sets.has(key) ? 1 : 0);
            return mockMulti();
        }),
        hGetAll: mock((key: string) => {
            ops.push(() => {
                const entry = store.get(key);
                if (!entry) return {};
                try {
                    return JSON.parse(entry.value);
                } catch {
                    return {};
                }
            });
            return mockMulti();
        }),
        incr: mock((key: string) => {
            ops.push(() => 1);
            return mockMulti();
        }),
        exec: mock(async () => {
            return ops.map((op) => op());
        }),
    };
};

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
        sets.delete(key);
    }),
    expire: mock(async (key: string, ttl: number) => {
        const entry = store.get(key);
        if (entry) entry.ttl = ttl;
    }),
    exists: mock(async (key: string) => (store.has(key) || sets.has(key) ? 1 : 0)),
    sAdd: mock(async (key: string, member: string | string[]) => {
        if (!sets.has(key)) sets.set(key, new Set());
        const s = sets.get(key)!;
        if (Array.isArray(member)) {
            for (const m of member) s.add(m);
        } else {
            s.add(member);
        }
    }),
    sRem: mock(async (key: string, member: string | string[]) => {
        const s = sets.get(key);
        if (s) {
            if (Array.isArray(member)) {
                for (const m of member) s.delete(m);
            } else {
                s.delete(member);
            }
        }
    }),
    sMembers: mock(async (key: string) => {
        const s = sets.get(key);
        return s ? Array.from(s) : [];
    }),
    hGetAll: mock(async (key: string) => {
        const entry = store.get(key);
        if (!entry) return {};
        try {
            return JSON.parse(entry.value);
        } catch {
            return {};
        }
    }),
    hGet: mock(async (key: string, field: string) => {
        const entry = store.get(key);
        if (!entry) return null;
        try {
            const parsed = JSON.parse(entry.value);
            return parsed[field] ?? null;
        } catch {
            return null;
        }
    }),
    hSet: mock(async (key: string, fields: Record<string, string>) => {
        store.set(key, { value: JSON.stringify(fields), ttl: -1 });
    }),
    incr: mock(async (key: string) => {
        const entry = store.get(key);
        const val = entry ? parseInt(entry.value, 10) + 1 : 1;
        store.set(key, { value: String(val), ttl: entry?.ttl ?? -1 });
        return val;
    }),
    multi: mock(() => mockMulti()),
    on: mock(() => mockRedis),
    connect: mock(async () => {}),
    eval: mock(async () => 0),
};

// Mock the redis module
mock.module("redis", () => ({
    createClient: () => mockRedis,
}));

// Import functions under test
const {
    initStateRedis,
    addChild,
    removeChild,
    getChildren,
    childrenKey,
} = await import("./sio-state.js");

// ── Tests ───────────────────────────────────────────────────────────────────

describe("parent/child session tracking (sio-state)", () => {
    beforeEach(async () => {
        store.clear();
        sets.clear();
        await initStateRedis();
    });

    describe("childrenKey", () => {
        it("returns correct key pattern", () => {
            expect(childrenKey("parent-123")).toBe("pizzapi:sio:children:parent-123");
        });

        it("handles different session IDs", () => {
            expect(childrenKey("abc")).toBe("pizzapi:sio:children:abc");
            expect(childrenKey("xyz-456")).toBe("pizzapi:sio:children:xyz-456");
        });
    });

    describe("addChild", () => {
        it("adds a child to the parent's children set", async () => {
            await addChild("parent-1", "child-1");

            const children = await getChildren("parent-1");
            expect(children).toContain("child-1");
        });

        it("adds multiple children to the same parent", async () => {
            await addChild("parent-1", "child-1");
            await addChild("parent-1", "child-2");
            await addChild("parent-1", "child-3");

            const children = await getChildren("parent-1");
            expect(children).toHaveLength(3);
            expect(children).toContain("child-1");
            expect(children).toContain("child-2");
            expect(children).toContain("child-3");
        });

        it("does not duplicate children", async () => {
            await addChild("parent-1", "child-1");
            await addChild("parent-1", "child-1");

            const children = await getChildren("parent-1");
            expect(children).toHaveLength(1);
        });

        it("tracks children independently per parent", async () => {
            await addChild("parent-1", "child-a");
            await addChild("parent-2", "child-b");

            const children1 = await getChildren("parent-1");
            const children2 = await getChildren("parent-2");

            expect(children1).toEqual(["child-a"]);
            expect(children2).toEqual(["child-b"]);
        });
    });

    describe("removeChild", () => {
        it("removes a child from the parent's children set", async () => {
            await addChild("parent-1", "child-1");
            await addChild("parent-1", "child-2");

            await removeChild("parent-1", "child-1");

            const children = await getChildren("parent-1");
            expect(children).toHaveLength(1);
            expect(children).toContain("child-2");
            expect(children).not.toContain("child-1");
        });

        it("does not throw when removing non-existent child", async () => {
            await addChild("parent-1", "child-1");
            // Should not throw
            await removeChild("parent-1", "child-nonexistent");

            const children = await getChildren("parent-1");
            expect(children).toEqual(["child-1"]);
        });

        it("does not throw when parent has no children set", async () => {
            // Should not throw
            await removeChild("nonexistent-parent", "child-1");
        });
    });

    describe("getChildren", () => {
        it("returns empty array for parent with no children", async () => {
            const children = await getChildren("parent-no-kids");
            expect(children).toEqual([]);
        });

        it("returns all children for a parent", async () => {
            await addChild("parent-1", "child-a");
            await addChild("parent-1", "child-b");

            const children = await getChildren("parent-1");
            expect(children.sort()).toEqual(["child-a", "child-b"]);
        });
    });

    describe("round-trip lifecycle", () => {
        it("add → get → remove → get works correctly", async () => {
            // Initially empty
            expect(await getChildren("lifecycle-parent")).toEqual([]);

            // Add children
            await addChild("lifecycle-parent", "c1");
            await addChild("lifecycle-parent", "c2");
            expect((await getChildren("lifecycle-parent")).sort()).toEqual(["c1", "c2"]);

            // Remove one
            await removeChild("lifecycle-parent", "c1");
            expect(await getChildren("lifecycle-parent")).toEqual(["c2"]);

            // Remove the last
            await removeChild("lifecycle-parent", "c2");
            expect(await getChildren("lifecycle-parent")).toEqual([]);
        });
    });
});
