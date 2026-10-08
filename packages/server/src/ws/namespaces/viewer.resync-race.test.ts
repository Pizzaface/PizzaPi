import { describe, expect, mock, test } from "bun:test";

const handlers = new Map<string, (...args: any[]) => unknown>();

let blockedSessionResolve: ((value: unknown) => void) | undefined;
let blockedSeqResolve: ((value: number) => void) | undefined;

const hydrateViewerFromCache = mock(async () => true);

mock.module("../../auth.js", () => ({
    bindAuthContext: (_context: unknown, fn: (...args: any[]) => unknown) => fn,
}));

mock.module("./auth.js", () => ({
    browserAuthMiddleware: () => (_socket: unknown, next: () => void) => next(),
}));

mock.module("./context.js", () => ({
    bindSocketHandlersToAuthContext: () => undefined,
}));

mock.module("./runner.js", () => ({ getRunnerServiceAnnounce: () => null }));
mock.module("./runner-ref.js", () => ({ withRunnerRefHint: () => ({}) }));
mock.module("../sio-state/index.js", () => ({ isChildOfParent: async () => false }));
mock.module("./relay/index.js", () => ({ getPendingChunkedSnapshot: () => null }));
mock.module("../../sessions/redis.js", () => ({ getLatestCachedSnapshotEvent: async () => null }));
mock.module("../../sessions/store.js", () => ({ getPersistedRelaySessionSnapshot: async () => null }));
mock.module("../../sessions/trigger-store.js", () => ({ recordTriggerResponse: async () => undefined }));
mock.module("../../user-hidden-models.js", () => ({ getHiddenModels: async () => [] }));
mock.module("../../routes/model-guard.js", () => ({ isHiddenModel: () => false }));
mock.module("@pizzapi/tools", () => ({ createLogger: () => ({ info: () => undefined, error: () => undefined, warn: () => undefined }) }));
mock.module("./snapshot-provider.js", () => ({ getBestSnapshot: async () => null }));
mock.module("./viewer-cache.js", () => ({
    hydrateViewerFromCache,
    sendCachedDeltaReplayEvents: async () => false,
}));

mock.module("../sio-registry.js", () => ({
    getSharedSessionSummary: async (sessionId: string) => ({ sessionId, userId: "user-1" }),
    addViewer: async () => true,
    removeViewer: async () => undefined,
    getSharedSession: mock((sessionId: string) => {
        if (sessionId === "A") {
            return new Promise((resolve) => { blockedSessionResolve = resolve; });
        }
        return Promise.resolve({ sessionId, userId: "user-1", isActive: true });
    }),
    getSessionSeq: mock((sessionId: string) => {
        if (sessionId === "A") {
            return new Promise<number>((resolve) => { blockedSeqResolve = resolve; });
        }
        return Promise.resolve(0);
    }),
    sendSnapshotToViewer: mock(async () => undefined),
    getLocalTuiSocket: () => null,
    waitForLocalTuiSocket: async () => null,
    emitToRelaySession: async () => undefined,
    emitToRelaySessionVerified: async () => false,
    emitToRelaySessionChecked: async () => "empty",
    emitToRunner: async () => undefined,
    getRunnerData: () => null,
    serviceFollowRoom: () => "service-room",
    broadcastToSessionViewers: async () => undefined,
    markPendingRecovery: () => "nonce",
}));

describe("viewer resync handler", () => {
    test("aborts cache hydration when the viewer switches sessions during the Redis read", async () => {
        const { registerViewerNamespace } = await import("./viewer.js");
        const namespace = {
            use: mock(() => namespace),
            on: mock((event: string, handler: (...args: any[]) => unknown) => {
                handlers.set(event, handler);
                return namespace;
            }),
        };
        const io = { of: mock(() => namespace) };

        registerViewerNamespace(io as any, {} as any);

        const socketHandlers = new Map<string, (...args: any[]) => unknown>();
        const socket = {
            id: "viewer-1",
            data: { userId: "user-1", sessionId: "A", generation: 1 },
            handshake: { auth: {}, query: {} },
            on: mock((event: string, handler: (...args: any[]) => unknown) => {
                socketHandlers.set(event, handler);
                return socket;
            }),
            emit: mock(() => true),
            disconnect: mock(() => undefined),
        };

        await handlers.get("connection")?.(socket);

        const resync = socketHandlers.get("resync")?.({ lastSeq: 12 });
        expect(blockedSessionResolve).toBeDefined();
        expect(blockedSeqResolve).toBeDefined();

        await socketHandlers.get("switch_session")?.({ sessionId: "B", generation: 2 });
        blockedSessionResolve?.({ sessionId: "A", userId: "user-1", isActive: true });
        blockedSeqResolve?.(99);
        await resync;

        expect(hydrateViewerFromCache).not.toHaveBeenCalled();
    });
});
