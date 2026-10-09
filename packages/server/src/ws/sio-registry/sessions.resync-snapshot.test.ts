import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";

// sendSnapshotToViewer sends cached state to a reconnecting viewer on the
// resync path. Neither the cached heartbeat nor the cached session_active
// state is proof the runner producing them is still alive (a dead runner's
// Redis session hash survives until TTL) — the viewer's stale-watchdog
// backoff must not reset on either. See snapshot-provider.ts for the
// equivalent fix on the cold-cache fallback paths.

const sessions = new Map<string, Record<string, unknown>>();

const mockGetSession = mock(async (sessionId: string) => sessions.get(sessionId) ?? null);

const noopAsync = async () => {};

mock.module("../sio-state/index.js", () => ({
    acquireSessionOwnershipLock: noopAsync,
    releaseSessionOwnershipLock: noopAsync,
    deleteSessionIfOwner: async () => true,
    setSession: noopAsync,
    getSession: mockGetSession,
    getSessionSummary: mockGetSession,
    getSessionField: async () => null,
    updateSessionFields: noopAsync,
    deleteSession: noopAsync,
    getAllSessionSummaries: noopAsync,
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
    deleteChildSpawnBinding: noopAsync,
    // sessions.ts statically imports getTerminalsForSession from ./terminals.js
    // (server-authoritative terminal kill on confirmed session end), which in
    // turn imports these terminal CRUD helpers — unused by this test's
    // sendSnapshotToViewer scenarios, but Bun's mock.module replaces the
    // whole module's exports, so they must still exist or the static import
    // binding fails.
    setTerminal: noopAsync,
    getTerminal: async () => null,
    updateTerminalFields: noopAsync,
    claimTerminalSpawn: async () => false,
    deleteTerminal: noopAsync,
    getTerminalsForRunner: async () => [],
}));

mock.module("./meta.js", () => ({
    extractMetaFromHeartbeat: noopAsync,
}));

mock.module("./hub.js", () => ({
    broadcastToHub: noopAsync,
}));

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
}));

mock.module("../strip-images.js", () => ({
    storeAndReplaceImages: noopAsync,
    storeAndReplaceImagesInEvent: async (event: unknown) => event,
}));

mock.module("../stale-parent-link.js", () => ({
    severStaleParentLink: noopAsync,
}));

afterAll(() => mock.restore());

const { sendSnapshotToViewer } = await import("./sessions.js");

interface EmittedCall {
    event: string;
    payload: unknown;
}

function createMockSocket(): { emit: ReturnType<typeof mock>; calls: EmittedCall[] } {
    const calls: EmittedCall[] = [];
    const emit = mock((event: string, payload: unknown) => {
        calls.push({ event, payload });
        return true;
    });
    return { emit, calls } as unknown as { emit: ReturnType<typeof mock>; calls: EmittedCall[] };
}

describe("sendSnapshotToViewer", () => {
    beforeEach(() => {
        sessions.clear();
    });

    it("marks the cached heartbeat as liveness-only and the cached state as replay", async () => {
        sessions.set("s1", {
            sessionId: "s1",
            seq: 42,
            lastHeartbeat: JSON.stringify({ type: "heartbeat", active: true }),
            lastState: JSON.stringify({ type: "session_active", state: { messages: [] } }),
        });

        const socket = createMockSocket();
        await sendSnapshotToViewer("s1", socket as any);

        expect(socket.calls.length).toBe(2);

        const heartbeatPayload = socket.calls[0].payload as any;
        expect(heartbeatPayload.event._livenessOnly).toBe(true);

        const statePayload = socket.calls[1].payload as any;
        expect(statePayload.replay).toBe(true);
    });

    it("does nothing when the session is missing", async () => {
        const socket = createMockSocket();
        await sendSnapshotToViewer("missing", socket as any);
        expect(socket.calls.length).toBe(0);
    });
});
