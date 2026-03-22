import { describe, it, expect, mock, beforeEach } from "bun:test";

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
        exec: mock(async () => { for (const op of ops) op(); return []; }),
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
    set: mock(async (key: string, value: string) => { store.set(key, value); }),
    get: mock(async (key: string) => store.get(key) ?? null),
    del: mock(async (key: string) => {
        store.delete(key);
        store.delete(`__hash__:${key}`);
    }),
    hGetAll: mock(async (key: string) => {
        const raw = store.get(`__hash__:${key}`);
        return raw ? JSON.parse(raw) as Record<string, string> : {};
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

mock.module("redis", () => ({ createClient: () => mockRedis }));
mock.module("./hub.js", () => ({ broadcastToHub: mock(async () => {}) }));
mock.module("../../sessions/store.js", () => ({
    getEphemeralTtlMs: () => 60_000,
    updateRelaySessionRunner: mock(async () => {}),
}));

const broadcastCalls: Array<{ event: string; data: unknown; userId?: string }> = [];
mock.module("./runners-broadcast.js", () => ({
    broadcastToRunnersNs: mock(async (event: string, data: unknown, userId?: string) => {
        broadcastCalls.push({ event, data, userId });
    }),
}));

const { initStateRedis } = await import("../sio-state.js");
const { registerRunner, removeRunner, updateRunnerSkills, updateRunnerAgents, updateRunnerPlugins } = await import("./runners.js");

// Note: updateRunnerHooks not yet implemented — excluded intentionally.

describe("runners broadcast", () => {
    beforeEach(async () => {
        store.clear();
        setStore.clear();
        broadcastCalls.length = 0;
        await initStateRedis();
    });

    it("broadcasts runner_added when registerRunner succeeds", async () => {
        const socket = { join: mock(async () => {}), data: {} } as any;
        const result = await registerRunner(socket, {
            name: "my-runner",
            roots: ["/home/user/code"],
            requestedRunnerId: undefined,
            runnerSecret: undefined,
            skills: [],
            agents: [],
            plugins: [],
            hooks: [],
            version: "1.0.0",
            platform: "linux",
            userId: "user1",
            userName: "User One",
        });

        expect(result instanceof Error).toBe(false);
        const runnerId = result as string;

        const added = broadcastCalls.find(c => c.event === "runner_added");
        expect(added).toBeDefined();
        expect((added!.data as any).runnerId).toBe(runnerId);
        expect((added!.data as any).name).toBe("my-runner");
        expect(added!.userId).toBe("user1");
    });

    it("broadcasts runner_removed when removeRunner is called", async () => {
        const socket = { join: mock(async () => {}), data: {} } as any;
        const result = await registerRunner(socket, {
            name: "runner-to-remove",
            roots: [],
            requestedRunnerId: undefined,
            runnerSecret: undefined,
            skills: [],
            agents: [],
            plugins: [],
            hooks: [],
            version: null,
            platform: null,
            userId: "user2",
            userName: "User Two",
        });
        expect(result instanceof Error).toBe(false);
        const runnerId = result as string;
        broadcastCalls.length = 0;

        await removeRunner(runnerId);

        const removed = broadcastCalls.find(c => c.event === "runner_removed");
        expect(removed).toBeDefined();
        expect((removed!.data as any).runnerId).toBe(runnerId);
        expect(removed!.userId).toBe("user2");
    });

    it("broadcasts runner_updated after updateRunnerSkills", async () => {
        const socket = { join: mock(async () => {}), data: {} } as any;
        const result = await registerRunner(socket, {
            name: "skills-runner",
            roots: [],
            requestedRunnerId: undefined,
            runnerSecret: undefined,
            skills: [],
            agents: [],
            plugins: [],
            hooks: [],
            version: null,
            platform: null,
            userId: "user3",
            userName: "User Three",
        });
        expect(result instanceof Error).toBe(false);
        const runnerId = result as string;
        broadcastCalls.length = 0;

        await updateRunnerSkills(runnerId, [{ name: "my-skill", description: "does stuff", filePath: "/path/to/skill.md" }]);

        const updated = broadcastCalls.find(c => c.event === "runner_updated");
        expect(updated).toBeDefined();
        expect((updated!.data as any).runnerId).toBe(runnerId);
        const skills = (updated!.data as any).skills as Array<{ name: string }>;
        expect(skills.some(s => s.name === "my-skill")).toBe(true);
    });

    it("broadcasts runner_updated after updateRunnerAgents", async () => {
        const socket = { join: mock(async () => {}), data: {} } as any;
        const result = await registerRunner(socket, {
            name: "agents-runner",
            roots: [],
            requestedRunnerId: undefined,
            runnerSecret: undefined,
            skills: [],
            agents: [],
            plugins: [],
            hooks: [],
            version: null,
            platform: null,
            userId: "user4",
            userName: "User Four",
        });
        expect(result instanceof Error).toBe(false);
        const runnerId = result as string;
        broadcastCalls.length = 0;

        await updateRunnerAgents(runnerId, [{ name: "my-agent", description: "an agent", filePath: "/path/to/agent.md" }]);

        const updated = broadcastCalls.find(c => c.event === "runner_updated");
        expect(updated).toBeDefined();
        const agents = (updated!.data as any).agents as Array<{ name: string }>;
        expect(agents.some(a => a.name === "my-agent")).toBe(true);
    });

    it("broadcasts runner_updated after updateRunnerPlugins", async () => {
        const socket = { join: mock(async () => {}), data: {} } as any;
        const result = await registerRunner(socket, {
            name: "plugins-runner",
            roots: [],
            requestedRunnerId: undefined,
            runnerSecret: undefined,
            skills: [],
            agents: [],
            plugins: [],
            hooks: [],
            version: null,
            platform: null,
            userId: "user5",
            userName: "User Five",
        });
        expect(result instanceof Error).toBe(false);
        const runnerId = result as string;
        broadcastCalls.length = 0;

        await updateRunnerPlugins(runnerId, [{ name: "my-plugin", description: "a plugin", rootPath: "/path", commands: [], hookEvents: [], skills: [], hasMcp: false, hasAgents: false, hasLsp: false }]);

        const updated = broadcastCalls.find(c => c.event === "runner_updated");
        expect(updated).toBeDefined();
        const plugins = (updated!.data as any).plugins as Array<{ name: string }>;
        expect(plugins.some(p => p.name === "my-plugin")).toBe(true);
    });

    it("skips runner_removed broadcast gracefully when runner not in Redis", async () => {
        await removeRunner("ghost-runner");
        const removed = broadcastCalls.find(c => c.event === "runner_removed");
        expect(removed).toBeUndefined();
    });
});
