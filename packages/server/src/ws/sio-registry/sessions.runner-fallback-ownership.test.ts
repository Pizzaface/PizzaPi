/**
 * Regression repro: relay session registration falls back to the persisted
 * runner from SQLite even when the SQLite row carries no owner (anonymous
 * adoption left userId null).  The runner adoption path then trusts the
 * runnerId without re-checking user ownership, so a different user's runner
 * can be re-seeded into runnerSessionIds for the new session.
 *
 * Uses the same mock harness as sessions.ended-session-guard.test.ts.
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

// ── Store mock: simulate the SQLite divergence caused by anonymous adoption ───

const mockGetRelaySessionUserId = mock(async (_sessionId: string): Promise<string | null> => null);
const mockGetPersistedRelaySessionRunner = mock(
    async (_sessionId: string): Promise<{ runnerId: string | null; runnerName: string | null } | null> => null,
);

mock.module("../../sessions/store.js", () => ({
    getEphemeralTtlMs: () => 60_000,
    getRelaySessionUserId: mockGetRelaySessionUserId,
    getPersistedRelaySessionRunner: mockGetPersistedRelaySessionRunner,
    getPersistedRelaySessionSnapshot: async () => null,
    recordRelaySessionStart: async () => {},
    recordRelaySessionEnd: async () => {},
    recordRelaySessionState: async () => {},
    recordRelaySessionStateSerialized: async () => {},
    touchRelaySession: async () => {},
    updateRelaySessionRunner: async () => true,
}));

mock.module("../sio-state/index.js", () => ({
    initStateRedis: async () => {},
    setSession: async (sessionId: string, data: Record<string, unknown>) => {
        store.set(`__hash__:pizzapi:sio:session:${sessionId}`, JSON.stringify(data));
    },
    getSession: async (sessionId: string) => {
        const raw = store.get(`__hash__:pizzapi:sio:session:${sessionId}`);
        return raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
    },
    getSessionSummary: async (sessionId: string) => {
        const raw = store.get(`__hash__:pizzapi:sio:session:${sessionId}`);
        return raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
    },
    getSessionField: async () => null,
    updateSessionFields: async (sessionId: string, fields: Record<string, unknown>) => {
        const raw = store.get(`__hash__:pizzapi:sio:session:${sessionId}`);
        if (!raw) return;
        store.set(`__hash__:pizzapi:sio:session:${sessionId}`, JSON.stringify({ ...JSON.parse(raw), ...fields }));
    },
    deleteSession: async (sessionId: string) => {
        store.delete(`__hash__:pizzapi:sio:session:${sessionId}`);
    },
    getAllSessionSummaries: async () => {
        const sessions: Record<string, unknown>[] = [];
        for (const [key, value] of store.entries()) {
            if (key.startsWith("__hash__:pizzapi:sio:session:")) {
                sessions.push(JSON.parse(value));
            }
        }
        return sessions;
    },
    refreshSessionTTL: async () => {},
    incrementSeq: async () => 1,
    getSeq: async () => 0,
    setPendingRunnerLink: async () => {},
    getPendingRunnerLink: async () => null,
    deletePendingRunnerLink: async () => {},
    getRunnerAssociation: async () => null,
    setRunnerAssociation: async (sessionId: string, runnerId: string, runnerName: string | null) => {
        store.set(`pizzapi:sio:runner-assoc:${sessionId}`, JSON.stringify({ runnerId, runnerName }));
    },
    refreshRunnerAssociationTTL: async () => {},
    scanExpiredSessions: async () => [],
    addChildSession: async (parentSessionId: string, childSessionId: string) => {
        const s = setStore.get(`pizzapi:sio:children:${parentSessionId}`) ?? new Set();
        s.add(childSessionId);
        setStore.set(`pizzapi:sio:children:${parentSessionId}`, s);
    },
    addChildSessionMembership: async (parentSessionId: string, childSessionId: string) => {
        const s = setStore.get(`pizzapi:sio:children:${parentSessionId}`) ?? new Set();
        s.add(childSessionId);
        setStore.set(`pizzapi:sio:children:${parentSessionId}`, s);
    },
    removeChildSession: async (parentSessionId: string, childSessionId: string) => {
        setStore.get(`pizzapi:sio:children:${parentSessionId}`)?.delete(childSessionId);
    },
    isChildDelinked: async (childSessionId: string) => store.has(`pizzapi:sio:delinked:${childSessionId}`),
    clearParentSessionId: async (childSessionId: string) => {
        const raw = store.get(`__hash__:pizzapi:sio:session:${childSessionId}`);
        if (!raw) return;
        store.set(
            `__hash__:pizzapi:sio:session:${childSessionId}`,
            JSON.stringify({ ...JSON.parse(raw), parentSessionId: "", linkedParentId: "" }),
        );
    },
    refreshChildSessionsTTL: async () => {},
    removePendingParentDelinkChild: async () => {},
    markChildAsDelinked: async (childSessionId: string) => {
        store.set(`pizzapi:sio:delinked:${childSessionId}`, "1");
    },
    deleteRunnerAssociation: async () => {},
    getRunner: async () => null,
    setRunner: async () => {},
    updateRunnerFields: async () => {},
    deleteRunner: async () => {},
    getAllRunners: async () => [],
    refreshRunnerTTL: async () => {},
}));

mock.module("./hub.js", () => ({
    broadcastToHub: async () => {},
}));

afterAll(() => mock.restore());

const { initStateRedis } = await import("../sio-state.js");
const { registerTuiSession } = await import("./sessions.js");
const { initSioRegistry } = await import("./context.js");

const fakeNamespace = {
    to: () => ({ emit: () => {} }),
    local: { to: () => ({ emit: () => {} }) },
    in: () => ({ disconnectSockets: () => {} }),
    emit: () => {},
};
initSioRegistry({ of: () => fakeNamespace } as never);

function fakeSocket() {
    return { join: async () => {}, data: {}, connected: true } as never;
}

describe("registerTuiSession runner fallback — cross-user stale association", () => {
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

    it("assigns a stale runner from SQLite to a new user and the runner adoption path trusts runnerId", async () => {
        // Simulate the post-anonymous-adoption SQLite state: the row has no
        // owner (userId stayed null) but still carries the previous owner's
        // runner.  This is the Redis/SQLite ownership divergence left by
        // recordRelaySessionStart's onConflict, which preserves userId.
        mockGetRelaySessionUserId.mockImplementation(async (id) =>
            id === "stale-runner-session" ? null : null,
        );
        mockGetPersistedRelaySessionRunner.mockImplementation(async (id) =>
            id === "stale-runner-session"
                ? { runnerId: "runner-a", runnerName: "Runner A" }
                : null,
        );

        const socket = fakeSocket();
        const result = await registerTuiSession(socket, "/repo", {
            sessionId: "stale-runner-session",
            userId: "user-b",
            userName: "User B",
            isEphemeral: false,
        });

        // Because SQLite reports no owner, the requested session ID is kept.
        expect(result.sessionId).toBe("stale-runner-session");

        const hash = JSON.parse(
            store.get("__hash__:pizzapi:sio:session:stale-runner-session") ?? "{}",
        ) as Record<string, unknown>;

        // The new session is now tagged with the previous owner's runner.
        expect(hash.userId).toBe("user-b");
        expect(hash.runnerId).toBe("runner-a");

        // The runner adoption helper trusts runnerId without checking whether
        // the session's current user matches the runner's owner.  It therefore
        // lists user-b's session as belonging to user-a's runner.
        const { getConnectedSessionsForRunner } = await import("./runners.js");
        const adopted = await getConnectedSessionsForRunner("runner-a");
        expect(adopted.map((s) => s.sessionId)).toContain("stale-runner-session");
    });
});
