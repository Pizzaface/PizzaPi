// ============================================================================
// sessions.suspend.test.ts — suspended sessions (idle worker exited, record
// kept): suspendSharedSession ownership + state, expiry exemption, and the
// wake re-registration that must not kick viewers or reset seq.
// Harness mirrors sessions.parent-transfer.test.ts.
// ============================================================================

import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";

const store = new Map<string, Record<string, unknown>>();
const ownerTokens = new Map<string, string>();
const calls = {
    updates: [] as Array<{ sessionId: string; fields: Record<string, unknown> }>,
    suspendedRows: [] as string[],
    ended: [] as string[],
    hub: [] as Array<{ event: string; data: Record<string, unknown> }>,
    disconnects: 0,
};

mock.module("../../sessions/store.js", () => ({
    getEphemeralTtlMs: () => 60_000,
    getPersistedRelaySessionRunner: async () => null,
    getRelaySessionUserId: async () => null,
    getPersistedRelaySessionSnapshot: async () => null,
    recordRelaySessionStart: async () => {},
    recordRelaySessionEnd: async (sessionId: string) => { calls.ended.push(sessionId); },
    recordRelaySessionState: async () => {},
    recordRelaySessionStateSerialized: async () => {},
    recordRelaySessionOverlay: async () => {},
    markRelaySessionSuspended: async (sessionId: string) => { calls.suspendedRows.push(sessionId); },
    touchRelaySession: async () => {},
}));
mock.module("../../sessions/trigger-store.js", () => ({ pushTriggerHistory: async () => {} }));
mock.module("../../events/store.js", () => ({
    expireUndeliverable: async () => 0,
    deleteSessionRoutes: async () => [],
    sessionReferencedByOtherTenant: async () => false,
}));
mock.module("../../events/reconcile.js", () => ({ routeToSubscription: () => null }));

mock.module("../sio-state/index.js", () => ({
    acquireSessionOwnershipLock: async () => {},
    releaseSessionOwnershipLock: async () => {},
    deleteSessionIfOwner: async (sessionId: string) => { store.delete(sessionId); return true; },
    initStateRedis: async () => {},
    setSession: async (sessionId: string, data: Record<string, unknown>) => { store.set(sessionId, { ...data }); },
    getSession: async (sessionId: string) => store.get(sessionId) ?? null,
    getSessionSummary: async (sessionId: string) => store.get(sessionId) ?? null,
    getSessionField: async (sessionId: string, field: string) =>
        field === "token" ? ownerTokens.get(sessionId) ?? null : null,
    updateSessionFields: async (sessionId: string, fields: Record<string, unknown>) => {
        calls.updates.push({ sessionId, fields });
        const s = store.get(sessionId);
        if (s) Object.assign(s, fields);
    },
    deleteSession: async (sessionId: string) => { store.delete(sessionId); },
    getAllSessionSummaries: async () => [...store.values()],
    refreshSessionTTL: async () => {},
    incrementSeq: async () => 1,
    getSeq: async () => 0,
    setPendingRunnerLink: async () => {},
    getPendingRunnerLink: async () => null,
    deletePendingRunnerLink: async () => {},
    getRunnerAssociation: async () => null,
    setRunnerAssociation: async () => {},
    refreshRunnerAssociationTTL: async () => {},
    scanExpiredSessions: async () => [],
    addChildSession: async () => {},
    addChildSessionMembership: async () => {},
    removeChildSession: async () => {},
    isChildDelinked: async () => false,
    clearParentSessionId: async () => {},
    refreshChildSessionsTTL: async () => {},
    removePendingParentDelinkChild: async () => {},
    getRunner: async () => null,
}));

mock.module("./hub.js", () => ({
    broadcastToHub: async (event: string, data: Record<string, unknown>) => { calls.hub.push({ event, data }); },
}));

afterAll(() => mock.restore());

const { registerTuiSession, suspendSharedSession, cancelSuspendedSession, touchSessionActivity, sweepOrphanedSessions } = await import("./sessions.js");
const { initSioRegistry, localTuiSockets } = await import("./context.js");

const fakeNamespace = {
    to: () => ({ emit: (event: string) => { if (event === "disconnected") calls.disconnects++; } }),
    local: { to: () => ({ emit: () => {} }) },
    name: "/relay",
    in: () => ({ disconnectSockets: () => {}, fetchSockets: async () => [] }),
    emit: () => {},
};
initSioRegistry({ of: () => fakeNamespace } as never);

