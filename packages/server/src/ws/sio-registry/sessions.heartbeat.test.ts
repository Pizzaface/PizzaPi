import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { createSioStateRedisFixture } from "../../tests/fixtures/sio-state-redis.js";

const stateRedis = createSioStateRedisFixture();
const noopAsync = async () => {};

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
    getPersistedRelaySessionSnapshot: async () => null,
    recordRelaySessionStart: noopAsync,
    recordRelaySessionEnd: noopAsync,
    recordRelaySessionState: noopAsync,
    recordRelaySessionStateSerialized: noopAsync,
    recordRelaySessionOverlay: noopAsync,
    updateRelaySessionRunner: noopAsync,
    updateRelaySessionName: noopAsync,
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

const { initStateRedis, setSession, getSessionSummary } = await import("../sio-state.js");
const { updateSessionHeartbeat } = await import("./sessions.js");

async function seedSession(sessionId: string, overrides: Record<string, unknown> = {}): Promise<void> {
    await setSession(sessionId, {
        sessionId,
        isActive: false,
        lastHeartbeatAt: null,
        lastHeartbeat: null,
        sessionName: "existing-session",
        isEphemeral: false,
        runnerId: null,
        userId: null,
        ...overrides,
    } as never);
}

describe("updateSessionHeartbeat", () => {
    beforeEach(async () => {
        stateRedis.reset();
        await initStateRedis(stateRedis.client as never);
        mockExtractMetaFromHeartbeat.mockReset();
        mockBroadcastToHub.mockReset();
    });

    it("skips meta extraction for slim heartbeats and only broadcasts on active transitions", async () => {
        await seedSession("s1", { sessionName: "persisted-name" });

        await updateSessionHeartbeat("s1", {
            _slim: true,
            active: false,
            sessionName: "ignored-from-heartbeat",
            model: { provider: "anthropic", id: "claude-3.5" },
            todoList: [{ id: "1", text: "task", status: "pending" }],
        });

        expect(mockExtractMetaFromHeartbeat).not.toHaveBeenCalled();
        expect(mockBroadcastToHub).not.toHaveBeenCalled();
        expect((await getSessionSummary("s1"))?.sessionName).toBe("persisted-name");
        expect((await getSessionSummary("s1"))?.lastHeartbeat).toBe(
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
        await seedSession("s2", { sessionName: "old-name" });

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
