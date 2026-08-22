import { afterAll, describe, it, expect, mock, beforeEach } from "bun:test";

// ── In-memory Redis mock (same harness as runners.broadcast.test.ts) ─────────

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
    exists: mock(async (key: string) => (store.has(`__hash__:${key}`) ? 1 : 0)),
};

mock.module("./hub.js", () => ({ broadcastToHub: mock(async () => {}) }));

// Restore all module mocks after this file so they don't bleed into other
// test files running in the same worker process.
afterAll(() => mock.restore());

mock.restore();

const { initSioRegistry, runnerSecrets, localRunnerSockets } = await import("./context.js");
const { initStateRedis } = await import("../sio-state/index.js");
const { registerRunner, getRunnerData, getLocalRunnerSocket } = await import("./runners.js");

function fakeSocket() {
    return { join: mock(async () => {}), data: {} } as any;
}

function fakeIo() {
    return { of: () => ({ emit: () => {}, to: () => ({ emit: () => {} }), local: { emit: () => {}, to: () => ({ emit: () => {} }) } }) } as any;
}

const baseOpts = {
    roots: [],
    skills: [],
    agents: [],
    plugins: [],
    hooks: [],
    version: null,
    platform: null,
};

describe("runner ownership guard", () => {
    beforeEach(async () => {
        store.clear();
        setStore.clear();
        runnerSecrets.clear();
        localRunnerSockets.clear();
        initSioRegistry(fakeIo());
        await initStateRedis(mockRedis as never);
    });

    it("rejects re-registration with the correct secret by a DIFFERENT user", async () => {
        const socketA = fakeSocket();
        await registerRunner(socketA, {
            ...baseOpts,
            name: "alice-runner",
            requestedRunnerId: "runner-x",
            runnerSecret: "secret-x",
            userId: "user-a",
            userName: "Alice",
        });

        const socketB = fakeSocket();
        const result = await registerRunner(socketB, {
            ...baseOpts,
            name: "mallory-runner",
            requestedRunnerId: "runner-x",
            runnerSecret: "secret-x", // correct secret, wrong user
            userId: "user-b",
            userName: "Mallory",
        });

        expect(result).toBeInstanceOf(Error);
        expect((result as Error).message).toContain("owned by a different user");

        // Ownership and metadata are untouched — no hash write happened.
        const runner = await getRunnerData("runner-x");
        expect(runner).not.toBeNull();
        expect(runner!.userId).toBe("user-a");
        expect(runner!.userName).toBe("Alice");
        expect(runner!.name).toBe("alice-runner");

        // The local socket association still belongs to the original owner.
        expect(getLocalRunnerSocket("runner-x")).toBe(socketA);
        expect(socketB.join).not.toHaveBeenCalled();
    });

    it("allows same-owner re-registration with the correct secret", async () => {
        await registerRunner(fakeSocket(), {
            ...baseOpts,
            name: "alice-runner",
            requestedRunnerId: "runner-y",
            runnerSecret: "secret-y",
            userId: "user-a",
            userName: "Alice",
        });

        const socketA2 = fakeSocket();
        const result = await registerRunner(socketA2, {
            ...baseOpts,
            name: "alice-runner-renamed",
            requestedRunnerId: "runner-y",
            runnerSecret: "secret-y",
            userId: "user-a",
            userName: "Alice",
        });

        expect(result).toBe("runner-y");

        const runner = await getRunnerData("runner-y");
        expect(runner!.userId).toBe("user-a");
        expect(runner!.name).toBe("alice-runner-renamed");
        expect(getLocalRunnerSocket("runner-y")).toBe(socketA2);
    });

    it("still rejects a wrong secret regardless of user", async () => {
        await registerRunner(fakeSocket(), {
            ...baseOpts,
            requestedRunnerId: "runner-z",
            runnerSecret: "secret-z",
            userId: "user-a",
        });

        const result = await registerRunner(fakeSocket(), {
            ...baseOpts,
            requestedRunnerId: "runner-z",
            runnerSecret: "wrong",
            userId: "user-a",
        });

        expect(result).toBeInstanceOf(Error);
        expect((result as Error).message).toContain("secret mismatch");
    });

    it("allows re-registration when both registrations are unauthenticated (null owners)", async () => {
        await registerRunner(fakeSocket(), {
            ...baseOpts,
            requestedRunnerId: "runner-null",
            runnerSecret: "secret-n",
            userId: null,
        });

        const result = await registerRunner(fakeSocket(), {
            ...baseOpts,
            requestedRunnerId: "runner-null",
            runnerSecret: "secret-n",
            userId: null,
        });

        expect(result).toBe("runner-null");
    });

    it("rejects an authenticated claim over an anonymous-owned runner", async () => {
        await registerRunner(fakeSocket(), {
            ...baseOpts,
            requestedRunnerId: "runner-anon",
            runnerSecret: "secret-a",
            userId: null,
        });

        const result = await registerRunner(fakeSocket(), {
            ...baseOpts,
            requestedRunnerId: "runner-anon",
            runnerSecret: "secret-a",
            userId: "user-b",
        });

        expect(result).toBeInstanceOf(Error);
        const runner = await getRunnerData("runner-anon");
        expect(runner!.userId).toBeNull();
    });
});
