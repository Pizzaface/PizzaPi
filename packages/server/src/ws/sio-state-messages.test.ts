// ============================================================================
// sio-state-messages.test.ts — Split session message list (dual-write) tests
//
// Covers the bz-047 / Godmother 5lhFiLqR slice: `lastState` keeps the
// monolithic JSON blob, but the `messages` array inside it is ALSO mirrored
// into a separate Redis List so load_messages can LRANGE a page instead of
// JSON.parse'ing the whole blob. Readers must signal "list missing" so
// callers fall back to the monolithic lastState.
//
// Exercises the real production functions in ./sio-state.ts (not a
// reimplemented helper) via dependency-injected mock Redis client.
// ============================================================================

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

const hashStore = new Map<string, Record<string, string>>();
const setStore = new Map<string, Set<string>>();
const listStore = new Map<string, string[]>();

function keyExists(key: string): boolean {
    return hashStore.has(key) || listStore.has(key);
}

const mockMulti = () => {
    // Each queued op's closure both applies its side effect AND returns the
    // value real node-redis would return for that command, so exec() can
    // hand back a per-command results array — getSessionMessagesPage reads
    // its EXISTS/LLEN/LRANGE results positionally out of that array, just
    // like the real client.
    const ops: Array<() => unknown> = [];
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
        del: mock((...keys: string[]) => {
            ops.push(() => {
                for (const key of keys) {
                    hashStore.delete(key);
                    listStore.delete(key);
                }
            });
            return chain;
        }),
        sRem: mock((key: string, ...members: string[]) => {
            ops.push(() => {
                const current = setStore.get(key);
                if (!current) return;
                for (const member of members.flat()) current.delete(member);
            });
            return chain;
        }),
        rPush: mock((key: string, values: string[]) => {
            ops.push(() => {
                const current = listStore.get(key) ?? [];
                listStore.set(key, current.concat(values));
            });
            return chain;
        }),
        exists: mock((key: string) => {
            ops.push(() => (keyExists(key) ? 1 : 0));
            return chain;
        }),
        lLen: mock((key: string) => {
            ops.push(() => listStore.get(key)?.length ?? 0);
            return chain;
        }),
        lRange: mock((key: string, start: number, stop: number) => {
            ops.push(() => {
                const list = listStore.get(key) ?? [];
                const end = stop < 0 ? list.length + stop + 1 : stop + 1;
                return list.slice(start, end);
            });
            return chain;
        }),
        exec: mock(async () => ops.map((op) => op())),
    };
    return chain;
};

// When set, the NEXT top-level `exists(key)` check for this exact key
// answers truthfully based on the CURRENT state, then immediately deletes
// the key before returning — simulating an eviction/TTL expiry landing in
// the gap between a reader's own EXISTS check and its next command (e.g.
// LRANGE) on the SAME key. Used to reproduce the pre-fix two-round-trip
// race that getSessionMessagesPage's single MULTI/EXEC closes.
let raceDeleteAfterExistsFor: string | null = null;

const mockRedis = {
    isOpen: true,
    on: mock(() => mockRedis),
    connect: mock(async () => {}),
    quit: mock(async () => {}),
    multi: mock(() => mockMulti()),
    hGetAll: mock(async (key: string) => ({ ...(hashStore.get(key)) })),
    exists: mock(async (key: string) => {
        const result = keyExists(key) ? 1 : 0;
        if (raceDeleteAfterExistsFor === key) {
            raceDeleteAfterExistsFor = null;
            hashStore.delete(key);
            listStore.delete(key);
        }
        return result;
    }),
    get: mock(async () => null),
    set: mock(async () => "OK"),
    del: mock(async (key: string) => {
        const existed = keyExists(key);
        hashStore.delete(key);
        listStore.delete(key);
        return existed ? 1 : 0;
    }),
    sMembers: mock(async (key: string) => Array.from(setStore.get(key) ?? [])),
    sRem: mock(async (key: string, ...members: string[]) => {
        const current = setStore.get(key);
        if (!current) return;
        for (const member of members.flat()) current.delete(member);
    }),
    lLen: mock(async (key: string) => listStore.get(key)?.length ?? 0),
    lRange: mock(async (key: string, start: number, stop: number) => {
        const list = listStore.get(key) ?? [];
        const end = stop < 0 ? list.length + stop + 1 : stop + 1;
        return list.slice(start, end);
    }),
    eval: mock(async () => 0),
};

