import { afterAll, describe, it, expect, mock, beforeEach } from "bun:test";

// ── In-memory Redis doubles ──────────────────────────────────────────────────
// Two separate clients are involved in the sweep path:
//   - sio-state client (runner hashes + indexes)  → injected via initStateRedis()
//   - redis-kv-store client (runner secrets)      → injected via _injectRedisForTesting()

const store = new Map<string, string>();
const setStore = new Map<string, Set<string>>();

const mockMulti = () => {
    const ops: Array<() => unknown> = [];
    const readHash = (key: string) => {
        const raw = store.get(`__hash__:${key}`);
        return raw ? (JSON.parse(raw) as Record<string, string>) : {};
    };
    return {
        hSet: mock((key: string, fields: Record<string, string>) => {
            ops.push(() => {
                const existing = readHash(key);
                Object.assign(existing, fields);
                store.set(`__hash__:${key}`, JSON.stringify(existing));
            });
            return mockMulti();
        }),
        hGetAll: mock((key: string) => {
            ops.push(() => readHash(key));
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
        exec: mock(async () => ops.map((op) => op())),
    };
};

const mockStateRedis = {
    isOpen: true,
    sMembers: mock(async (key: string) => Array.from(setStore.get(key) ?? [])),
    multi: mock(() => mockMulti()),
    on: mock(() => mockStateRedis),
    connect: mock(async () => {}),
    hGetAll: mock(async (key: string) => {
        const raw = store.get(`__hash__:${key}`);
        return raw ? (JSON.parse(raw) as Record<string, string>) : {};
    }),
    exists: mock(async (key: string) => (store.has(`__hash__:${key}`) ? 1 : 0)),
};

const mockKvRedis = {
    isOpen: true,
    get: mock((key: string) => Promise.resolve(store.get(key) ?? null)),
    set: mock((key: string, value: string) => {
        store.set(key, value);
        return Promise.resolve("OK");
    }),
    del: mock((key: string) => {
        store.delete(key);
        return Promise.resolve(1);
    }),
};

// Restore module mocks after this file so they don't bleed into other test
// files running in the same worker process.
afterAll(() => mock.restore());

// ── Fake Socket.IO server ────────────────────────────────────────────────────
// Room membership for the /runner namespace is driven directly by the
// `liveRunnerRooms` set so each test controls which runners look alive.
// `throwOnRooms` simulates an adapter failure for cluster-wide queries.

const liveRunnerRooms = new Set<string>();
const throwOnRooms = new Set<string>();
const emitCalls: Array<{ namespace: string; room?: string; event: string; data: unknown }> = [];

function createFakeIo() {
    const nsCache = new Map<string, any>();

    const makeNs = (namespace: string) => ({
        emit: (event: string, data: unknown) => emitCalls.push({ namespace, event, data }),
        to: (room: string) => ({
            emit: (event: string, data: unknown) => emitCalls.push({ namespace, room, event, data }),
        }),
        local: {
            emit: (event: string, data: unknown) => emitCalls.push({ namespace, event, data }),
            to: (room: string) => ({
                emit: (event: string, data: unknown) => emitCalls.push({ namespace, room, event, data }),
            }),
        },
        in: (room: string) => ({
            fetchSockets: async () => {
                if (throwOnRooms.has(room)) throw new Error("adapter unavailable");
                return liveRunnerRooms.has(room) ? [{}] : [];
            },
        }),
    });

    return {
        of: (namespace: string) => {
            if (!nsCache.has(namespace)) nsCache.set(namespace, makeNs(namespace));
            return nsCache.get(namespace);
        },
    };
}

mock.restore();

const { initSioRegistry, runnerSecrets, runnerRoom, getRunnerSecret, _resetRunnerSecretsForTesting } = await import("./context.js");
const { initStateRedis } = await import("../sio-state/index.js");
const { _injectRedisForTesting, _resetRedisKvStoreForTesting } = await import("../../redis-kv-store.js");
const { registerRunner, sweepOrphanedRunners, getRunnerData } = await import("./runners.js");

// ── Tests ────────────────────────────────────────────────────────────────────

async function registerWithSecret(runnerId: string, secret: string, userId: string) {
    const socket = { join: mock(async () => {}), data: {} } as any;
    const result = await registerRunner(socket, {
        name: runnerId,
        roots: [],
        requestedRunnerId: runnerId,
        runnerSecret: secret,
        skills: [],
        agents: [],
        plugins: [],
        hooks: [],
        version: null,
        platform: null,
        userId,
        userName: userId,
    });
    expect(result).toBe(runnerId);
}

describe("sweepOrphanedRunners secret revocation", () => {
    beforeEach(async () => {
        store.clear();
        setStore.clear();
        liveRunnerRooms.clear();
        throwOnRooms.clear();
        emitCalls.length = 0;
        _resetRunnerSecretsForTesting();
        initSioRegistry(createFakeIo() as any);
        _resetRedisKvStoreForTesting();
        _injectRedisForTesting(mockKvRedis);
        await initStateRedis(mockStateRedis as never);
    });

    it("deletes an orphaned runner's secret and state during the sweep", async () => {
        await registerWithSecret("orphan-runner", "orphan-secret", "user-orphan");
        expect(await getRunnerSecret("orphan-runner")).toBe("orphan-secret");
        expect(store.get("pizzapi:runner:secret:orphan-runner")).toBe("orphan-secret");

        // No live socket in the runner's room → swept as an orphan.
        await sweepOrphanedRunners();

        expect(runnerSecrets.has("orphan-runner")).toBe(false);
        expect(store.get("pizzapi:runner:secret:orphan-runner")).toBeUndefined();
        expect(await getRunnerData("orphan-runner")).toBeNull();

        const removed = emitCalls.find((c) => c.namespace === "/runners" && c.event === "runner_removed");
        expect(removed).toBeDefined();
        expect((removed!.data as any).runnerId).toBe("orphan-runner");
    });

    it("keeps a live runner's secret and state", async () => {
        await registerWithSecret("orphan-runner", "orphan-secret", "user-orphan");
        await registerWithSecret("live-runner", "live-secret", "user-live");
        liveRunnerRooms.add(runnerRoom("live-runner"));

        await sweepOrphanedRunners();

        // Orphan is fully revoked…
        expect(runnerSecrets.has("orphan-runner")).toBe(false);
        expect(store.get("pizzapi:runner:secret:orphan-runner")).toBeUndefined();
        expect(await getRunnerData("orphan-runner")).toBeNull();

        // …while the live runner is untouched.
        expect(await getRunnerSecret("live-runner")).toBe("live-secret");
        expect(store.get("pizzapi:runner:secret:live-runner")).toBe("live-secret");
        expect(await getRunnerData("live-runner")).not.toBeNull();

        const removedIds = emitCalls
            .filter((c) => c.event === "runner_removed")
            .map((c) => (c.data as any).runnerId);
        expect(removedIds).toEqual(["orphan-runner"]);
    });

    it("skips secret deletion when the cluster presence lookup fails", async () => {
        await registerWithSecret("uncertain-runner", "uncertain-secret", "user-uncertain");
        throwOnRooms.add(runnerRoom("uncertain-runner"));

        await sweepOrphanedRunners();

        // Lookup failure is not proof of death — nothing gets revoked.
        expect(await getRunnerSecret("uncertain-runner")).toBe("uncertain-secret");
        expect(await getRunnerData("uncertain-runner")).not.toBeNull();
        expect(emitCalls.find((c) => c.event === "runner_removed")).toBeUndefined();
    });
});
