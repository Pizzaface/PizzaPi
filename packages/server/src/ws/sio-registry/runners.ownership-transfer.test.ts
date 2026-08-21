import { afterAll, describe, it, expect, mock, beforeEach } from "bun:test";

/**
 * Health-inspection test (Lane B): runner re-registration ownership guard.
 *
 * A runner's persistent identity is bound to (runnerId, runnerSecret). When the
 * daemon reconnects it presents the same pair plus the userId derived from its
 * API key. `registerRunner()` validates the secret, but it does not verify that
 * the incoming userId matches the runner's existing owner before overwriting
 * the Redis runner hash. A leaked or reused runnerSecret therefore lets any
 * authenticated user take ownership of another user's runner, and with it every
 * session, tunnel, skill, and provider credential reachable through that
 * runner's API routes.
 *
 * The `getAllRunners()` filter catches the stale per-user index entry at
 * listing time, but it does not prevent the ownership flip in Redis: the new
 * owner can immediately spawn sessions, read settings, and route triggers
 * through the hijacked runner while the old owner's live sessions remain
 * associated with the same runnerId.
 *
 * This test reproduces the missing guard with the same in-memory Redis mock
 * used by runners.broadcast.test.ts.
 */

const store = new Map<string, string>();
const setStore = new Map<string, Set<string>>();

const mockMulti = () => {
    const ops: Array<() => void> = [];
    return {
        hSet: mock((key: string, fields: Record<string, string>) => {
            ops.push(() => {
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
        expire: mock(() => mockMulti()),
        del: mock((key: string) => {
            ops.push(() => {
                store.delete(key);
                store.delete(`__hash__:${key}`);
            });
            return mockMulti();
        }),
        exec: mock(async () => {
            for (const op of ops) op();
            return [];
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
    sMembers: mock(async (key: string) => Array.from(setStore.get(key) ?? [])),
    sRem: mock(async (key: string, ...members: string[]) => {
        const s = setStore.get(key);
        if (s) for (const m of members.flat()) s.delete(m);
    }),
    expire: mock(async () => {}),
    multi: mock(() => mockMulti()),
    on: mock(() => mockRedis),
    connect: mock(async () => {}),
    set: mock(async (key: string, value: string) => {
        store.set(key, value);
    }),
    get: mock(async (key: string) => store.get(key) ?? null),
    del: mock(async (key: string) => {
        store.delete(key);
        store.delete(`__hash__:${key}`);
    }),
    hGetAll: mock(async (key: string) => {
        const raw = store.get(`__hash__:${key}`);
        return raw ? (JSON.parse(raw) as Record<string, string>) : {};
    }),
    hGet: mock(async () => null),
    hSet: mock(async (key: string, field: string, value: string) => {
        const existing = JSON.parse(store.get(`__hash__:${key}`) ?? "{}");
        existing[field] = value;
        store.set(`__hash__:${key}`, JSON.stringify(existing));
    }),
    incr: mock(async () => 1),
    exists: mock(async (key: string) => {
        return store.has(`__hash__:${key}`) ? 1 : 0;
    }),
};

mock.module("./hub.js", () => ({ broadcastToHub: mock(async () => {}) }));

afterAll(() => mock.restore());
mock.restore();

const emitCalls: Array<{ namespace: string; room?: string; event: string; data: unknown; local: boolean }> = [];

function createFakeIo() {
    const nsCache = new Map<string, any>();
    const makeNs = (namespace: string) => {
        const record = (event: string, data: unknown, room: string | undefined, local: boolean) => {
            emitCalls.push({ namespace, room, event, data, local });
        };
        const mkTo = (room: string, local: boolean) => ({
            emit: (event: string, data: unknown) => record(event, data, room, local),
        });
        return {
            emit: (event: string, data: unknown) => record(event, data, undefined, false),
            to: (room: string) => mkTo(room, false),
            local: {
                emit: (event: string, data: unknown) => record(event, data, undefined, true),
                to: (room: string) => mkTo(room, true),
            },
        };
    };
    return {
        of: (namespace: string) => {
            if (!nsCache.has(namespace)) nsCache.set(namespace, makeNs(namespace));
            return nsCache.get(namespace);
        },
    };
}

const { initSioRegistry, runnersUserRoom, runnerSecrets } = await import("./context.js");
const { initStateRedis } = await import("../sio-state/index.js");
const { registerRunner, getRunnerData } = await import("./runners.js");

describe("runner re-registration ownership guard", () => {
    beforeEach(async () => {
        store.clear();
        setStore.clear();
        emitCalls.length = 0;
        runnerSecrets.clear();
        initSioRegistry(createFakeIo() as any);
        await initStateRedis(mockRedis as never);
    });

    it("rejects re-registration that would transfer runner ownership to a different user", async () => {
        const runnerId = "shared-runner";
        const runnerSecret = "same-secret";
        const socketA = { join: mock(async () => {}), data: {} } as any;

        // User A claims the runner.
        const first = await registerRunner(socketA, {
            name: "owned-by-a",
            roots: [],
            requestedRunnerId: runnerId,
            runnerSecret,
            skills: [],
            agents: [],
            plugins: [],
            hooks: [],
            version: null,
            platform: null,
            userId: "user-a",
            userName: "User A",
        });
        expect(first).toBe(runnerId);
        const ownerA = await getRunnerData(runnerId);
        expect(ownerA?.userId).toBe("user-a");

        // User B re-registers with the same secret. This must be rejected,
        // not silently transfer ownership.
        const socketB = { join: mock(async () => {}), data: {} } as any;
        const second = await registerRunner(socketB, {
            name: "owned-by-b",
            roots: [],
            requestedRunnerId: runnerId,
            runnerSecret,
            skills: [],
            agents: [],
            plugins: [],
            hooks: [],
            version: null,
            platform: null,
            userId: "user-b",
            userName: "User B",
        });

        expect(second instanceof Error).toBe(true);
        const ownerAfter = await getRunnerData(runnerId);
        expect(ownerAfter?.userId).toBe("user-a");
    });
});
