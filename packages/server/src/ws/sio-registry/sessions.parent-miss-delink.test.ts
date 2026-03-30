import { afterAll, describe, it, expect, beforeEach, mock } from "bun:test";

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

// No mock.module for redis — mock client is injected directly via initStateRedis().

// Prevent this unit test from touching the real SQLite-backed session store or
// the global Socket.IO hub registry. Those are covered by separate integration
// tests; here we only care about parent link resolution.
const mockGetPersistedRelaySessionRunner = mock(
    async (_sessionId: string): Promise<{ runnerId: string | null; runnerName: string | null } | null> => null,
);
const mockGetRelaySessionUserId = mock(async (_sessionId: string): Promise<string | null> => null);
mock.module("../../sessions/store.js", () => ({
    getEphemeralTtlMs: () => 60_000,
    getPersistedRelaySessionRunner: mockGetPersistedRelaySessionRunner,
    getRelaySessionUserId: mockGetRelaySessionUserId,
    recordRelaySessionStart: async () => {},
    recordRelaySessionEnd: async () => {},
    recordRelaySessionState: async () => {},
    touchRelaySession: async () => {},
}));

mock.module("./hub.js", () => ({
    broadcastToHub: async () => {},
}));

// Restore all module mocks after this file so they don't bleed into other
// test files running in the same worker process.
afterAll(() => mock.restore());

// Dynamic imports so that mock.module("../../sessions/store.js", …) is in place
// before sessions.js (and its transitive store.js dependency) is resolved.
// The redis mock has been removed — mockRedis is injected via initStateRedis() instead.
const { initStateRedis, markChildAsDelinked } = await import("../sio-state.js");
const { registerTuiSession } = await import("./sessions.js");

describe("registerTuiSession parent resolution", () => {
    beforeEach(async () => {
        store.clear();
        setStore.clear();
        ttlStore.clear();
        mockGetPersistedRelaySessionRunner.mockReset();
        mockGetPersistedRelaySessionRunner.mockImplementation(async () => null);
        mockGetRelaySessionUserId.mockReset();
        mockGetRelaySessionUserId.mockImplementation(async () => null);
        await initStateRedis(mockRedis as never);
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

    it("generates a fresh session ID when a live session belongs to a different user", async () => {
        const ownerSocket = {
            join: async () => {},
            data: {},
        } as any;
        const attackerSocket = {
            join: async () => {},
            data: {},
        } as any;

        const original = await registerTuiSession(ownerSocket, "/repo", {
            sessionId: "shared-session",
            userId: "owner",
            userName: "Owner",
            isEphemeral: false,
        });

        const takeoverAttempt = await registerTuiSession(attackerSocket, "/repo", {
            sessionId: "shared-session",
            userId: "attacker",
            userName: "Attacker",
            isEphemeral: false,
        });

        expect(takeoverAttempt.sessionId).not.toBe("shared-session");
        expect(takeoverAttempt.shareUrl.endsWith(`/${takeoverAttempt.sessionId}`)).toBe(true);
        expect(original.sessionId).toBe("shared-session");

        const originalSessionHash = JSON.parse(
            store.get("__hash__:pizzapi:sio:session:shared-session") ?? "{}",
        ) as Record<string, string>;
        const newSessionHash = JSON.parse(
            store.get(`__hash__:pizzapi:sio:session:${takeoverAttempt.sessionId}`) ?? "{}",
        ) as Record<string, string>;

        expect(originalSessionHash.userId).toBe("owner");
        expect(newSessionHash.userId).toBe("attacker");
    });

    it("generates a fresh session ID when SQLite ownership belongs to a different user", async () => {
        const socket = {
            join: async () => {},
            data: {},
        } as any;

        mockGetRelaySessionUserId.mockImplementation(async (sessionId: string) => {
            expect(sessionId).toBe("ended-session");
            return "owner";
        });

        const result = await registerTuiSession(socket, "/repo", {
            sessionId: "ended-session",
            userId: "attacker",
            userName: "Attacker",
            isEphemeral: false,
        });

        expect(result.sessionId).not.toBe("ended-session");
        expect(result.shareUrl.endsWith(`/${result.sessionId}`)).toBe(true);
        expect(store.get("__hash__:pizzapi:sio:session:ended-session")).toBeUndefined();

        const newSessionHash = JSON.parse(
            store.get(`__hash__:pizzapi:sio:session:${result.sessionId}`) ?? "{}",
        ) as Record<string, string>;
        expect(newSessionHash.userId).toBe("attacker");
    });

    it("restores runner association from persisted session data when Redis association is missing", async () => {
        const socket = {
            join: async () => {},
            data: {},
        } as any;

        mockGetPersistedRelaySessionRunner.mockImplementation(async (sessionId: string) => {
            expect(sessionId).toBe("session-with-persisted-runner");
            return { runnerId: "runner-persisted", runnerName: "Persisted Runner" };
        });

        await registerTuiSession(socket, "/repo", {
            sessionId: "session-with-persisted-runner",
            userId: "u1",
            userName: "User",
            isEphemeral: false,
        });

        const sessionHash = JSON.parse(
            store.get("__hash__:pizzapi:sio:session:session-with-persisted-runner") ?? "{}",
        ) as Record<string, string>;
        expect(sessionHash.runnerId).toBe("runner-persisted");
        expect(sessionHash.runnerName).toBe("Persisted Runner");

        const runnerAssoc = store.get("pizzapi:sio:runner-assoc:session-with-persisted-runner");
        expect(runnerAssoc).toBeDefined();
        expect(JSON.parse(runnerAssoc ?? "null")).toEqual({
            runnerId: "runner-persisted",
            runnerName: "Persisted Runner",
        });
    });
});
