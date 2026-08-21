import { describe, test, expect, mock, beforeEach, afterAll } from "bun:test";

// In-memory Redis mock stores both plain keys and hash-backed keys.
const store = new Map<string, string>();
const setStore = new Map<string, Set<string>>();
const hashStore = new Map<string, Record<string, string>>();

const mockMulti = () => {
    const ops: Array<() => any> = [];
    const self = {
        hSet: mock((key: string, fields: Record<string, string>) => {
            ops.push(() => {
                const existing = hashStore.get(key) ?? {};
                hashStore.set(key, { ...existing, ...fields });
                return hashStore.get(key);
            });
            return self;
        }),
        hGetAll: mock((key: string) => {
            ops.push(() => hashStore.get(key) ?? {});
            return self;
        }),
        sAdd: mock((key: string, ...members: string[]) => {
            ops.push(() => {
                const s = setStore.get(key) ?? new Set();
                for (const m of members.flat()) s.add(m);
                setStore.set(key, s);
                return s.size;
            });
            return self;
        }),
        sRem: mock((key: string, ...members: string[]) => {
            ops.push(() => {
                const s = setStore.get(key);
                if (s) for (const m of members.flat()) s.delete(m);
                return 1;
            });
            return self;
        }),
        expire: mock(() => {
            ops.push(() => 1);
            return self;
        }),
        del: mock((key: string) => {
            ops.push(() => {
                store.delete(key);
                hashStore.delete(key);
                return 1;
            });
            return self;
        }),
        exec: mock(async () => {
            return ops.map((op) => op());
        }),
    };
    return self;
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
        hashStore.delete(key);
    }),
    hGetAll: mock(async (key: string) => {
        return hashStore.get(key) ?? {};
    }),
    hGet: mock(async () => null),
    hSet: mock(async (key: string, field: string, value: string) => {
        const existing = hashStore.get(key) ?? {};
        existing[field] = value;
        hashStore.set(key, existing);
    }),
    incr: mock(async () => 1),
    exists: mock(async (key: string) => {
        return hashStore.has(key) ? 1 : 0;
    }),
};

function createFakeIo() {
    const nsCache = new Map<string, any>();
    const makeNs = (namespace: string) => {
        const rooms = new Map<string, Set<string>>();
        const emptyRoom = {
            emit: mock(() => {}),
            // Simulates no live sockets for the runner room — the sweep condition.
            fetchSockets: mock(async () => []),
        };
        return {
            emit: mock(() => {}),
            to: mock((room: string) => ({
                emit: mock(() => {}),
                fetchSockets: mock(async () => []),
            })),
            in: mock(() => emptyRoom),
            local: {
                emit: mock(() => {}),
                to: mock(() => ({ emit: mock(() => {}) })),
                in: mock(() => ({ emit: mock(() => {}), fetchSockets: mock(async () => []) })),
            },
            _rooms: rooms,
        };
    };
    return {
        of: mock((namespace: string) => {
            if (!nsCache.has(namespace)) nsCache.set(namespace, makeNs(namespace));
            return nsCache.get(namespace);
        }),
    };
}

afterAll(() => mock.restore());

describe("sweepOrphanedRunners secret revocation", () => {
    beforeEach(async () => {
        store.clear();
        setStore.clear();
        hashStore.clear();

        const { _resetRedisKvStoreForTesting, _injectRedisForTesting } = await import("../../redis-kv-store.js");
        _resetRedisKvStoreForTesting();
        _injectRedisForTesting(mockRedis as never);

        const { _resetRunnerSecretsForTesting, initSioRegistry } = await import("./context.js");
        _resetRunnerSecretsForTesting();
        initSioRegistry(createFakeIo() as any);

        const { initStateRedis } = await import("../sio-state/index.js");
        await initStateRedis(mockRedis as never);
    });

    test("orphaned runner secrets are revoked when a runner is swept (currently fails — runner secret outlives orphan sweep)", async () => {
        const { registerRunner } = await import("./runners.js");
        const { sweepOrphanedRunners } = await import("./runners.js");
        const { validateAndPersistRunnerSecret, getRunnerSecret } = await import("./context.js");

        const runnerId = "orphaned-runner";
        const runnerSecret = "orphaned-secret";
        const socket = { join: mock(async () => {}), data: {} } as any;

        // Register a runner and claim its persistent secret.
        const result = await registerRunner(socket, {
            name: "orphaned",
            roots: [],
            requestedRunnerId: runnerId,
            runnerSecret,
            skills: [],
            agents: [],
            plugins: [],
            hooks: [],
            version: null,
            platform: null,
            userId: "user-orphaned",
            userName: "Orphaned User",
        });
        expect(result).toBe(runnerId);
        expect(await getRunnerSecret(runnerId)).toBe(runnerSecret);

        // Simulate post-restart orphan sweep: no sockets are live.
        await sweepOrphanedRunners();

        // The runner state should be gone after sweeping.
        const { getRunnerData } = await import("./runners.js");
        expect(await getRunnerData(runnerId)).toBeNull();

        // SECURITY: the runner secret must also be revoked so a stale secret
        // cannot reclaim the runnerId after it has been pruned.
        const revalidate = await validateAndPersistRunnerSecret(runnerId, runnerSecret);
        expect(revalidate).not.toBe("match");
    });
});
