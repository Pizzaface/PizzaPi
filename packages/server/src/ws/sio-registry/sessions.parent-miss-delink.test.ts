import { afterAll, describe, it, expect, beforeEach, mock } from "bun:test";

// ── Minimal Redis mock (mirrors sio-state-children.test.ts) ─────────────────

const store = new Map<string, string>();
const setStore = new Map<string, Set<string>>();
const ttlStore = new Map<string, number>();

const mockMulti = () => {
    const ops: Array<() => unknown> = [];
    const multi = {
        hSet: mock((key: string, fieldsOrField: Record<string, string> | string, value?: string) => {
            ops.push(() => {
                const fields = typeof fieldsOrField === "string" ? { [fieldsOrField]: value ?? "" } : fieldsOrField;
                const existing = JSON.parse(store.get(`__hash__:${key}`) ?? "{}");
                Object.assign(existing, fields);
                store.set(`__hash__:${key}`, JSON.stringify(existing));
            });
            return multi;
        }),
        hGetAll: mock((key: string) => {
            ops.push(() => {
                const raw = store.get(`__hash__:${key}`);
                return raw ? (JSON.parse(raw) as Record<string, string>) : {};
            });
            return multi;
        }),
        sAdd: mock((key: string, ...members: string[]) => {
            ops.push(() => {
                const s = setStore.get(key) ?? new Set();
                for (const m of members.flat()) s.add(m);
                setStore.set(key, s);
            });
            return multi;
        }),
        sRem: mock((key: string, ...members: string[]) => {
            ops.push(() => {
                const s = setStore.get(key);
                if (s) for (const m of members.flat()) s.delete(m);
            });
            return multi;
        }),
        expire: mock((key: string, ttl: number) => {
            ops.push(() => ttlStore.set(key, ttl));
            return multi;
        }),
        del: mock((...keys: string[]) => {
            ops.push(() => {
                for (const key of keys) {
                    store.delete(key);
                    store.delete(`__hash__:${key}`);
                    setStore.delete(key);
                }
            });
            return multi;
        }),
        exec: mock(async () => ops.map((op) => op())),
    };
    return multi;
};

const listStore = new Map<string, string[]>();

const mockRedis = {
    isOpen: true,
    // List ops used by trigger-store.js (pushTriggerHistory).
    lPush: mock(async (key: string, value: string) => {
        const list = listStore.get(key) ?? [];
        list.unshift(value);
        listStore.set(key, list);
        return list.length;
    }),
    lTrim: mock(async (key: string, start: number, stop: number) => {
        const list = listStore.get(key);
        if (list) listStore.set(key, list.slice(start, stop + 1));
    }),
    lRange: mock(async (key: string, start: number, stop: number) => {
        const list = listStore.get(key) ?? [];
        return stop === -1 ? list.slice(start) : list.slice(start, stop + 1);
    }),
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
    set: mock(async (key: string, value: string, opts?: { NX?: boolean }) => {
        if (opts?.NX && store.has(key)) return null;
        store.set(key, value);
        return "OK";
    }),
    get: mock(async (key: string) => store.get(key) ?? null),
    del: mock(async (key: string) => {
        store.delete(key);
        setStore.delete(key);
        ttlStore.delete(key);
    }),
    exists: mock(async (key: string) => (store.has(key) || store.has(`__hash__:${key}`) ? 1 : 0)),
    hGetAll: mock(async (key: string) => {
        const raw = store.get(`__hash__:${key}`);
        return raw ? (JSON.parse(raw) as Record<string, string>) : {};
    }),
    hGet: mock(async (key: string, field: string) => {
        const raw = store.get(`__hash__:${key}`);
        return raw ? (JSON.parse(raw) as Record<string, string>)[field] ?? null : null;
    }),
    hSet: mock(async (key: string, field: string, value: string) => {
        const existing = JSON.parse(store.get(`__hash__:${key}`) ?? "{}");
        existing[field] = value;
        store.set(`__hash__:${key}`, JSON.stringify(existing));
        store.set(`${key}:${field}`, value);
    }),
    incr: mock(async () => 1),
    eval: mock(async (_script: string, opts: { keys: string[]; arguments: string[] }) => {
        if (opts.keys.length === 1) {
            const [key] = opts.keys;
            const [owner] = opts.arguments;
            if (store.get(key) !== owner) return 0;
            store.delete(key);
            return 1;
        }
        const [sessionKey, seqKey, allSessionsKey] = opts.keys;
        const [expectedToken, sessionId, userSessionsPrefix] = opts.arguments;
        const raw = store.get(`__hash__:${sessionKey}`);
        const hash = raw ? (JSON.parse(raw) as Record<string, string>) : {};
        if (hash.token !== expectedToken) return 0;
        store.delete(`__hash__:${sessionKey}`);
        store.delete(seqKey);
        setStore.get(allSessionsKey)?.delete(sessionId);
        if (hash.userId) setStore.get(`${userSessionsPrefix}${hash.userId}`)?.delete(sessionId);
        return 1;
    }),
};

