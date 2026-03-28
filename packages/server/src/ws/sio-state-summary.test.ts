import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";

const hashStore = new Map<string, Record<string, string>>();
const setStore = new Map<string, Set<string>>();

const mockMulti = () => {
    const ops: Array<() => void> = [];
    const chain = {
        hSet: mock((key: string, fields: Record<string, string>) => {
            ops.push(() => {
                const current = hashStore.get(key) ?? {};
                hashStore.set(key, { ...current, ...fields });
            });
            return chain;
        }),
        expire: mock((_key: string, _ttl: number) => {
            ops.push(() => {});
            return chain;
        }),
        sAdd: mock((key: string, member: string) => {
            ops.push(() => {
                const current = setStore.get(key) ?? new Set<string>();
                current.add(member);
                setStore.set(key, current);
            });
            return chain;
        }),
        exec: mock(async () => {
            for (const op of ops) op();
            return [];
        }),
    };
    return chain;
};

const mockRedis = {
    isOpen: true,
    on: mock(() => mockRedis),
    connect: mock(async () => {}),
    multi: mock(() => mockMulti()),
    hGetAll: mock(async (key: string) => ({ ...(hashStore.get(key) ?? {}) })),
    hmGet: mock(async (key: string, fields: readonly string[]) => {
        const hash = hashStore.get(key) ?? {};
        return fields.map((f) => hash[f] ?? null);
    }),
    exists: mock(async (key: string) => (hashStore.has(key) ? 1 : 0)),
    get: mock(async () => null),
    set: mock(async () => "OK"),
    del: mock(async () => 1),
    sMembers: mock(async (key: string) => Array.from(setStore.get(key) ?? [])),
    sRem: mock(async (key: string, ...members: string[]) => {
        const current = setStore.get(key);
        if (!current) return;
        for (const member of members) current.delete(member);
    }),
    incr: mock(async () => 1),
    eval: mock(async () => 0),
};

mock.module("redis", () => ({
    createClient: () => mockRedis,
}));

afterAll(() => {
    mock.restore();
});

const { initStateRedis, setSession, getSessionSummary } = await import("./sio-state.js");

describe("getSessionSummary", () => {
    beforeEach(async () => {
        hashStore.clear();
        setStore.clear();
        mockRedis.hmGet.mockClear();
        mockRedis.hGetAll.mockClear();
        await initStateRedis();
    });

    it("uses hmGet fast path when available", async () => {
        const sessionId = "session-hmget";
        await setSession(sessionId, {
            sessionId,
            token: "tkn",
            collabMode: true,
            shareUrl: "http://localhost/session",
            cwd: "/tmp/project",
            startedAt: new Date().toISOString(),
            userId: "user-1",
            userName: "Jordan",
            sessionName: "Test Session",
            isEphemeral: false,
            expiresAt: null,
            isActive: true,
            lastHeartbeatAt: new Date().toISOString(),
            lastHeartbeat: JSON.stringify({ model: { provider: "anthropic", id: "haiku" } }),
            lastState: JSON.stringify({ messages: Array.from({ length: 1000 }, (_, i) => ({ i })) }),
            runnerId: "runner-1",
            runnerName: "Runner",
            seq: 42,
            parentSessionId: null,
        });

        const summary = await getSessionSummary(sessionId);

        expect(summary).not.toBeNull();
        expect(summary?.sessionId).toBe(sessionId);
        expect(summary?.userId).toBe("user-1");
        expect(summary?.runnerId).toBe("runner-1");
        expect(mockRedis.hmGet).toHaveBeenCalledTimes(1);
        expect(mockRedis.hGetAll).toHaveBeenCalledTimes(0);
    });

    it("falls back to hGetAll when hmGet is unavailable", async () => {
        const sessionId = "session-fallback";
        await setSession(sessionId, {
            sessionId,
            token: "tkn",
            collabMode: true,
            shareUrl: "http://localhost/session",
            cwd: "/tmp/project",
            startedAt: new Date().toISOString(),
            userId: "user-1",
            userName: "Jordan",
            sessionName: "Fallback Session",
            isEphemeral: false,
            expiresAt: null,
            isActive: true,
            lastHeartbeatAt: new Date().toISOString(),
            lastHeartbeat: null,
            lastState: JSON.stringify({ large: "x".repeat(10_000) }),
            runnerId: "runner-1",
            runnerName: "Runner",
            seq: 7,
            parentSessionId: null,
        });

        const originalHmGet = (mockRedis as any).hmGet;
        delete (mockRedis as any).hmGet;

        try {
            const summary = await getSessionSummary(sessionId);
            expect(summary).not.toBeNull();
            expect(summary?.sessionName).toBe("Fallback Session");
            expect(mockRedis.hGetAll).toHaveBeenCalledTimes(1);
        } finally {
            (mockRedis as any).hmGet = originalHmGet;
        }
    });
});