function seed(sessionId: string, extra: Record<string, unknown> = {}) {
    store.set(sessionId, {
        sessionId,
        token: "tok",
        userId: "u1",
        cwd: "/w",
        startedAt: "2026-10-08T00:00:00.000Z",
        isEphemeral: true,
        expiresAt: "2026-10-08T00:10:00.000Z",
        isActive: false,
        lastHeartbeatAt: "2026-10-08T00:05:00.000Z",
        lastHeartbeat: null,
        sessionName: "child",
        runnerId: "r1",
        runnerName: "runner",
        parentSessionId: "parent-1",
        linkedParentId: "parent-1",
        seq: 42,
        ...extra,
    });
    ownerTokens.set(sessionId, "tok");
}

beforeEach(() => {
    store.clear();
    ownerTokens.clear();
    localTuiSockets.clear();
    calls.updates = [];
    calls.suspendedRows = [];
    calls.ended = [];
    calls.hub = [];
    calls.disconnects = 0;
});

describe("suspendSharedSession", () => {
    it("refuses a caller that no longer owns the session", async () => {
        seed("s1");
        expect(await suspendSharedSession("s1", "stale-token")).toBe(false);
        expect(calls.updates).toHaveLength(0);
        expect(store.get("s1")?.suspended).toBeUndefined();
    });

    it("keeps the record, marks it suspended without expiry, and tells the hub", async () => {
        seed("s1");
        localTuiSockets.set("s1", {} as never);
        expect(await suspendSharedSession("s1", "tok")).toBe(true);

        expect(store.get("s1")).toMatchObject({ suspended: true, isActive: false, expiresAt: null, parentSessionId: "parent-1" });
        expect(calls.suspendedRows).toEqual(["s1"]);
        expect(localTuiSockets.has("s1")).toBe(false);
        expect(calls.ended).toHaveLength(0);
        expect(calls.hub).toContainEqual(expect.objectContaining({
            event: "session_status",
            data: expect.objectContaining({ sessionId: "s1", suspended: true }),
        }));
    });
});

describe("cancelSuspendedSession", () => {
    it("refuses a caller that no longer owns the session", async () => {
        seed("s1", { suspended: true, expiresAt: null });
        const socket = {} as never;
        expect(await cancelSuspendedSession(socket, "s1", "stale-token")).toBe(false);
        expect(localTuiSockets.has("s1")).toBe(false);
    });

    it("refuses a session that isn't currently suspended (nothing to cancel)", async () => {
        seed("s1");
        const socket = {} as never;
        expect(await cancelSuspendedSession(socket, "s1", "tok")).toBe(false);
    });

    it("restores routing on the same socket — no new worker, nothing lost", async () => {
        seed("s1", { suspended: true, expiresAt: null });
        const socket = { id: "sock-1" } as never;

        expect(await cancelSuspendedSession(socket, "s1", "tok")).toBe(true);

        expect(store.get("s1")).toMatchObject({ suspended: false, parentSessionId: "parent-1" });
        expect(localTuiSockets.get("s1")).toBe(socket);
        expect(calls.hub).toContainEqual(expect.objectContaining({
            event: "session_status",
            data: expect.objectContaining({ sessionId: "s1", suspended: false }),
        }));
    });
});

describe("suspended session upkeep", () => {
    it("viewer activity does not re-arm the ephemeral expiry", async () => {
        seed("s1", { suspended: true, expiresAt: null });
        await touchSessionActivity("s1", { isEphemeral: true, runnerId: "r1", suspended: true });
        expect(calls.updates.filter((u) => "expiresAt" in u.fields)).toHaveLength(0);
    });

    it("the orphan sweep leaves socketless suspended sessions alone", async () => {
        seed("s1", { suspended: true, lastHeartbeatAt: "2020-01-01T00:00:00.000Z", startedAt: "2020-01-01T00:00:00.000Z" });
        await sweepOrphanedSessions(Date.now());
        expect(store.has("s1")).toBe(true);
        expect(calls.ended).toHaveLength(0);
    });
});

describe("waking a suspended session (re-registration)", () => {
    it("keeps viewers attached, preserves seq and the parent link, clears the flag", async () => {
        seed("parent-1", { parentSessionId: null, linkedParentId: null });
        seed("s1", { suspended: true, expiresAt: null });
        const socket = { join: async () => {}, data: {} } as never;

        const result = await registerTuiSession(socket, "/w", { sessionId: "s1", userId: "u1" });

        expect(result.sessionId).toBe("s1");
        expect(result.parentSessionId).toBe("parent-1");
        expect(calls.disconnects).toBe(0);
        expect(calls.ended).toHaveLength(0);
        expect(store.get("s1")?.seq).toBe(42);
        expect(store.get("s1")?.suspended).toBeFalsy();
    });

    it("a normal reconnect still resets seq and kicks viewers", async () => {
        seed("s1");
        const socket = { join: async () => {}, data: {} } as never;
        await registerTuiSession(socket, "/w", { sessionId: "s1", userId: "u1" });
        expect(calls.disconnects).toBe(1);
        expect(store.get("s1")?.seq).toBe(0);
    });
});
