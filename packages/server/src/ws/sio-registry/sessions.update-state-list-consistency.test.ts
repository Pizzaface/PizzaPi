// ============================================================================
// sessions.update-state-list-consistency.test.ts — Production-path coverage
// for the dual-write race (GM 5lhFiLqR round 2 review, finding #3).
//
// sio-state-messages.test.ts already proves updateSessionFieldsAndMessagesList()
// itself is atomic, but it calls that helper DIRECTLY — it can't catch a
// wiring regression where the real caller, updateSessionState() in
// sio-registry/sessions.ts, stops using the atomic helper (e.g. reverts to
// two separate writes). This file calls the REAL updateSessionState()
// against a dependency-injected mock Redis client backing the REAL
// sio-state.ts (not a reimplementation), so that kind of regression would
// be caught here even if the low-level helper tests still pass.
//
// Non-vacuousness was verified manually: temporarily reverting
// updateSessionState()'s dual-write call to the OLD decoupled pattern
// (`updateSessionFields()` then `setSessionMessagesList()` as two separate
// calls — both helpers remain exported) makes the second test below fail
// with lastState advancing to "v2" while the list stays stuck on "v1".
// Restored after confirming the failure.
// ============================================================================

import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

const noopAsync = async () => {};

mock.module("./meta.js", () => ({ extractMetaFromHeartbeat: () => ({}) }));
mock.module("./hub.js", () => ({ broadcastToHub: noopAsync }));
mock.module("../../sessions/store.js", () => ({
    getEphemeralTtlMs: () => 60_000,
    getPersistedRelaySessionRunner: async () => null,
    getRelaySessionUserId: async () => null,
    getPersistedRelaySessionSnapshot: async () => null,
    recordRelaySessionStart: noopAsync,
    recordRelaySessionEnd: noopAsync,
    recordRelaySessionState: noopAsync,
    recordRelaySessionStateSerialized: noopAsync,
    recordRelaySessionOverlay: noopAsync,
    touchRelaySession: noopAsync,
    updateRelaySessionName: noopAsync,
}));
mock.module("../strip-images.js", () => ({
    // Identity pass-through — updateSessionState's messages must survive
    // unchanged for these tests to observe them in the split list.
    storeAndReplaceImages: async (state: unknown) => state,
    storeAndReplaceImagesInEvent: async (event: unknown) => event,
}));
mock.module("../stale-parent-link.js", () => ({ severStaleParentLink: noopAsync }));

afterAll(() => mock.restore());

const { initStateRedis, closeStateRedis } = await import("../sio-state.js");
const { setSession, getSession, getSessionMessagesRange } = await import("../sio-state/index.js");
const { updateSessionState } = await import("./sessions.js");

// ── Minimal hash+list Redis mock (mirrors sio-state-messages.test.ts) ──────

const hashStore = new Map<string, Record<string, string>>();
const setStore = new Map<string, Set<string>>();
const listStore = new Map<string, string[]>();

function keyExists(key: string): boolean {
    return hashStore.has(key) || listStore.has(key);
}

/**
 * When set to a key, the NEXT multi batch that touches that key fails EXEC
 * entirely — simulating "the list write is delayed/failed" (e.g. a dropped
 * Redis connection mid-transaction never applies ANY of its queued
 * commands, atomic or not).
 */
let failNextBatchTouching: string | null = null;

