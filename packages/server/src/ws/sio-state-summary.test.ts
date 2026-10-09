import { beforeEach, describe, expect, it, mock } from "bun:test";

const hashStore = new Map<string, Record<string, string>>();
const setStore = new Map<string, Set<string>>();
const stringStore = new Map<string, string>();

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
        set: mock((key: string, value: string) => {
            ops.push(() => {
                stringStore.set(key, value);
            });
            return chain;
        }),
        incr: mock((key: string) => {
            ops.push(() => {
                stringStore.set(key, String((parseInt(stringStore.get(key) ?? "0", 10) || 0) + 1));
            });
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
        sRem: mock((key: string, member: string) => {
            ops.push(() => {
                setStore.get(key)?.delete(member);
            });
            return chain;
        }),
        del: mock((key: string) => {
            ops.push(() => {
                hashStore.delete(key);
                stringStore.delete(key);
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
    hGetAll: mock(async (key: string) => ({ ...(hashStore.get(key)) })),
    hmGet: mock(async (key: string, fields: readonly string[]) => {
        const hash = hashStore.get(key) ?? {};
        return fields.map((f) => hash[f] ?? null);
    }),
    exists: mock(async (key: string) => (hashStore.has(key) ? 1 : 0)),
    hStrLen: mock(async (key: string, field: string) => {
        const hash = hashStore.get(key);
        return hash?.[field]?.length ?? 0;
    }),
    get: mock(async (key: string) => stringStore.get(key) ?? null),
    set: mock(async (key: string, value: string) => {
        stringStore.set(key, value);
        return "OK";
    }),
    del: mock(async () => 1),
    sMembers: mock(async (key: string) => Array.from(setStore.get(key) ?? [])),
    sRem: mock(async (key: string, ...members: string[]) => {
        const current = setStore.get(key);
        if (!current) return;
        for (const member of members) current.delete(member);
    }),
    incr: mock(async (key: string) => {
        const next = (parseInt(stringStore.get(key) ?? "0", 10) || 0) + 1;
        stringStore.set(key, String(next));
        return next;
    }),
    eval: mock(async (script: string, options: { keys: string[]; arguments: string[] }) => {
        // deleteSessionIfOwner's Lua script checks a 'token' field; claimTerminalSpawn's
        // checks 'spawned'. Branch on which script ran to keep one eval mock for both.
        if (script.includes("'token'")) {
            const [sessionKeyName, , allSessionsKeyName] = options.keys;
            const [expectedToken, sessionId, userSessionsPrefix] = options.arguments;
            const hash = hashStore.get(sessionKeyName);
            if (!hash || hash.token !== expectedToken) return 0;
            const userId = hash.userId;
            // Delete exactly whichever KEYS[n] the script's DEL call references, so a
            // regression that widens the Lua DEL (e.g. back to deleting the messages
            // version key) is caught instead of silently ignored by this mock.
            const delArgs = script.match(/redis\.call\('DEL',\s*([^)]+)\)/)?.[1]?.split(",") ?? [];
            for (const arg of delArgs) {
                const idx = Number(arg.match(/KEYS\[(\d+)\]/)?.[1]) - 1;
                const keyName = options.keys[idx];
                if (keyName) {
                    hashStore.delete(keyName);
                    stringStore.delete(keyName);
                }
            }
            setStore.get(allSessionsKeyName)?.delete(sessionId);
            if (userId) setStore.get(`${userSessionsPrefix}${userId}`)?.delete(sessionId);
            return 1;
        }
        const hash = hashStore.get(options.keys[0]);
        if (!hash || hash.spawned !== "0") return 0;
        hash.spawned = "1";
        return 1;
    }),
};

// No mock.module needed — mock Redis client is injected directly via initStateRedis().
import {
    claimTerminalSpawn,
    deleteSession,
    deleteSessionIfOwner,
    getMessagesVersion,
    getSessionSummary,
    initStateRedis,
    setSession,
    setTerminal,
    updateSessionFieldsAndBumpMessagesVersion,
} from "./sio-state.js";

describe("claimTerminalSpawn", () => {
    beforeEach(async () => {
        hashStore.clear();
        setStore.clear();
        stringStore.clear();
        mockRedis.eval.mockClear();
        await initStateRedis(mockRedis as never);
    });

    it("allows only one concurrent spawn claim", async () => {
        const terminalId = "terminal-race";
        await setTerminal(terminalId, {
            terminalId,
            runnerId: "runner-1",
            userId: "user-1",
            spawned: false,
            exited: false,
            spawnOpts: "{}",
        });

        const claims = await Promise.all([
            claimTerminalSpawn(terminalId),
            claimTerminalSpawn(terminalId),
        ]);

        expect(claims.filter(Boolean)).toHaveLength(1);
    });
});

describe("getSessionSummary", () => {
    beforeEach(async () => {
        hashStore.clear();
        setStore.clear();
        stringStore.clear();
        mockRedis.hmGet.mockClear();
        mockRedis.hGetAll.mockClear();
        await initStateRedis(mockRedis as never);
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

describe("messages version", () => {
    beforeEach(async () => {
        hashStore.clear();
        setStore.clear();
        stringStore.clear();
        await initStateRedis(mockRedis as never);
    });

    function baseSessionData(sessionId: string, lastState: string) {
        return {
            sessionId,
            token: "tkn",
            collabMode: true,
            shareUrl: "http://localhost/session",
            cwd: "/tmp/project",
            startedAt: new Date().toISOString(),
            userId: "user-1",
            userName: "Jordan",
            sessionName: "Version Session",
            isEphemeral: false,
            expiresAt: null,
            isActive: true,
            lastHeartbeatAt: new Date().toISOString(),
            lastHeartbeat: null,
            lastState,
            runnerId: "runner-1",
            runnerName: "Runner",
            seq: 0,
            parentSessionId: null,
        };
    }

    it("initializes, bumps, and reads the messages version token + lastState length", async () => {
        const sessionId = "session-version";
        const oldState = JSON.stringify({ messages: ["old"] });
        await setSession(sessionId, baseSessionData(sessionId, oldState));

        const initial = await getMessagesVersion(sessionId);
        expect(initial?.token).toBeTruthy();
        expect(initial?.lastStateLength).toBe(oldState.length);

        const newState = JSON.stringify({ messages: ["new"] });
        await updateSessionFieldsAndBumpMessagesVersion(sessionId, { lastState: newState });

        const updated = await getMessagesVersion(sessionId);
        expect(updated?.token).toBeTruthy();
        expect(updated?.token).not.toBe(initial?.token);
        expect(updated?.lastStateLength).toBe(newState.length);
        expect(hashStore.get("pizzapi:sio:session:session-version")?.lastState).toBe(newState);
    });

    it("changes the messages version token on every write across same-ID re-registration", async () => {
        const sessionId = "session-version-reregister";
        const data = baseSessionData(sessionId, JSON.stringify({ messages: ["gen1"] }));

        await setSession(sessionId, data);
        const afterRegister = await getMessagesVersion(sessionId);

        await updateSessionFieldsAndBumpMessagesVersion(sessionId, {
            lastState: JSON.stringify({ messages: ["gen1-v2"] }),
        });
        const afterUpdate = await getMessagesVersion(sessionId);
        expect(afterUpdate?.token).not.toBe(afterRegister?.token);

        await setSession(sessionId, { ...data, lastState: JSON.stringify({ messages: ["gen2"] }) });
        const afterReregister = await getMessagesVersion(sessionId);
        expect(afterReregister?.token).not.toBe(afterUpdate?.token);
        expect(afterReregister?.token).not.toBe(afterRegister?.token);
    });

    it("never reuses a prior generation's version token across deleteSession + re-registration", async () => {
        const sessionId = "session-version-delete-reregister";
        const data = baseSessionData(sessionId, JSON.stringify({ messages: ["gen1"] }));

        await setSession(sessionId, data);
        const beforeDelete = await getMessagesVersion(sessionId);
        expect(beforeDelete?.token).toBeTruthy();

        await deleteSession(sessionId);
        await setSession(sessionId, { ...data, lastState: JSON.stringify({ messages: ["gen2"] }) });

        const afterReregister = await getMessagesVersion(sessionId);
        expect(afterReregister?.token).toBeTruthy();
        expect(afterReregister?.token).not.toBe(beforeDelete?.token);
    });

    it("never reuses a prior generation's version token across deleteSessionIfOwner + re-registration", async () => {
        const sessionId = "session-version-delete-if-owner-reregister";
        const data = baseSessionData(sessionId, JSON.stringify({ messages: ["gen1"] }));

        await setSession(sessionId, data);
        const beforeDelete = await getMessagesVersion(sessionId);

        const deleted = await deleteSessionIfOwner(sessionId, "tkn");
        expect(deleted).toBe(true);

        await setSession(sessionId, { ...data, lastState: JSON.stringify({ messages: ["gen2"] }) });

        const afterReregister = await getMessagesVersion(sessionId);
        expect(afterReregister?.token).not.toBe(beforeDelete?.token);
    });

    it("never reproduces a prior generation's version token after the version key's own TTL expires and the session is re-registered (cross-generation collision regression)", async () => {
        // This is the exact hazard a monotonic INCR counter has: teardown does
        // not delete the version key (see messagesVersionKey doc comment), so
        // it survives on its own TTL. If that TTL eventually lapses (24h idle)
        // and the session is re-registered under the same ID, a counter that
        // restarts from 0 would reproduce the SAME small integer a peer node's
        // process-local cache is still keyed on for the PREVIOUS generation —
        // serving that peer the wrong generation's messages. A random token
        // can't collide with a prior generation's token this way.
        const sessionId = "session-version-ttl-expiry-reregister";
        const versionKeyName = `pizzapi:sio:messages-version:${sessionId}`;
        const data = baseSessionData(sessionId, JSON.stringify({ messages: ["gen1"] }));

        await setSession(sessionId, data); // 1st write of this generation
        await updateSessionFieldsAndBumpMessagesVersion(sessionId, {
            lastState: JSON.stringify({ messages: ["gen1-v2"] }),
        }); // 2nd write — this is the stamp a peer node's cache would hold
        const peerCachedToken = (await getMessagesVersion(sessionId))?.token;
        expect(peerCachedToken).toBeTruthy();

        // Teardown, then the version key's own TTL independently expires.
        await deleteSession(sessionId);
        stringStore.delete(versionKeyName);

        // Re-registration under the same ID, followed by its first snapshot —
        // the same two-write sequence that produced `peerCachedToken` above.
        await setSession(sessionId, { ...data, lastState: JSON.stringify({ messages: ["gen2"] }) });
        await updateSessionFieldsAndBumpMessagesVersion(sessionId, {
            lastState: JSON.stringify({ messages: ["gen2-v2"] }),
        });

        const newGenerationToken = (await getMessagesVersion(sessionId))?.token;
        expect(newGenerationToken).toBeTruthy();
        expect(newGenerationToken).not.toBe(peerCachedToken);
    });
});
