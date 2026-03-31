import { afterAll, describe, it, expect, mock, beforeEach } from "bun:test";

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

// No mock.module for redis — mock client is injected directly via initStateRedis().
mock.module("./hub.js", () => ({ broadcastToHub: mock(async () => {}) }));

// Restore all module mocks after this file so they don't bleed into other
// test files running in the same worker process.
afterAll(() => mock.restore());

// Instead of mocking ./runners-broadcast.js (which is brittle if another test
// imports it first), we provide a fake Socket.IO server via initSioRegistry()
// and assert on emitted events.

type EmitCall = {
    namespace: string;
    room?: string;
    event: string;
    data: unknown;
    local: boolean;
};

const emitCalls: EmitCall[] = [];

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

const { initSioRegistry, runnersUserRoom } = await import("./context.js");
const { initStateRedis } = await import("../sio-state/index.js");
const { registerRunner, removeRunner, updateRunnerSkills, updateRunnerAgents, updateRunnerPlugins, updateRunnerServices, getRunnerServices } =
    await import("./runners.js");

describe("runners broadcast", () => {
    beforeEach(async () => {
        store.clear();
        setStore.clear();
        emitCalls.length = 0;
        initSioRegistry(createFakeIo() as any);
        await initStateRedis(mockRedis as never);
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

        const added = emitCalls.find(
            (c) => c.namespace === "/runners" && c.room === runnersUserRoom("user1") && c.event === "runner_added",
        );
        expect(added).toBeDefined();
        expect((added!.data as any).runnerId).toBe(runnerId);
        expect((added!.data as any).name).toBe("my-runner");
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
        emitCalls.length = 0;

        await removeRunner(runnerId);

        const removed = emitCalls.find(
            (c) => c.namespace === "/runners" && c.room === runnersUserRoom("user2") && c.event === "runner_removed",
        );
        expect(removed).toBeDefined();
        expect((removed!.data as any).runnerId).toBe(runnerId);
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
        emitCalls.length = 0;

        await updateRunnerSkills(runnerId, [{ name: "my-skill", description: "does stuff", filePath: "/path/to/skill.md" }]);

        const updated = emitCalls.find(
            (c) => c.namespace === "/runners" && c.room === runnersUserRoom("user3") && c.event === "runner_updated",
        );
        expect(updated).toBeDefined();
        expect((updated!.data as any).runnerId).toBe(runnerId);
        const skills = (updated!.data as any).skills as Array<{ name: string }>;
        expect(skills.some((s) => s.name === "my-skill")).toBe(true);
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
        emitCalls.length = 0;

        await updateRunnerAgents(runnerId, [{ name: "my-agent", description: "an agent", filePath: "/path/to/agent.md" }]);

        const updated = emitCalls.find(
            (c) => c.namespace === "/runners" && c.room === runnersUserRoom("user4") && c.event === "runner_updated",
        );
        expect(updated).toBeDefined();
        const agents = (updated!.data as any).agents as Array<{ name: string }>;
        expect(agents.some((a) => a.name === "my-agent")).toBe(true);
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
        emitCalls.length = 0;

        await updateRunnerPlugins(runnerId, [
            {
                name: "my-plugin",
                description: "a plugin",
                rootPath: "/path",
                commands: [],
                hookEvents: [],
                skills: [],
                hasMcp: false,
                hasAgents: false,
                hasLsp: false,
            },
        ]);

        const updated = emitCalls.find(
            (c) => c.namespace === "/runners" && c.room === runnersUserRoom("user5") && c.event === "runner_updated",
        );
        expect(updated).toBeDefined();
        const plugins = (updated!.data as any).plugins as Array<{ name: string }>;
        expect(plugins.some((p) => p.name === "my-plugin")).toBe(true);
    });

    it("skips runner_removed broadcast gracefully when runner not in Redis", async () => {
        await removeRunner("ghost-runner");
        const removed = emitCalls.find((c) => c.event === "runner_removed");
        expect(removed).toBeUndefined();
    });

    it("persists and retrieves service announce data via updateRunnerServices/getRunnerServices", async () => {
        const socket = { join: mock(async () => {}), data: {} } as any;
        const result = await registerRunner(socket, {
            name: "services-runner",
            roots: [],
            skills: [],
            agents: [],
            plugins: [],
            hooks: [],
            version: "1.0.0",
            platform: "darwin",
            userId: "user6",
            userName: "User Six",
        });
        expect(result instanceof Error).toBe(false);
        const runnerId = result as string;

        // Initially no services
        const before = await getRunnerServices(runnerId);
        expect(before).toBeNull();

        // Persist service announce
        await updateRunnerServices(
            runnerId,
            ["terminal", "file-explorer", "git", "tunnel", "monitor"],
            [{ serviceId: "monitor", port: 9090, label: "System Monitor", icon: "activity" }],
        );

        const updated = emitCalls.find(
            (c) => c.namespace === "/runners" && c.room === runnersUserRoom("user6") && c.event === "runner_updated",
        );
        expect(updated).toBeDefined();
        expect((updated!.data as any).runnerId).toBe(runnerId);
        expect((updated!.data as any).serviceIds).toEqual(["terminal", "file-explorer", "git", "tunnel", "monitor"]);

        // Retrieve
        const after = await getRunnerServices(runnerId);
        expect(after).not.toBeNull();
        expect(after!.serviceIds).toEqual(["terminal", "file-explorer", "git", "tunnel", "monitor"]);
        expect(after!.panels).toHaveLength(1);
        expect(after!.panels![0].serviceId).toBe("monitor");
        expect(after!.panels![0].port).toBe(9090);
    });

    it("includes serviceIds and panels in runnerDataToInfo broadcast", async () => {
        const socket = { join: mock(async () => {}), data: {} } as any;
        const result = await registerRunner(socket, {
            name: "full-runner",
            roots: [],
            skills: [],
            agents: [],
            plugins: [],
            hooks: [],
            version: "2.0.0",
            platform: "linux",
            userId: "user7",
            userName: "User Seven",
        });
        expect(result instanceof Error).toBe(false);
        const runnerId = result as string;

        // Persist services then trigger a broadcast via updateRunnerSkills
        await updateRunnerServices(
            runnerId,
            ["terminal", "git"],
            [{ serviceId: "dashboard", port: 8080, label: "Dashboard", icon: "layout" }],
        );
        emitCalls.length = 0;

        await updateRunnerSkills(runnerId, [{ name: "test-skill", description: "test", filePath: "/path" }]);

        const updated = emitCalls.find(
            (c) => c.namespace === "/runners" && c.event === "runner_updated",
        );
        expect(updated).toBeDefined();
        const data = updated!.data as any;
        expect(data.serviceIds).toEqual(["terminal", "git"]);
        expect(data.panels).toHaveLength(1);
        expect(data.panels[0].serviceId).toBe("dashboard");
    });

    it("updateRunnerServices with no panels stores empty array", async () => {
        const socket = { join: mock(async () => {}), data: {} } as any;
        const result = await registerRunner(socket, {
            name: "no-panels-runner",
            roots: [],
            skills: [],
            agents: [],
            plugins: [],
            hooks: [],
            version: null,
            platform: null,
            userId: "user8",
            userName: "User Eight",
        });
        expect(result instanceof Error).toBe(false);
        const runnerId = result as string;

        await updateRunnerServices(runnerId, ["terminal", "git"]);

        const services = await getRunnerServices(runnerId);
        expect(services).not.toBeNull();
        expect(services!.serviceIds).toEqual(["terminal", "git"]);
        expect(services!.panels).toBeUndefined();
    });
});
