/**
 * Regression tests for runner/session ownership reconciliation.
 *
 * Covers both:
 *   - registerRunner rejecting cross-user claims and anonymous-adoption edge cases.
 *   - getConnectedSessionsForRunner not re-adopting sessions owned by a different user
 *     (cross-user session/event leak on Redis-loss fallback).
 *
 * Uses a mock Redis backend injected via initStateRedis() so the real code paths run
 * against controllable state.
 */
import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";

// ── In-memory Redis mock (same harness as runners.broadcast.test.ts) ─────────

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

// Restore all module mocks after this file so they don't bleed into other
// test files running in the same worker process.
afterAll(() => mock.restore());

mock.restore();

// Registration consults the durable runner_owner store (fail-closed); back it
// with a disposable in-memory database.
const { installRunnerOwnerTestDb } = await import("../../../tests/fixtures/runner-owner-db.js");
const ownerDb = await installRunnerOwnerTestDb();

const { initStateRedis, setSession, setRunner } = await import("../sio-state/index.js");
const { initSioRegistry, runnerSecrets, localRunnerSockets, localTuiSockets } = await import("./context.js");
const { registerRunner, removeRunner, getRunnerData, getLocalRunnerSocket, getConnectedSessionsForRunner, RetryableRunnerRegistrationError } = await import("./runners.js");
const { getRunnerOwner, rememberRunnerOwner } = await import("../../runner-owner.js");
// The runner-secret path (validateAndPersistRunnerSecret -> getValue/setValue)
// goes through redis-kv-store.js, a SEPARATE lazily-connecting client from
// sio-state's. This suite registers runners with secrets in nearly every
// test (re-registration/ownership races); without injecting it too, every
// one of those registrations falls through to a real connect() attempt at
// redis://127.0.0.1:6379 -- writing real `pizzapi:runner:secret:*` keys into
// a developer's live Redis (or timing out when none is listening).
const { _injectRedisForTesting: _injectKvRedis, _resetRedisKvStoreForTesting } = await import("../../redis-kv-store.js");

