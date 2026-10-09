// ============================================================================
// sessions.terminal-kill.test.ts — Regression tests: a CONFIRMED terminal
// session end (session_end, TTL expiry, orphan sweep) must kill every
// terminal the session opened — cross-node safe, via emitToRunner — while a
// transient disconnect/reconnect must leave them running. See GM VD0KKFpB
// (redesign: the server is now authoritative for the PTY kill; the UI only
// does local tab bookkeeping and never emits kill_terminal itself).
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

const { initStateRedis, setSession, setTerminal } = await import("../sio-state.js");
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

    it("kills every terminal the session opened on a CONFIRMED terminal end", async () => {
        await seedSession("sess-a");
        await seedTerminal("term-1", "sess-a");
        await seedTerminal("term-2", "sess-a");

        await endSharedSession("sess-a", "Session ended", { confirmedTerminal: true });

        const kills = killTerminalEmits("runner-1");
        expect(kills.map((k) => (k.payload as { terminalId: string }).terminalId).sort()).toEqual([
            "term-1", "term-2",
        ]);
        for (const kill of kills) {
            expect(kill.payload).toMatchObject({ sessionId: "sess-a" });
        }
    });

    it("does NOT kill terminals on a transient disconnect (not confirmed terminal)", async () => {
        await seedSession("sess-b");
        await seedTerminal("term-3", "sess-b");

        await endSharedSession("sess-b", "Session ended"); // no confirmedTerminal

        expect(killTerminalEmits("runner-1")).toEqual([]);
    });

    it("leaves other sessions' terminals on the same runner untouched", async () => {
        await seedSession("sess-c");
        await seedTerminal("term-4", "sess-c");
        await seedTerminal("term-other", "sess-other", "runner-1");

        await endSharedSession("sess-c", "Session ended", { confirmedTerminal: true });

        const kills = killTerminalEmits("runner-1");
        expect(kills.map((k) => (k.payload as { terminalId: string }).terminalId)).toEqual(["term-4"]);
    });

    it("does not kill terminals that were never tagged with a sessionId", async () => {
        await seedSession("sess-d");
        await seedTerminal("term-untagged", undefined);

        await endSharedSession("sess-d", "Session ended", { confirmedTerminal: true });

        expect(killTerminalEmits("runner-1")).toEqual([]);
    });

    it("does nothing when the session has no runnerId", async () => {
        await seedSession("sess-e", { runnerId: null });
        await seedTerminal("term-5", "sess-e");

        await endSharedSession("sess-e", "Session ended", { confirmedTerminal: true });

        expect(emitted.some((e) => e.event === "kill_terminal")).toBe(false);
        // sanity: the session row did get torn down (not a no-op from a bug elsewhere)
        expect(store.has("__hash__:pizzapi:sio:session:sess-e")).toBe(false);
    });
});
