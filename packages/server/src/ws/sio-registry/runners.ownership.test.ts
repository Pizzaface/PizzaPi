/**
 * Regression tests: getConnectedSessionsForRunner must NOT re-adopt sessions
 * owned by a different user (cross-user session/event leak on Redis-loss
 * fallback).
 *
 * Uses a mock Redis backend injected via initStateRedis() so the real
 * getRunnerState / getAllSessionSummaries / getConnectedSessionsForRunner
 * code paths run against controllable state.
 */
import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";

const store = new Map<string, string>();
const setStore = new Map<string, Set<string>>();

const mockMulti = () => {
    const ops: Array<() => void> = [];
    const readKeys: string[] = [];
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
        hGetAll: mock((key: string) => {
            readKeys.push(key);
            return mockMulti();
        }),
        exec: mock(async () => {
            for (const op of ops) op();
            return readKeys.map((key) => {
                const raw = store.get(`__hash__:${key}`);
                return raw ? (JSON.parse(raw) as Record<string, string>) : {};
            });
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
mock.module("./runners-broadcast.js", () => ({ broadcastToRunnersNs: mock(async () => {}) }));

afterAll(() => mock.restore());

const { initStateRedis } = await import("../sio-state/index.js");
const { setSession, setRunner } = await import("../sio-state/index.js");
const { localTuiSockets } = await import("./context.js");
const { getConnectedSessionsForRunner } = await import("./runners.js");

const USER_A = "user-alpha";
const USER_B = "user-bravo";

function seedRunner(runnerId: string, userId: string | null): void {
    void setRunner(runnerId, {
        runnerId,
        userId,
        userName: null,
        name: "runner",
        roots: "[]",
        skills: "[]",
        agents: "[]",
        plugins: "[]",
        hooks: "[]",
        version: null,
        platform: null,
    });
}

function seedSession(sessionId: string, userId: string | null, runnerId: string | null): void {
    void setSession(sessionId, {
        sessionId,
        token: "tok",
        collabMode: false,
        shareUrl: `http://test/${sessionId}`,
        cwd: "/repo",
        startedAt: new Date().toISOString(),
        userId,
        userName: null,
        sessionName: null,
        isEphemeral: false,
        expiresAt: null,
        isActive: true,
        lastHeartbeatAt: null,
        lastHeartbeat: null,
        lastState: null,
        runnerId,
        runnerName: null,
        seq: 0,
        parentSessionId: null,
        linkedParentId: null,
    });
}

function connectTui(sessionId: string): void {
    localTuiSockets.set(sessionId, { connected: true, data: {} } as never);
}

describe("getConnectedSessionsForRunner — ownership guard", () => {
    beforeEach(async () => {
        store.clear();
        setStore.clear();
        localTuiSockets.clear();
        await initStateRedis(mockRedis as never);
    });

    it("does not re-adopt a session owned by a different user", async () => {
        seedRunner("runner-b", USER_B);
        seedSession("s-foreign", USER_A, "runner-b");
        connectTui("s-foreign");

        const sessions = await getConnectedSessionsForRunner("runner-b");
        expect(sessions.map((s) => s.sessionId)).not.toContain("s-foreign");
    });

    it("re-adopts a session owned by the same user", async () => {
        seedRunner("runner-b", USER_B);
        seedSession("s-own", USER_B, "runner-b");
        connectTui("s-own");

        const sessions = await getConnectedSessionsForRunner("runner-b");
        expect(sessions.map((s) => s.sessionId)).toContain("s-own");
    });

    it("re-adopts an anonymous session (no owner)", async () => {
        seedRunner("runner-b", USER_B);
        seedSession("s-anon", null, "runner-b");
        connectTui("s-anon");

        const sessions = await getConnectedSessionsForRunner("runner-b");
        expect(sessions.map((s) => s.sessionId)).toContain("s-anon");
    });

    it("does not re-adopt a user-owned session when the runner is anonymous", async () => {
        seedRunner("runner-anon", null);
        seedSession("s-user", USER_A, "runner-anon");
        connectTui("s-user");

        const sessions = await getConnectedSessionsForRunner("runner-anon");
        expect(sessions.map((s) => s.sessionId)).not.toContain("s-user");
    });
});
