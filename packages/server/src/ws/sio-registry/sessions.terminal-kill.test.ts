// ============================================================================
// sessions.terminal-kill.test.ts — Regression tests: a TRUE final session end
// (opts.killTerminals) must kill every terminal the session opened —
// cross-node safe, via emitToRunner — and remove its Redis entry immediately.
// `confirmedTerminal` alone (reload/new/resume/fork, `/remote reconnect`, and
// the orphan sweep) must NEVER kill terminals — only an explicit
// `killTerminals: true` (threaded from the CLI's session_end `final` flag, or
// TTL expiry) may. See GM VD0KKFpB (redesign: the server is now authoritative
// for the PTY kill; the UI only does local tab bookkeeping and never emits
// kill_terminal itself).
// ============================================================================

import { afterAll, describe, it, expect, beforeEach, mock } from "bun:test";
import { createSioStateRedisFixture } from "../../tests/fixtures/sio-state-redis.js";

const stateRedis = createSioStateRedisFixture();
const { store } = stateRedis;

mock.module("../../sessions/store.js", () => ({
    getEphemeralTtlMs: () => 60_000,
    getPersistedRelaySessionRunner: async () => null,
    getRelaySessionUserId: async () => null,
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

mock.module("../../events/store.js", () => ({
    expireUndeliverable: async () => 0,
    deleteSessionRoutes: async () => [],
    sessionReferencedByOtherTenant: async () => false,
}));

mock.module("../../events/reconcile.js", () => ({
    routeToSubscription: () => null,
}));

mock.module("./hub.js", () => ({
    broadcastToHub: async () => {},
}));

const { initStateRedis, setSession, setTerminal, getTerminal } = await import("../sio-state.js");
const { endSharedSession } = await import("./sessions.js");
const { initSioRegistry, runnerRoom } = await import("./context.js");
const { _injectRedisForTesting: _injectTriggerStoreRedis, _resetRedisForTesting: _resetTriggerStoreRedis } =
    await import("../../sessions/trigger-store.js");
const { _injectRedisForTesting: _injectRelayRedis, _resetRedisForTesting: _resetRelayRedis } =
    await import("../../sessions/redis.js");

afterAll(() => {
    mock.restore();
    _resetTriggerStoreRedis();
    _resetRelayRedis();
});

// Minimal fake Socket.IO server. Captures every room emit (viewer disconnect
// notifications, runner session_ended / kill_terminal) so tests can assert on
// exactly what was sent to which room.
const emitted: Array<{ room: string; event: string; payload: unknown }> = [];
const fakeNamespace = {
    to: (room: string) => ({
        emit: (event: string, payload: unknown) => { emitted.push({ room, event, payload }); },
    }),
    local: { to: (room: string) => ({ emit: (event: string, payload: unknown) => {
        emitted.push({ room, event, payload });
    } }) },
    in: () => ({ disconnectSockets: () => {} }),
    emit: () => {},
};
initSioRegistry({ of: () => fakeNamespace } as never);

function killTerminalEmits(runnerId: string) {
    return emitted.filter((e) => e.room === runnerRoom(runnerId) && e.event === "kill_terminal");
}

async function seedSession(sessionId: string, extra: Record<string, unknown> = {}) {
    await setSession(sessionId, {
        sessionId,
        userId: "u1",
        token: "t",
        startedAt: new Date().toISOString(),
        parentSessionId: null,
        linkedParentId: null,
        runnerId: "runner-1",
        ...extra,
    } as never);
}

async function seedTerminal(terminalId: string, sessionId: string | undefined, runnerId = "runner-1") {
    await setTerminal(terminalId, {
        terminalId,
        runnerId,
        userId: "u1",
        ...(sessionId ? { sessionId } : {}),
        spawned: true,
        exited: false,
        spawnOpts: "{}",
    } as never);
}

describe("endSharedSession — server-authoritative terminal kill on confirmed end", () => {
    beforeEach(async () => {
        stateRedis.reset();
        await initStateRedis(stateRedis.client as never);
        emitted.length = 0;
        _injectTriggerStoreRedis(stateRedis.client);
        _injectRelayRedis(stateRedis.client);
    });

    it("kills every terminal the session opened on a TRUE final end (killTerminals) and deletes its Redis entry", async () => {
        await seedSession("sess-a");
        await seedTerminal("term-1", "sess-a");
        await seedTerminal("term-2", "sess-a");

        await endSharedSession("sess-a", "Session ended", { confirmedTerminal: true, killTerminals: true });

        const kills = killTerminalEmits("runner-1");
        expect(kills.map((k) => (k.payload as { terminalId: string }).terminalId).sort()).toEqual([
            "term-1", "term-2",
        ]);
        for (const kill of kills) {
            expect(kill.payload).toMatchObject({ sessionId: "sess-a" });
        }
        // Redis entries are removed immediately (not left to leak until TTL if
        // the runner never sends terminal_exit back, e.g. it is offline).
        expect(await getTerminal("term-1")).toBeNull();
        expect(await getTerminal("term-2")).toBeNull();
    });

    it("does NOT kill terminals on a transient disconnect (no confirmedTerminal, no killTerminals)", async () => {
        await seedSession("sess-b");
        await seedTerminal("term-3", "sess-b");

        await endSharedSession("sess-b", "Session ended"); // no confirmedTerminal / killTerminals

        expect(killTerminalEmits("runner-1")).toEqual([]);
        expect(await getTerminal("term-3")).not.toBeNull();
    });

    it("does NOT kill terminals on confirmedTerminal alone (reload/new/resume/fork, /remote reconnect)", async () => {
        // This is the exact shape session_end sends when the CLI's `final` flag
        // is not set: confirmedTerminal still tears down routes/subscriptions,
        // but the same session id may re-register right after, so its PTYs
        // must survive.
        await seedSession("sess-reload");
        await seedTerminal("term-reload", "sess-reload");

        await endSharedSession("sess-reload", "Session ended", { confirmedTerminal: true });

        expect(killTerminalEmits("runner-1")).toEqual([]);
        expect(await getTerminal("term-reload")).not.toBeNull();
    });

    it("does NOT kill terminals from the orphan sweep (confirmedTerminal + preserveSubscriptions)", async () => {
        // Same opts shape sweepOrphanedSessions passes: the session may still
        // reconnect, so its terminals must never be killed from here.
        await seedSession("sess-orphan");
        await seedTerminal("term-orphan", "sess-orphan");

        await endSharedSession("sess-orphan", "Session orphaned (no active relay connection)", {
            confirmedTerminal: true,
            preserveSubscriptions: true,
        });

        expect(killTerminalEmits("runner-1")).toEqual([]);
        expect(await getTerminal("term-orphan")).not.toBeNull();
    });

    it("leaves other sessions' terminals on the same runner untouched", async () => {
        await seedSession("sess-c");
        await seedTerminal("term-4", "sess-c");
        await seedTerminal("term-other", "sess-other", "runner-1");

        await endSharedSession("sess-c", "Session ended", { confirmedTerminal: true, killTerminals: true });

        const kills = killTerminalEmits("runner-1");
        expect(kills.map((k) => (k.payload as { terminalId: string }).terminalId)).toEqual(["term-4"]);
    });

    it("does not kill terminals that were never tagged with a sessionId", async () => {
        await seedSession("sess-d");
        await seedTerminal("term-untagged", undefined);

        await endSharedSession("sess-d", "Session ended", { confirmedTerminal: true, killTerminals: true });

        expect(killTerminalEmits("runner-1")).toEqual([]);
    });

    it("does nothing when the session has no runnerId", async () => {
        await seedSession("sess-e", { runnerId: null });
        await seedTerminal("term-5", "sess-e");

        await endSharedSession("sess-e", "Session ended", { confirmedTerminal: true, killTerminals: true });

        expect(emitted.some((e) => e.event === "kill_terminal")).toBe(false);
        // sanity: the session row did get torn down (not a no-op from a bug elsewhere)
        expect(store.has("__hash__:pizzapi:sio:session:sess-e")).toBe(false);
    });
});
