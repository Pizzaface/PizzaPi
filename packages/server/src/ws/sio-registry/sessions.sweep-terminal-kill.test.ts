// ============================================================================
// sessions.sweep-terminal-kill.test.ts — Regression tests for the REAL sweep
// entry points (not endSharedSession called directly with the sweep's opts):
// sweepExpiredSessions (TTL path, killTerminals:true) must kill every
// terminal the expired session opened; sweepOrphanedSessions (no-heartbeat
// path, preserveSubscriptions, no killTerminals) must never kill terminals
// because the session may still reconnect. See GM VD0KKFpB.
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
    markRelaySessionSuspended: async () => {},
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
const { sweepExpiredSessions, sweepOrphanedSessions } = await import("./sessions.js");
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

// Minimal fake Socket.IO server. Captures every room emit (runner
// kill_terminal) and answers cluster presence lookups (fetchSockets) with
// "nobody connected" so sweepOrphanedSessions treats every candidate as a
// confirmed orphan.
const emitted: Array<{ room: string; event: string; payload: unknown }> = [];
const fakeNamespace = {
    to: (room: string) => ({
        emit: (event: string, payload: unknown) => { emitted.push({ room, event, payload }); },
    }),
    local: { to: (room: string) => ({ emit: (event: string, payload: unknown) => {
        emitted.push({ room, event, payload });
    } }) },
    in: () => ({
        disconnectSockets: () => {},
        fetchSockets: async () => [],
    }),
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

describe("sweepExpiredSessions / sweepOrphanedSessions — terminal kill via the real sweep entry points", () => {
    beforeEach(async () => {
        stateRedis.reset();
        await initStateRedis(stateRedis.client as never);
        emitted.length = 0;
        _injectTriggerStoreRedis(stateRedis.client);
        _injectRelayRedis(stateRedis.client);
    });

    it("sweepExpiredSessions kills every terminal of a TTL-expired session (killTerminals:true)", async () => {
        const now = Date.now();
        await seedSession("sess-expired", {
            expiresAt: new Date(now - 1_000).toISOString(), // already past expiry
        });
        await seedTerminal("term-exp-1", "sess-expired");
        await seedTerminal("term-exp-2", "sess-expired");

        await sweepExpiredSessions(now);

        const kills = killTerminalEmits("runner-1");
        expect(kills.map((k) => (k.payload as { terminalId: string }).terminalId).sort()).toEqual([
            "term-exp-1", "term-exp-2",
        ]);
        expect(await getTerminal("term-exp-1")).toBeNull();
        expect(await getTerminal("term-exp-2")).toBeNull();
        // Redis session record is gone too.
        expect(store.has("__hash__:pizzapi:sio:session:sess-expired")).toBe(false);
    });

    it("sweepOrphanedSessions does NOT kill terminals of a heartbeat-stale orphaned session", async () => {
        const now = Date.now();
        const staleHeartbeat = new Date(now - 10 * 60 * 1000).toISOString(); // 10m ago, well past HEARTBEAT_STALE_MS
        await seedSession("sess-orphaned", {
            startedAt: staleHeartbeat,
            lastHeartbeatAt: staleHeartbeat,
        });
        await seedTerminal("term-orph-1", "sess-orphaned");

        await sweepOrphanedSessions(now);

        expect(killTerminalEmits("runner-1")).toEqual([]);
        // Terminal survives: the session may still reconnect into this id.
        expect(await getTerminal("term-orph-1")).not.toBeNull();
        // But the stale session record itself is torn down.
        expect(store.has("__hash__:pizzapi:sio:session:sess-orphaned")).toBe(false);
    });
});