import {
    closeStateRedis,
    initStateRedis,
    setSession,
    getSession,
    deleteSession,
    setSessionMessagesList,
    updateSessionFieldsAndMessagesList,
    getSessionMessagesCount,
    getSessionMessagesRange,
    getSessionMessagesPage,
    deleteSessionMessagesList,
} from "./sio-state.js";

function fullSessionRecord(sessionId: string, lastState: string | null) {
    return {
        sessionId,
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
        lastState,
        runnerId: "runner-1",
        runnerName: "Runner",
        seq: 0,
        parentSessionId: null,
    };
}

describe("split session message list", () => {
    beforeEach(async () => {
        hashStore.clear();
        setStore.clear();
        listStore.clear();
        raceDeleteAfterExistsFor = null;
        await initStateRedis(mockRedis as never);
    });

    afterEach(async () => {
        await closeStateRedis();
    });

    it("signals no-list (null) when a session has never dual-written messages — callers must fall back to lastState", async () => {
        const count = await getSessionMessagesCount("session-never-written");
        expect(count).toBeNull();
        const range = await getSessionMessagesRange("session-never-written", 0, 5);
        expect(range).toBeNull();
    });

    it("dual-writes messages so a page can be read via LRANGE without parsing lastState", async () => {
        const sessionId = "session-split";
        const messages = Array.from({ length: 5 }, (_, i) => ({ id: i, text: `msg-${i}` }));

        await setSessionMessagesList(sessionId, messages);

        const count = await getSessionMessagesCount(sessionId);
        expect(count).toBe(5);

        // Mirrors the viewer.ts load_messages windowing: before=5, limit=2
        // → startIndex=3, endIndex=5 → messages[3..4].
        const page = await getSessionMessagesRange(sessionId, 3, 5);
        expect(page).toEqual([messages[3], messages[4]]);
    });

    it("a fresh snapshot with zero messages clears the list so readers re-fall-back instead of serving stale entries", async () => {
        const sessionId = "session-cleared";
        await setSessionMessagesList(sessionId, [{ id: 1 }, { id: 2 }]);
        expect(await getSessionMessagesCount(sessionId)).toBe(2);

        await setSessionMessagesList(sessionId, []);
        expect(await getSessionMessagesCount(sessionId)).toBeNull();
    });

    it("deleteSession also deletes the split message list (no orphaned Redis list on teardown)", async () => {
        const sessionId = "session-teardown";
        await setSession(sessionId, {
            sessionId,
            token: "tkn",
            collabMode: false,
            shareUrl: "http://localhost/session",
            cwd: "/tmp/project",
            startedAt: new Date().toISOString(),
            userId: "user-1",
            userName: "Jordan",
            sessionName: "Teardown Session",
            isEphemeral: false,
            expiresAt: null,
            isActive: true,
            lastHeartbeatAt: null,
            lastHeartbeat: null,
            lastState: JSON.stringify({ messages: [{ id: 1 }] }),
            runnerId: "runner-1",
            runnerName: "Runner",
            seq: 0,
            parentSessionId: null,
        });
        await setSessionMessagesList(sessionId, [{ id: 1 }]);
        expect(await getSessionMessagesCount(sessionId)).toBe(1);

        await deleteSession(sessionId);

        expect(await getSessionMessagesCount(sessionId)).toBeNull();
    });

    it("deleteSessionMessagesList removes the list directly", async () => {
        const sessionId = "session-direct-delete";
        await setSessionMessagesList(sessionId, [{ id: 1 }]);
        expect(await getSessionMessagesCount(sessionId)).toBe(1);

        await deleteSessionMessagesList(sessionId);

        expect(await getSessionMessagesCount(sessionId)).toBeNull();
    });

    // ── Regression: the list must never diverge from lastState ────────────
    //
    // The dual-write used to be two independent Redis round-trips: the
    // `lastState` hash write (updateSessionFields) and the split list write
    // (setSessionMessagesList, fire-and-forget). If the list write failed or
    // landed after a newer write, an older list would survive paired with a
    // newer lastState, and the load_messages fast path trusted any existing
    // list as fresh. updateSessionFieldsAndMessagesList closes that gap by
    // writing both halves in one Redis transaction.

    it("a transaction failure leaves the previous (lastState, list) pair fully intact — never updates one half only", async () => {
        const sessionId = "session-atomic-failure";
        await setSession(sessionId, fullSessionRecord(sessionId, JSON.stringify({ messages: [{ id: "v1" }] })));
        await updateSessionFieldsAndMessagesList(
            sessionId,
            { lastState: JSON.stringify({ messages: [{ id: "v1" }] }) },
            [{ id: "v1" }],
        );
        expect((await getSession(sessionId))?.lastState).toBe(JSON.stringify({ messages: [{ id: "v1" }] }));
        expect(await getSessionMessagesRange(sessionId, 0, 1)).toEqual([{ id: "v1" }]);

        // Simulate the next write's transaction failing outright (e.g. a
        // dropped connection) — EXEC never applies any of its queued
        // commands, so NEITHER half should move to the "v2" values.
        mockRedis.multi.mockImplementationOnce(() => {
            const chain = mockMulti();
            chain.exec = mock(async () => {
                throw new Error("simulated redis transaction failure");
            });
            return chain;
        });

        await expect(
            updateSessionFieldsAndMessagesList(
                sessionId,
                { lastState: JSON.stringify({ messages: [{ id: "v2" }] }) },
                [{ id: "v2" }],
            ),
        ).rejects.toThrow("simulated redis transaction failure");

        // The old pair must still be fully intact — not lastState=v2 paired
        // with the stale v1 list (the bug this fix closes), and not a v2
        // list paired with a stale v1 lastState either.
        expect((await getSession(sessionId))?.lastState).toBe(JSON.stringify({ messages: [{ id: "v1" }] }));
        expect(await getSessionMessagesRange(sessionId, 0, 1)).toEqual([{ id: "v1" }]);
    });

    it("clears the split list atomically with the lastState write when messages can't be serialized, instead of leaving it stale", async () => {
        const sessionId = "session-serialize-failure";
        await setSession(sessionId, fullSessionRecord(sessionId, JSON.stringify({ messages: [{ id: "old" }] })));
        await updateSessionFieldsAndMessagesList(
            sessionId,
            { lastState: JSON.stringify({ messages: [{ id: "old" }] }) },
            [{ id: "old" }],
        );
        expect(await getSessionMessagesCount(sessionId)).toBe(1);

        const circular: Record<string, unknown> = { id: "new" };
        circular.self = circular; // JSON.stringify throws on this

        await updateSessionFieldsAndMessagesList(
            sessionId,
            { lastState: JSON.stringify({ messages: ["unserializable"] }) },
            [circular],
        );

        // The lastState write must still land (never blocked by the list
        // failure)...
        expect((await getSession(sessionId))?.lastState).toBe(JSON.stringify({ messages: ["unserializable"] }));
        // ...but the list must be cleared, not left holding the old "old"
        // entry — a stale list paired with the new lastState is exactly the
        // bug this closes.
        expect(await getSessionMessagesCount(sessionId)).toBeNull();
    });

    it("getSessionMessagesRange falls back to null (not a null placeholder message) when an entry fails to parse", async () => {
        const sessionId = "session-corrupt-entry";
        await setSessionMessagesList(sessionId, [{ id: 1 }, { id: 2 }]);
        // Simulate corruption: inject a non-JSON entry directly into the
        // backing list store, bypassing setSessionMessagesList.
        const key = `pizzapi:sio:session-messages:${sessionId}`;
        const list = listStore.get(key) ?? [];
        list.splice(1, 0, "not-json{{{");
        listStore.set(key, list);

        const page = await getSessionMessagesRange(sessionId, 0, 3);
        expect(page).toBeNull();
    });

    // ── Regression: registration must invalidate the PREVIOUS generation's list ──
    //
    // setSession() always writes `lastState: null` on (re-)registration (see
    // sio-registry/sessions.ts: a fresh `generation` on every registration).
    // Before this fix, setSession() didn't touch the split list, so a session
    // restarting/reconnecting under the SAME sessionId would overwrite
    // lastState to null while load_messages kept serving the PREVIOUS
    // generation's list (a separate key with its own TTL that can easily
    // outlive the registration that just invalidated it).

    it("re-registration (setSession writing lastState: null) clears the previous generation's split list — no old page survives", async () => {
        const sessionId = "session-reregister";
        await setSession(sessionId, fullSessionRecord(sessionId, JSON.stringify({ messages: [{ id: "old-gen" }] })));
        await updateSessionFieldsAndMessagesList(
            sessionId,
            { lastState: JSON.stringify({ messages: [{ id: "old-gen" }] }) },
            [{ id: "old-gen" }],
        );
        expect(await getSessionMessagesRange(sessionId, 0, 1)).toEqual([{ id: "old-gen" }]);

        // Session re-registers under the SAME sessionId (restart/reconnect) —
        // the real registration flow always (re)writes lastState: null.
        await setSession(sessionId, fullSessionRecord(sessionId, null));

        const reregistered = await getSession(sessionId);
        expect(reregistered?.lastState).toBeNull();

        // The PREVIOUS generation's split list must be gone too — a reader
        // falling back must not find the old generation's messages via
        // either the direct helper or the atomic page reader.
        expect(await getSessionMessagesCount(sessionId)).toBeNull();
        expect(await getSessionMessagesRange(sessionId, 0, 1)).toBeNull();
        expect(await getSessionMessagesPage(sessionId, 1, 5)).toBeNull();
    });

    // ── Regression: an atomic read closes the exists-then-range race window ──
    //
    // getSessionMessagesRange() (and getSessionMessagesCount()) each do their
    // OWN "EXISTS, then act" pair of separate Redis round-trips. If the list
    // is deleted (TTL expiry, eviction, re-registration) in the gap between
    // a function's own EXISTS check and its next command on the SAME key,
    // that next command (LRANGE on a now-missing key) returns `[]` rather
    // than an error, so the caller can't tell "list is gone, fall back to
    // lastState" apart from "list is just empty" — load_messages would have
    // served a bogus empty page. getSessionMessagesPage() reads existence +
    // length + contents in ONE MULTI/EXEC, so there is no gap for a
    // concurrent deletion to land in.

    it("documents the bug: getSessionMessagesRange can return [] (not null) when the list is deleted between its own EXISTS check and its LRANGE call", async () => {
        const sessionId = "session-race-old-pattern";
        await setSessionMessagesList(sessionId, [{ id: 1 }, { id: 2 }]);

        // Simulate an eviction/TTL expiry landing in the gap between this
        // function's own EXISTS check and its subsequent LRANGE call.
        raceDeleteAfterExistsFor = `pizzapi:sio:session-messages:${sessionId}`;

        const range = await getSessionMessagesRange(sessionId, 0, 2);
        // BUG: an empty array, indistinguishable from "list exists but has no
        // messages in range" — the caller can't tell the list is actually gone.
        expect(range).toEqual([]);
    });

    it("getSessionMessagesPage returns null (not an empty page) once the list is gone — no two-call gap for a race to land in", async () => {
        const sessionId = "session-atomic-no-gap";
        await setSessionMessagesList(sessionId, [{ id: 1 }, { id: 2 }]);
        await deleteSessionMessagesList(sessionId);

        const page = await getSessionMessagesPage(sessionId, 2, 5);
        expect(page).toBeNull();
    });

    it("getSessionMessagesPage returns the correct windowed page and clamps a stale/out-of-range `before` cursor", async () => {
        const sessionId = "session-atomic-page";
        const messages = Array.from({ length: 5 }, (_, i) => ({ id: i, text: `msg-${i}` }));
        await setSessionMessagesList(sessionId, messages);

        // Normal window: before=5, limit=2 → startIndex=3, endIndex=5.
        const normal = await getSessionMessagesPage(sessionId, 5, 2);
        expect(normal).toEqual({ messages: [messages[3], messages[4]], length: 5, startIndex: 3, endIndex: 5 });

        // Stale client cursor (before exceeds the real length) must clamp to
        // the actual length instead of requesting a phantom out-of-range page.
        const stale = await getSessionMessagesPage(sessionId, 999, 2);
        expect(stale).toEqual({ messages: [messages[3], messages[4]], length: 5, startIndex: 3, endIndex: 5 });
    });
});