// No mock.module for redis — mock client is injected directly via initStateRedis().

// Prevent this unit test from touching the real Redis-backed session state,
// SQLite-backed session store, or global Socket.IO hub registry. Those are
// covered by separate integration tests; here we only care about parent link
// resolution and related reconnect behavior.
const mockGetPersistedRelaySessionRunner = mock(
    async (_sessionId: string): Promise<{ runnerId: string | null; runnerName: string | null } | null> => null,
);
const mockGetRelaySessionUserId = mock(async (_sessionId: string): Promise<string | null> => null);
mock.module("../../sessions/store.js", () => ({
    getEphemeralTtlMs: () => 60_000,
    getPersistedRelaySessionRunner: mockGetPersistedRelaySessionRunner,
    getRelaySessionUserId: mockGetRelaySessionUserId,
    getPersistedRelaySessionSnapshot: async () => null,
    recordRelaySessionStart: async () => {},
    recordRelaySessionEnd: async () => {},
    recordRelaySessionState: async () => {},
    recordRelaySessionStateSerialized: async () => {},
    recordRelaySessionOverlay: async () => {},
    updateRelaySessionRunner: async () => {},
    updateRelaySessionName: async () => {},
    touchRelaySession: async () => {},
}));

// Durable trigger-record tenant probe (recycled-id guard): no foreign
// references in these parent-resolution scenarios.
mock.module("../../events/store.js", () => ({
    expireUndeliverable: async () => 0,
    deleteSessionRoutes: async () => [],
    listRoutes: async () => [],
    sessionReferencedByOtherTenant: async () => false,
}));

mock.module("./hub.js", () => ({
    broadcastToHub: async () => {},
}));


// Restore all module mocks after this file so they don't bleed into other
// test files running in the same worker process.
afterAll(() => {
    mock.restore();
    _resetTriggerStoreForTesting();
});

// Dynamic imports so that mock.module("../../sessions/store.js", …) is in place
// before sessions.js (and its transitive store.js dependency) is resolved.
// The redis mock has been removed — mockRedis is injected via initStateRedis() instead.
const { initStateRedis, markChildAsDelinked } = await import("../sio-state.js");
const { registerTuiSession } = await import("./sessions.js");
// registerTuiSession fire-and-forgets a `pushTriggerHistory()` call
// (sessions.ts) whenever a child links to a parent. That goes through
// trigger-store.js, a SEPARATE lazily-connecting Redis client from
// sio-state's. Without injecting it too, every test below that sets
// parentSessionId falls through to a real connect() attempt at
// redis://127.0.0.1:6379 -- writing a real `pizzapi:triggers:history:*` key
// into a developer's live Redis (or silently failing when none is listening).
const { _injectRedisForTesting: _injectTriggerStoreRedis, _resetRedisForTesting: _resetTriggerStoreForTesting } =
    await import("../../sessions/trigger-store.js");

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
        _injectTriggerStoreRedis(mockRedis);
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

    it("inherits the parent's runner association when the child has none (subagent mirror)", async () => {
        const socket = {
            join: async () => {},
            data: {},
        } as any;

        // Parent registered normally with a runner association.
        store.set(
            "__hash__:pizzapi:sio:session:parent-on-runner",
            JSON.stringify({
                sessionId: "parent-on-runner",
                userId: "u1",
                runnerId: "runner-1",
                runnerName: "My Runner",
            }),
        );

        await registerTuiSession(socket, "/repo", {
            sessionId: "subagent-child",
            userId: "u1",
            userName: "User",
            isEphemeral: true,
            parentSessionId: "parent-on-runner",
        });

        const sessionHash = JSON.parse(
            store.get("__hash__:pizzapi:sio:session:subagent-child") ?? "{}",
        ) as Record<string, string>;
        expect(sessionHash.runnerId).toBe("runner-1");
        expect(sessionHash.runnerName).toBe("My Runner");

        // Durable association persisted so it survives relay restarts.
        expect(JSON.parse(store.get("pizzapi:sio:runner-assoc:subagent-child") ?? "null")).toEqual({
            runnerId: "runner-1",
            runnerName: "My Runner",
        });
    });
});
