import { describe, expect, mock, test } from "bun:test";

const getSessionMessages = mock(async (_sessionId: string) => Array.from({ length: 10 }, (_, i) => ({ id: i })));
const getSharedSession = mock(async () => {
    throw new Error("load_messages must not fetch the full session hash");
});
const getLatestCachedSnapshotEvent = mock(async () => null as { event?: unknown } | null);

mock.module("../../auth.js", () => ({
    bindAuthContext: (_context: unknown, fn: unknown) => fn,
}));

mock.module("./auth.js", () => ({
    browserAuthMiddleware: () => (_socket: unknown, next: () => void) => next(),
}));

mock.module("./context.js", () => ({
    bindSocketHandlersToAuthContext: () => {},
}));

mock.module("./runner.js", () => ({ getRunnerServiceAnnounce: () => null }));
mock.module("./runner-ref.js", () => ({ withRunnerRefHint: <T>(value: T) => value }));
mock.module("./relay/index.js", () => ({ getPendingChunkedSnapshot: async () => null }));
mock.module("../../sessions/redis.js", () => ({ getLatestCachedSnapshotEvent }));
mock.module("../../sessions/store.js", () => ({ getPersistedRelaySessionSnapshot: async () => null }));
mock.module("../../sessions/trigger-store.js", () => ({ recordTriggerResponse: async () => {} }));
mock.module("../../user-hidden-models.js", () => ({ getHiddenModels: async () => [] }));
mock.module("../../routes/model-guard.js", () => ({ isHiddenModel: () => false }));
mock.module("../sio-state/index.js", () => ({ isChildOfParent: async () => false }));
mock.module("./viewer-cache.js", () => ({
    hydrateViewerFromCache: async () => false,
    sendCachedDeltaReplayEvents: async () => ({ sent: 0, latestSeq: undefined }),
}));
mock.module("./snapshot-provider.js", () => ({ getBestSnapshot: async () => ({ type: "none" }) }));

mock.module("../sio-registry.js", () => ({
    getSharedSession,
    getSharedSessionSummary: async () => null,
    getSessionMessages,
    addViewer: async () => {},
    removeViewer: async () => {},
    getSessionSeq: async () => 0,
    sendSnapshotToViewer: async () => {},
    getLocalTuiSocket: () => null,
    waitForLocalTuiSocket: async () => null,
    emitToRelaySession: () => false,
    emitToRelaySessionVerified: async () => ({ delivered: false }),
    emitToRelaySessionChecked: async () => ({ delivered: false }),
    emitToRunner: () => false,
    getRunnerData: async () => null,
    serviceFollowRoom: (serviceId: string, runnerId: string) => `service:${serviceId}:${runnerId}`,
    broadcastToSessionViewers: async () => {},
    markPendingRecovery: () => {},
}));

function createHarness() {
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const emitted: Array<{ event: string; payload: unknown }> = [];
    const socket = {
        id: "viewer-1",
        data: { userId: "user-1", sessionId: "sess-1", generation: 4 },
        handshake: { auth: {}, query: {} },
        on: (event: string, handler: (...args: unknown[]) => unknown) => handlers.set(event, handler),
        emit: (event: string, payload: unknown) => emitted.push({ event, payload }),
        join: async () => {},
        leave: () => {},
        disconnect: () => {},
    };
    let connection: ((socket: unknown) => unknown) | undefined;
    const namespace = {
        use: () => {},
        on: (event: string, handler: (socket: unknown) => unknown) => {
            if (event === "connection") connection = handler;
        },
    };
    const io = { of: () => namespace };
    return { handlers, emitted, socket, io, connect: async () => connection?.(socket) };
}

const { registerViewerNamespace } = await import("./viewer.js");

describe("load_messages", () => {
    test("pages cached session messages without fetching/parsing the full session hash", async () => {
        getSessionMessages.mockClear();
        getSharedSession.mockClear();
        getLatestCachedSnapshotEvent.mockClear();
        getSessionMessages.mockResolvedValueOnce(Array.from({ length: 10 }, (_, i) => ({ id: i })));

        const harness = createHarness();
        registerViewerNamespace(harness.io as never, {} as never);
        await harness.connect();

        await harness.handlers.get("load_messages")?.({ sessionId: "sess-1", before: 8, limit: 3 });

        expect(getSessionMessages).toHaveBeenCalledWith("sess-1");
        expect(getSharedSession).not.toHaveBeenCalled();
        expect(getLatestCachedSnapshotEvent).not.toHaveBeenCalled();
        expect(harness.emitted).toContainEqual({
            event: "session_messages_page",
            payload: {
                sessionId: "sess-1",
                messages: [{ id: 5 }, { id: 6 }, { id: 7 }],
                hasMore: true,
                oldestIndex: 5,
                generation: 4,
            },
        });
    });

    test("keeps the cached snapshot fallback when no lastState messages exist", async () => {
        getSessionMessages.mockClear();
        getLatestCachedSnapshotEvent.mockClear();
        getSessionMessages.mockResolvedValueOnce(null as never);
        getLatestCachedSnapshotEvent.mockResolvedValueOnce({
            event: { type: "session_active", state: { messages: ["a", "b", "c"] } },
        });

        const harness = createHarness();
        registerViewerNamespace(harness.io as never, {} as never);
        await harness.connect();

        await harness.handlers.get("load_messages")?.({ sessionId: "sess-1", before: 3, limit: 2 });

        expect(harness.emitted.at(-1)).toEqual({
            event: "session_messages_page",
            payload: {
                sessionId: "sess-1",
                messages: ["b", "c"],
                hasMore: true,
                oldestIndex: 1,
                generation: 4,
            },
        });
    });
});
