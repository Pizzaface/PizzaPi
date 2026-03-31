import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";

const sessions = new Map<string, Record<string, unknown>>();

const mockGetSession = mock(async (sessionId: string) => sessions.get(sessionId) ?? null);
const mockUpdateSessionFields = mock(async (sessionId: string, fields: Record<string, unknown>) => {
    const existing = sessions.get(sessionId);
    if (!existing) return;
    sessions.set(sessionId, { ...existing, ...fields });
});
const mockRefreshRunnerAssociationTTL = mock(async () => {});

const noopAsync = async () => {};

mock.module("../sio-state/index.js", () => ({
    setSession: noopAsync,
    getSession: mockGetSession,
    getSessionSummary: noopAsync,
    updateSessionFields: mockUpdateSessionFields,
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
    refreshRunnerAssociationTTL: mockRefreshRunnerAssociationTTL,
    scanExpiredSessions: async () => [],
    addChildSession: noopAsync,
    addChildSessionMembership: noopAsync,
    removeChildSession: noopAsync,
    isChildDelinked: async () => false,
    clearParentSessionId: noopAsync,
    refreshChildSessionsTTL: noopAsync,
    removePendingParentDelinkChild: noopAsync,
    getRunner: async () => null,
}));

const mockExtractMetaFromHeartbeat = mock(async () => {});
mock.module("./meta.js", () => ({
    extractMetaFromHeartbeat: mockExtractMetaFromHeartbeat,
}));

const mockBroadcastToHub = mock(async () => {});
mock.module("./hub.js", () => ({
    broadcastToHub: mockBroadcastToHub,
}));

mock.module("../../sessions/store.js", () => ({
    getEphemeralTtlMs: () => 60_000,
    getPersistedRelaySessionRunner: async () => null,
    getRelaySessionUserId: async () => null,
    recordRelaySessionStart: noopAsync,
    recordRelaySessionEnd: noopAsync,
    recordRelaySessionState: noopAsync,
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

const { updateSessionHeartbeat } = await import("./sessions.js");

function seedSession(sessionId: string, overrides: Record<string, unknown> = {}): void {
    sessions.set(sessionId, {
        sessionId,
        isActive: false,
        lastHeartbeatAt: null,
        lastHeartbeat: null,
        sessionName: "existing-session",
        isEphemeral: false,
        runnerId: null,
        userId: null,
        ...overrides,
    });
}

describe("updateSessionHeartbeat", () => {
    beforeEach(() => {
        sessions.clear();
        mockGetSession.mockReset();
        mockGetSession.mockImplementation(async (sessionId: string) => sessions.get(sessionId) ?? null);
        mockUpdateSessionFields.mockReset();
        mockUpdateSessionFields.mockImplementation(async (sessionId: string, fields: Record<string, unknown>) => {
            const existing = sessions.get(sessionId);
            if (!existing) return;
            sessions.set(sessionId, { ...existing, ...fields });
        });
        mockRefreshRunnerAssociationTTL.mockReset();
        mockExtractMetaFromHeartbeat.mockReset();
        mockBroadcastToHub.mockReset();
    });

    it("skips meta extraction for slim heartbeats and only broadcasts on active transitions", async () => {
        seedSession("s1", { sessionName: "persisted-name" });

        await updateSessionHeartbeat("s1", {
            _slim: true,
            active: false,
            sessionName: "ignored-from-heartbeat",
            model: { provider: "anthropic", id: "claude-3.5" },
            todoList: [{ id: "1", text: "task", status: "pending" }],
        });

        expect(mockExtractMetaFromHeartbeat).not.toHaveBeenCalled();
        expect(mockBroadcastToHub).not.toHaveBeenCalled();
        expect(sessions.get("s1")?.sessionName).toBe("persisted-name");
        expect(sessions.get("s1")?.lastHeartbeat).toBe(
            JSON.stringify({
                _slim: true,
                active: false,
                sessionName: "ignored-from-heartbeat",
                model: { provider: "anthropic", id: "claude-3.5" },
                todoList: [{ id: "1", text: "task", status: "pending" }],
            }),
        );

        await updateSessionHeartbeat("s1", {
            _slim: true,
            active: false,
            sessionName: "still-ignored",
            model: { provider: "anthropic", id: "claude-3.7" },
        });

        expect(mockExtractMetaFromHeartbeat).not.toHaveBeenCalled();
        expect(mockBroadcastToHub).not.toHaveBeenCalled();

        await updateSessionHeartbeat("s1", {
            _slim: true,
            active: true,
        });

        expect(mockExtractMetaFromHeartbeat).not.toHaveBeenCalled();
        expect(mockBroadcastToHub).toHaveBeenCalledTimes(1);
        expect(mockBroadcastToHub).toHaveBeenCalledWith(
            "session_status",
            {
                sessionId: "s1",
                isActive: true,
                lastHeartbeatAt: expect.any(String),
                sessionName: "persisted-name",
                model: undefined,
            },
            undefined,
        );
    });

    it("extracts meta from fat heartbeats and keeps broadcasting structured changes", async () => {
        seedSession("s2", { sessionName: "old-name" });

        await updateSessionHeartbeat("s2", {
            active: false,
            sessionName: "new-name",
            model: { provider: "anthropic", id: "claude-3.5" },
            todoList: [{ id: "1", text: "task", status: "pending" }],
        });

        expect(mockExtractMetaFromHeartbeat).toHaveBeenCalledTimes(1);
        expect(mockBroadcastToHub).toHaveBeenCalledTimes(1);
        expect(mockBroadcastToHub).toHaveBeenLastCalledWith(
            "session_status",
            {
                sessionId: "s2",
                isActive: false,
                lastHeartbeatAt: expect.any(String),
                sessionName: "new-name",
                model: { provider: "anthropic", id: "claude-3.5" },
            },
            undefined,
        );

        await updateSessionHeartbeat("s2", {
            active: false,
            sessionName: "new-name-2",
            model: { provider: "anthropic", id: "claude-3.7" },
        });

        expect(mockExtractMetaFromHeartbeat).toHaveBeenCalledTimes(2);
        expect(mockBroadcastToHub).toHaveBeenCalledTimes(2);
        expect(mockBroadcastToHub).toHaveBeenLastCalledWith(
            "session_status",
            {
                sessionId: "s2",
                isActive: false,
                lastHeartbeatAt: expect.any(String),
                sessionName: "new-name-2",
                model: { provider: "anthropic", id: "claude-3.7" },
            },
            undefined,
        );
    });
});
