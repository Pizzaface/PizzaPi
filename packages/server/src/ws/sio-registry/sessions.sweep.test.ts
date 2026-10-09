// ============================================================================
// sessions.sweep.test.ts — Regression: sweepOrphanedSessions must reclaim a
// session whose localTuiSockets entry still exists but is already
// disconnected.
//
// Every early-return in the relay disconnect handler (recovery mark, Redis
// owner-lookup failure, stale owner, shutdown preserve) used to leave the
// dead socket in `localTuiSockets`. `sweepOrphanedSessions` skipped any
// session with a map entry via `.has()`, so those sessions were never swept
// — a slow memory leak and a permanently un-reclaimable "ghost" session on a
// long-lived node. The sweep must treat a present-but-disconnected socket as
// absent.
// ============================================================================

import { afterAll, describe, it, expect, beforeEach, mock } from "bun:test";

const noopAsync = async () => {};

let sessionSummaries: Array<{
    sessionId: string;
    lastHeartbeatAt: string | null;
    startedAt: string | null;
}> = [];
let sessionRecord: Record<string, unknown> | null = null;
const deletedSessionIds: string[] = [];

mock.module("../sio-state/index.js", () => ({
    setSession: noopAsync,
    getSession: async (sessionId: string) =>
        sessionRecord ? { ...sessionRecord, sessionId } : null,
    getSessionSummary: async () => null,
    getSessionField: async () => null,
    acquireSessionOwnershipLock: noopAsync,
    releaseSessionOwnershipLock: noopAsync,
    deleteSessionIfOwner: async () => true,
    updateSessionFields: noopAsync,
    deleteSession: async (sessionId: string) => {
        deletedSessionIds.push(sessionId);
    },
    getAllSessionSummaries: async () => sessionSummaries,
    refreshSessionTTL: noopAsync,
    incrementSeq: async () => 0,
    getSeq: async () => 0,
    setPendingRunnerLink: noopAsync,
    getPendingRunnerLink: async () => null,
    deletePendingRunnerLink: noopAsync,
    getRunnerAssociation: async () => null,
    setRunnerAssociation: noopAsync,
    refreshRunnerAssociationTTL: noopAsync,
    scanExpiredSessions: async () => [],
    addChildSession: noopAsync,
    addChildSessionMembership: noopAsync,
    removeChildSession: noopAsync,
    isChildDelinked: async () => false,
    clearParentSessionId: noopAsync,
    refreshChildSessionsTTL: noopAsync,
    removePendingParentDelinkChild: noopAsync,
    getRunner: async () => null,
    recordChildSpawnBinding: noopAsync,
    getChildSpawnBinding: async () => null,
    deleteChildSpawnBinding: noopAsync,
    setTerminal: noopAsync,
    getTerminal: async () => null,
    updateTerminalFields: noopAsync,
    claimTerminalSpawn: async () => true,
    deleteTerminal: noopAsync,
    getTerminalsForRunner: async () => [],
}));

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
    markRelaySessionSuspended: noopAsync,
}));

mock.module("../strip-images.js", () => ({
    storeAndReplaceImages: noopAsync,
    storeAndReplaceImagesInEvent: async (event: unknown) => event,
}));

mock.module("../stale-parent-link.js", () => ({ severStaleParentLink: noopAsync }));

afterAll(() => mock.restore());

const { sweepOrphanedSessions, localTuiSockets, initSioRegistry } = await import("./sessions.js").then(
    async (sessions) => {
        const context = await import("./context.js");
        return { ...sessions, ...context };
    },
);

// Fake Socket.IO server — no live sockets in any room, so every candidate's
// cluster presence check reports a confirmed zero. Also supports the few
// other namespace calls endSharedSession makes while tearing a session down
// (viewer broadcast + forced disconnect).
function createFakeIo() {
    const nsCache = new Map<string, unknown>();
    const makeNs = () => ({
        emit: () => {},
        to: () => ({ emit: () => {} }),
        local: { emit: () => {}, to: () => ({ emit: () => {} }) },
        in: () => ({
            fetchSockets: async () => [],
            disconnectSockets: () => {},
        }),
    });
    return {
        of: (name: string) => {
            if (!nsCache.has(name)) nsCache.set(name, makeNs());
            return nsCache.get(name);
        },
    };
}

describe("sweepOrphanedSessions — disconnected-but-present local sockets", () => {
    beforeEach(() => {
        localTuiSockets.clear();
        sessionSummaries = [];
        sessionRecord = { token: "tok", parentSessionId: null, generation: 0, userId: null, runnerId: null, lastState: null, snapshotOverlay: null };
        deletedSessionIds.length = 0;
        initSioRegistry(createFakeIo() as never);
    });

    it("sweeps a session whose local socket entry is present but disconnected", async () => {
        const staleIso = new Date(Date.now() - 10 * 60 * 1000).toISOString(); // 10 min ago
        sessionSummaries = [
            { sessionId: "sess-ghost", lastHeartbeatAt: staleIso, startedAt: staleIso },
        ];
        // The disconnect handler's early-return path (before this fix) left
        // this dead socket behind instead of removing it.
        localTuiSockets.set("sess-ghost", { connected: false, data: {} } as never);

        await sweepOrphanedSessions(Date.now());

        expect(deletedSessionIds).toContain("sess-ghost");
    });

    it("does NOT sweep a session with a live (connected) local socket", async () => {
        const staleIso = new Date(Date.now() - 10 * 60 * 1000).toISOString();
        sessionSummaries = [
            { sessionId: "sess-live", lastHeartbeatAt: staleIso, startedAt: staleIso },
        ];
        localTuiSockets.set("sess-live", { connected: true } as never);

        await sweepOrphanedSessions(Date.now());

        expect(deletedSessionIds).not.toContain("sess-live");
    });

    it("does NOT sweep a session with no local socket entry but a fresh heartbeat", async () => {
        sessionSummaries = [
            { sessionId: "sess-fresh", lastHeartbeatAt: new Date().toISOString(), startedAt: new Date().toISOString() },
        ];

        await sweepOrphanedSessions(Date.now());

        expect(deletedSessionIds).not.toContain("sess-fresh");
    });
});
