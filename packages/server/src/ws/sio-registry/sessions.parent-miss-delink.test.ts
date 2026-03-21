import { describe, it, expect, beforeEach, mock } from "bun:test";

// ── Minimal Redis mock (mirrors sio-state-children.test.ts) ─────────────────

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
        del: mock((key: string) => {
            ops.push(() => store.delete(key));
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
    sIsMember: mock(async (key: string, member: string) => {
        return setStore.get(key)?.has(member) ?? false;
    }),
    expire: mock(async (key: string, ttl: number) => {
        ttlStore.set(key, ttl);
    }),
    multi: mock(() => mockMulti()),
    on: mock(() => mockRedis),
    connect: mock(async () => {}),
    // String key store
    set: mock(async (key: string, value: string, _opts?: unknown) => {
        store.set(key, value);
    }),
    get: mock(async (key: string) => store.get(key) ?? null),
    del: mock(async (key: string) => {
        store.delete(key);
        setStore.delete(key);
        ttlStore.delete(key);
    }),
    exists: mock(async (key: string) => (store.has(key) ? 1 : 0)),
    hGetAll: mock(async (key: string) => {
        const raw = store.get(`__hash__:${key}`);
        return raw ? (JSON.parse(raw) as Record<string, string>) : {};
    }),
    hGet: mock(async () => null),
    hSet: mock(async (key: string, field: string, value: string) => {
        const existing = JSON.parse(store.get(`__hash__:${key}`) ?? "{}");
        existing[field] = value;
        store.set(`__hash__:${key}`, JSON.stringify(existing));
        store.set(`${key}:${field}`, value);
    }),
    incr: mock(async () => 1),
    eval: mock(async () => 0),
};

mock.module("redis", () => ({
    createClient: () => mockRedis,
}));

// Prevent this unit test from touching the real SQLite-backed session store or
// the global Socket.IO hub registry. Those are covered by separate integration
// tests; here we only care about parent link resolution.
mock.module("../../sessions/store.js", () => ({
    getEphemeralTtlMs: () => 60_000,
    recordRelaySessionStart: async () => {},
    recordRelaySessionEnd: async () => {},
    recordRelaySessionState: async () => {},
    touchRelaySession: async () => {},
}));

mock.module("./hub.js", () => ({
    broadcastToHub: async () => {},
}));

const { initStateRedis, markChildAsDelinked } = await import("../sio-state.js");
const { registerTuiSession } = await import("./sessions.js");

describe("registerTuiSession parent resolution", () => {
    beforeEach(async () => {
        store.clear();
        setStore.clear();
        ttlStore.clear();
        await initStateRedis();
    });

    it("keeps membership when parent is transiently offline", async () => {
        const socket = {
            join: async () => {},
            data: {},
        } as any;

        const result = await registerTuiSession(socket, "", {
            sessionId: "child-offline-parent",
            userId: "u1",
            userName: "User",
            isEphemeral: false,
            parentSessionId: "parent-offline",
        });

        expect(result.parentSessionId).toBeNull();
        expect(result.wasDelinked).toBe(false);

        // Parent is offline → session hash parentSessionId is cleared, but the
        // membership set should still include the child so a future /new snapshot
        // can find it.
        expect(setStore.get("pizzapi:sio:children:parent-offline")?.has("child-offline-parent")).toBe(true);
    });

    it("does NOT re-add membership when a delink marker exists (explicit /new)", async () => {
        const socket = {
            join: async () => {},
            data: {},
        } as any;

        await markChildAsDelinked("child-delinked-offline", "parent-old");

        const result = await registerTuiSession(socket, "", {
            sessionId: "child-delinked-offline",
            userId: "u1",
            userName: "User",
            isEphemeral: false,
            parentSessionId: "parent-old",
        });

        expect(result.parentSessionId).toBeNull();
        expect(result.wasDelinked).toBe(true);

        // The delink marker means the parent ran /new — do not re-add the child
        // to the old parent's membership set even if the parent is currently offline.
        expect(setStore.has("pizzapi:sio:children:parent-old")).toBe(false);
    });
});
