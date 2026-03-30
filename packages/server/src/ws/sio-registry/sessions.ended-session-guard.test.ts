/**
 * Regression tests: registerTuiSession generates a fresh session ID when the
 * requested session ID was previously owned by a *different* user in SQLite
 * (ended-session ID reuse vulnerability).
 *
 * Mirrors the mock infrastructure from sessions.parent-miss-delink.test.ts.
 */
import { afterAll, describe, it, expect, beforeEach, mock } from "bun:test";

// ── Minimal Redis mock ──────────────────────────────────────────────────────

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
    sMembers: mock(async (key: string) => Array.from(setStore.get(key) ?? [])),
    sRem: mock(async (key: string, ...members: string[]) => {
        const s = setStore.get(key);
        if (s) for (const m of members.flat()) s.delete(m);
    }),
    sIsMember: mock(async (key: string, member: string) => setStore.get(key)?.has(member) ?? false),
    expire: mock(async (key: string, ttl: number) => { ttlStore.set(key, ttl); }),
    multi: mock(() => mockMulti()),
    on: mock(() => mockRedis),
    connect: mock(async () => {}),
    set: mock(async (key: string, value: string, _opts?: unknown) => { store.set(key, value); }),
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

// ── Store mock — getRelaySessionUserId is controllable per test ─────────────

const mockGetRelaySessionUserId = mock(async (_sessionId: string): Promise<string | null> => null);
const mockGetPersistedRelaySessionRunner = mock(
    async (_sessionId: string): Promise<{ runnerId: string | null; runnerName: string | null } | null> => null,
);

mock.module("../../sessions/store.js", () => ({
    getEphemeralTtlMs: () => 60_000,
    getRelaySessionUserId: mockGetRelaySessionUserId,
    getPersistedRelaySessionRunner: mockGetPersistedRelaySessionRunner,
    recordRelaySessionStart: async () => {},
    recordRelaySessionEnd: async () => {},
    recordRelaySessionState: async () => {},
    touchRelaySession: async () => {},
}));

mock.module("./hub.js", () => ({
    broadcastToHub: async () => {},
}));

afterAll(() => mock.restore());

const { initStateRedis } = await import("../sio-state.js");
const { registerTuiSession } = await import("./sessions.js");

const makeSocket = () =>
    ({
        join: async () => {},
        data: {},
    }) as any;

describe("registerTuiSession — ended-session SQLite ownership guard", () => {
    beforeEach(async () => {
        store.clear();
        setStore.clear();
        ttlStore.clear();
        mockGetRelaySessionUserId.mockReset();
        mockGetRelaySessionUserId.mockImplementation(async () => null);
        mockGetPersistedRelaySessionRunner.mockReset();
        mockGetPersistedRelaySessionRunner.mockImplementation(async () => null);
        await initStateRedis(mockRedis as never);
    });

    it("preserves the requested session ID when no persisted row exists", async () => {
        const REQUESTED_ID = "00000000-0000-0000-0000-aabbccddeeff";
        mockGetRelaySessionUserId.mockImplementation(async () => null); // no row

        const result = await registerTuiSession(makeSocket(), "/cwd", {
            sessionId: REQUESTED_ID,
            userId: "user-b",
            userName: "User B",
            isEphemeral: false,
        });

        expect(result.sessionId).toBe(REQUESTED_ID);
    });

    it("preserves the requested session ID when the persisted row belongs to the same user", async () => {
        const REQUESTED_ID = "00000000-0000-0000-0000-sameuser1111";
        mockGetRelaySessionUserId.mockImplementation(async () => "user-a"); // same user

        const result = await registerTuiSession(makeSocket(), "/cwd", {
            sessionId: REQUESTED_ID,
            userId: "user-a",
            userName: "User A",
            isEphemeral: false,
        });

        expect(result.sessionId).toBe(REQUESTED_ID);
    });

    it("generates a new session ID when the persisted row belongs to a different user", async () => {
        const REQUESTED_ID = "00000000-0000-0000-0000-ended1234567";
        // The ended session was owned by user-a
        mockGetRelaySessionUserId.mockImplementation(async (id) => {
            if (id === REQUESTED_ID) return "user-a";
            return null;
        });

        const result = await registerTuiSession(makeSocket(), "/cwd", {
            sessionId: REQUESTED_ID,
            userId: "user-b", // different user
            userName: "User B",
            isEphemeral: false,
        });

        // Must NOT reuse the ended session ID
        expect(result.sessionId).not.toBe(REQUESTED_ID);
        // Must be a valid UUID
        expect(result.sessionId).toMatch(
            /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
        );
    });

    it("generates a new session ID when an anonymous user tries to reuse an owned ended session", async () => {
        const REQUESTED_ID = "00000000-0000-0000-0000-ownedanon111";
        // Ended session was owned by a real user
        mockGetRelaySessionUserId.mockImplementation(async (id) => {
            if (id === REQUESTED_ID) return "user-a";
            return null;
        });

        const result = await registerTuiSession(makeSocket(), "/cwd", {
            sessionId: REQUESTED_ID,
            userId: undefined, // anonymous
            isEphemeral: false,
        });

        expect(result.sessionId).not.toBe(REQUESTED_ID);
    });

    it("does not query SQLite when no session ID was requested (random UUID)", async () => {
        // No sessionId provided — a fresh UUID is always generated
        const result = await registerTuiSession(makeSocket(), "/cwd", {
            userId: "user-b",
            isEphemeral: false,
        });

        // getRelaySessionUserId should NOT have been called for a brand-new UUID
        // (the check only triggers when the client sent a specific requested ID)
        expect(mockGetRelaySessionUserId).not.toHaveBeenCalled();
        expect(result.sessionId).toMatch(
            /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
        );
    });
});