const mockMulti = () => {
    const touchedKeys = new Set<string>();
    const ops: Array<() => void> = [];
    const chain = {
        hSet: mock((key: string, fields: Record<string, string>) => {
            touchedKeys.add(key);
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
        sAdd: mock((key: string, _member: string) => {
            ops.push(() => {
                const current = setStore.get(key) ?? new Set<string>();
                current.add(_member);
                setStore.set(key, current);
            });
            return chain;
        }),
        del: mock((...keys: string[]) => {
            for (const key of keys) touchedKeys.add(key);
            ops.push(() => {
                for (const key of keys) {
                    hashStore.delete(key);
                    listStore.delete(key);
                }
            });
            return chain;
        }),
        rPush: mock((key: string, values: string[]) => {
            touchedKeys.add(key);
            ops.push(() => {
                const current = listStore.get(key) ?? [];
                listStore.set(key, current.concat(values));
            });
            return chain;
        }),
        exec: mock(async () => {
            if (failNextBatchTouching && touchedKeys.has(failNextBatchTouching)) {
                failNextBatchTouching = null;
                throw new Error("simulated Redis connection drop mid-transaction");
            }
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
    quit: mock(async () => {}),
    multi: mock(() => mockMulti()),
    hGetAll: mock(async (key: string) => ({ ...hashStore.get(key) })),
    exists: mock(async (key: string) => (keyExists(key) ? 1 : 0)),
    get: mock(async () => null),
    set: mock(async () => "OK"),
    del: mock(async (key: string) => {
        const existed = keyExists(key);
        hashStore.delete(key);
        listStore.delete(key);
        return existed ? 1 : 0;
    }),
    sMembers: mock(async (key: string) => Array.from(setStore.get(key) ?? [])),
    lLen: mock(async (key: string) => listStore.get(key)?.length ?? 0),
    lRange: mock(async (key: string, start: number, stop: number) => {
        const list = listStore.get(key) ?? [];
        const end = stop < 0 ? list.length + stop + 1 : stop + 1;
        return list.slice(start, end);
    }),
    eval: mock(async () => 0),
};

const SESSION_ID = "session-update-state-prod";
const MESSAGES_KEY = `pizzapi:sio:session-messages:${SESSION_ID}`;

async function seedSession(): Promise<void> {
    await setSession(SESSION_ID, {
        sessionId: SESSION_ID,
        token: "tkn",
        collabMode: false,
        shareUrl: "http://localhost/session",
        cwd: "/tmp/project",
        startedAt: new Date().toISOString(),
        userId: "user-1",
        userName: "Jordan",
        sessionName: "Session",
        isEphemeral: false,
        expiresAt: null,
        isActive: true,
        lastHeartbeatAt: null,
        lastHeartbeat: null,
        lastState: null,
        runnerId: "runner-1",
        runnerName: "Runner",
        seq: 0,
        parentSessionId: null,
    } as never);
}

describe("updateSessionState — production-path list/lastState consistency (round 2 finding #3)", () => {
    beforeEach(async () => {
        hashStore.clear();
        setStore.clear();
        listStore.clear();
        failNextBatchTouching = null;
        await initStateRedis(mockRedis as never);
    });

    afterEach(async () => {
        await closeStateRedis();
    });

    it("a newer lastState write through the real caller never leaves an older generation's split list visible", async () => {
        await seedSession();

        await updateSessionState(SESSION_ID, { messages: [{ id: "v1" }] });
        expect(await getSessionMessagesRange(SESSION_ID, 0, 1)).toEqual([{ id: "v1" }]);

        await updateSessionState(SESSION_ID, { messages: [{ id: "v2" }] });

        const session = await getSession(SESSION_ID);
        expect(session?.lastState).toBe(JSON.stringify({ messages: [{ id: "v2" }] }));
        expect(await getSessionMessagesRange(SESSION_ID, 0, 1)).toEqual([{ id: "v2" }]);
    });

    it("when the list-write portion of the transaction fails, the previous (lastState, list) pair stays intact — never a newer lastState paired with the stale old list", async () => {
        await seedSession();
        await updateSessionState(SESSION_ID, { messages: [{ id: "v1" }] });
        expect((await getSession(SESSION_ID))?.lastState).toBe(JSON.stringify({ messages: [{ id: "v1" }] }));
        expect(await getSessionMessagesRange(SESSION_ID, 0, 1)).toEqual([{ id: "v1" }]);

        // Simulate "the list write is delayed/failed" (e.g. a dropped Redis
        // connection) while a NEWER lastState is being written.
        failNextBatchTouching = MESSAGES_KEY;
        await expect(updateSessionState(SESSION_ID, { messages: [{ id: "v2" }] })).rejects.toThrow(
            "simulated Redis connection drop mid-transaction",
        );

        // The pair from BEFORE the failed write must still be fully intact —
        // not lastState=v2 paired with the stale v1 list (the bug this round
        // of fixes closes). With the old decoupled implementation this fails:
        // the hash write lands (lastState becomes v2) before the separate
        // list write fails, leaving v2/v1 mismatched.
        expect((await getSession(SESSION_ID))?.lastState).toBe(JSON.stringify({ messages: [{ id: "v1" }] }));
        expect(await getSessionMessagesRange(SESSION_ID, 0, 1)).toEqual([{ id: "v1" }]);
    });
});