function fakeSocket() {
    // getLocalRunnerSocket treats `.connected !== true` as absent (GM
    // oRG618iQ zombie-socket fix) — a freshly-registered real Socket.IO
    // socket is always `.connected === true`, so the fixture must match.
    return { join: mock(async () => {}), disconnect: mock(() => {}), data: {}, connected: true } as any;
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

describe("runner ownership guard", () => {
    // The secret path (redis-kv-store.js getValue/setValue) short-circuits to
    // a no-op when PIZZAPI_REDIS_URL=off, bypassing the injected mock entirely
    // regardless of _injectRedisForTesting(). Pin it to a harmless non-"off"
    // value for this suite so the assertions below are robust to ambient env
    // state left over from other tests/shells.
    const previousRedisUrl = process.env.PIZZAPI_REDIS_URL;

    beforeEach(async () => {
        process.env.PIZZAPI_REDIS_URL = "redis://mock-injected-for-testing";
        await ownerDb.reset();
        ownerDb.setBroken(false);
        store.clear();
        setStore.clear();
        runnerSecrets.clear();
        localRunnerSockets.clear();
        initSioRegistry(fakeIo());
        await initStateRedis(mockRedis as never);
        _resetRedisKvStoreForTesting();
        _injectKvRedis(mockRedis);
    });

    afterAll(() => {
        if (previousRedisUrl === undefined) {
            delete process.env.PIZZAPI_REDIS_URL;
        } else {
            process.env.PIZZAPI_REDIS_URL = previousRedisUrl;
        }
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
        // A genuine auth rejection, not an infra hiccup -- register_runner's
        // handler must hard-disconnect this one (no retry loop hammering).
        expect(result).not.toBeInstanceOf(RetryableRunnerRegistrationError);
    });

    it("fails closed (retryably) when Redis errors during a NEW runner's first secret claim, and a later retry registers once Redis recovers", async () => {
        // Regression for PR #965 round 2: registerRunner distinguishes a
        // transient Redis failure during the secret claim from a genuine
        // wrong-secret rejection, so the register_runner handler in
        // runner.ts doesn't permanently strand a legitimate runner behind a
        // server-initiated disconnect() when Redis briefly hiccups.
        const originalSet = mockRedis.set;
        let shouldFail = true;
        mockRedis.set = mock(async (key: string, value: string) => {
            if (shouldFail && key.startsWith("pizzapi:runner:secret:")) {
                throw new Error("ECONNRESET (simulated)");
            }
            return originalSet(key, value);
        });
        try {
            const result = await registerRunner(fakeSocket(), {
                ...baseOpts,
                requestedRunnerId: "runner-redis-down",
                runnerSecret: "s2",
                userId: USER_A,
            });
            expect(result).toBeInstanceOf(Error);
            expect(result).toBeInstanceOf(RetryableRunnerRegistrationError);
            expect((result as Error).message).toContain("could not verify identity");
            // Rejected cleanly -- no half-claimed secret or runner state left behind.
            expect(runnerSecrets.has("runner-redis-down")).toBe(false);
            expect(await getRunnerData("runner-redis-down")).toBeNull();

            // Redis recovers; the SAME runner retries registration (as a real
            // daemon would after its socket reconnects) and succeeds.
            shouldFail = false;
            const retry = await registerRunner(fakeSocket(), {
                ...baseOpts,
                requestedRunnerId: "runner-redis-down",
                runnerSecret: "s2",
                userId: USER_A,
            });
            expect(retry).toBe("runner-redis-down");
        } finally {
            mockRedis.set = originalSet;
        }
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

describe("runner ownership guard — offline runner (durable owner)", () => {
    beforeEach(async () => {
        store.clear();
        setStore.clear();
        runnerSecrets.clear();
        localRunnerSockets.clear();
        await ownerDb.reset();
        ownerDb.setBroken(false);
        initSioRegistry(fakeIo());
        await initStateRedis(mockRedis as never);
    });

    async function registerThenDisconnect(runnerId: string, secret: string, userId: string) {
        const result = await registerRunner(fakeSocket(), {
            ...baseOpts,
            requestedRunnerId: runnerId,
            runnerSecret: secret,
            userId,
        });
        expect(result).toBe(runnerId);
        // Normal disconnect: Redis state AND the runner secret are deleted.
        await removeRunner(runnerId);
        expect(await getRunnerData(runnerId)).toBeNull();
    }

    it("rejects a different user claiming an offline runner's ID, and the real runner can still reconnect", async () => {
        await registerThenDisconnect("runner-off", "secret-real", USER_A);

        const attackerSocket = fakeSocket();
        const result = await registerRunner(attackerSocket, {
            ...baseOpts,
            requestedRunnerId: "runner-off",
            runnerSecret: "attacker-chosen",
            userId: USER_B,
        });
        expect(result).toBeInstanceOf(Error);
        expect((result as Error).message).toContain("owned by a different user");
        expect(attackerSocket.join).not.toHaveBeenCalled();
        expect(await getRunnerData("runner-off")).toBeNull();
        // Durable owner untouched, attacker's secret never persisted.
        expect(await getRunnerOwner("runner-off")).toBe(USER_A);
        expect(runnerSecrets.has("runner-off")).toBe(false);

        // The legitimate runner reconnects with its original secret.
        const again = await registerRunner(fakeSocket(), {
            ...baseOpts,
            requestedRunnerId: "runner-off",
            runnerSecret: "secret-real",
            userId: USER_A,
        });
        expect(again).toBe("runner-off");
        expect((await getRunnerData("runner-off"))!.userId).toBe(USER_A);
    });

    it("rejects an anonymous registration of a durably-owned offline runner", async () => {
        await registerThenDisconnect("runner-off-anon", "s", USER_A);
        const result = await registerRunner(fakeSocket(), {
            ...baseOpts,
            requestedRunnerId: "runner-off-anon",
            runnerSecret: "s",
            userId: null,
        });
        expect(result).toBeInstanceOf(Error);
        expect(await getRunnerOwner("runner-off-anon")).toBe(USER_A);
    });

    it("fails closed when the durable owner store is unavailable, and the error is retryable (not a hard auth rejection)", async () => {
        ownerDb.setBroken(true);
        const result = await registerRunner(fakeSocket(), {
            ...baseOpts,
            requestedRunnerId: "runner-db-down",
            runnerSecret: "s",
            userId: USER_A,
        });
        ownerDb.setBroken(false);
        expect(result).toBeInstanceOf(Error);
        // Infra failure, not an auth mismatch -- register_runner's handler uses
        // this to avoid a server-initiated disconnect() that would strand a
        // legitimate runner (see RetryableRunnerRegistrationError's docs).
        expect(result).toBeInstanceOf(RetryableRunnerRegistrationError);
        expect((result as Error).message).toContain("could not be verified");
        expect(await getRunnerData("runner-db-down")).toBeNull();
        expect(runnerSecrets.has("runner-db-down")).toBe(false);
    });

    it("ordinary owner recording never overwrites an established durable owner", async () => {
        await registerThenDisconnect("runner-keep", "s", USER_A);
        await rememberRunnerOwner("runner-keep", USER_B);
        expect(await getRunnerOwner("runner-keep")).toBe(USER_A);
    });
});

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
