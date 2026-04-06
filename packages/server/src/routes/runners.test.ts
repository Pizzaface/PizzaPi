import { afterAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";

afterAll(() => mock.restore());

const mockRequireSession = mock((_req: Request) =>
    Promise.resolve({ userId: "user-1", userName: "TestUser" } as any),
);
const mockValidateApiKey = mock((_req: Request, _key?: string) =>
    Promise.resolve({ userId: "user-1", userName: "TestUser" } as any),
);
mock.module("../middleware.js", () => ({
    requireSession: mockRequireSession,
    validateApiKey: mockValidateApiKey,
}));

const mockGetRunnerData = mock((_runnerId: string) => Promise.resolve({ userId: "user-1", runnerId: "runner-A" } as any));
const mockGetRunners = mock((_userId: string) => Promise.resolve([] as any[]));
const mockGetLocalRunnerSocket = mock((_runnerId: string) => null as any);
const mockLinkSessionToRunner = mock((_runnerId: string, _sessionId: string) => Promise.resolve());
const mockRecordRunnerSession = mock((_runnerId: string, _sessionId: string) => Promise.resolve());
const mockRegisterTerminal = mock((_terminalId: string, _runnerId: string, _userId: string, _opts: any) => Promise.resolve());
mock.module("../ws/sio-registry.js", () => ({
    getRunnerData: mockGetRunnerData,
    getRunners: mockGetRunners,
    getLocalRunnerSocket: mockGetLocalRunnerSocket,
    linkSessionToRunner: mockLinkSessionToRunner,
    recordRunnerSession: mockRecordRunnerSession,
    registerTerminal: mockRegisterTerminal,
}));

const mockGetRunnerServices = mock((_runnerId: string) => Promise.resolve(null as any));

const mockAddRunnerTriggerListener = mock((_runnerId: string, _triggerType: string, _config: any) => Promise.resolve("listener-default"));
const mockGetRunnerTriggerListener = mock((_runnerId: string, _target: string) => Promise.resolve(null as any));
const mockRemoveRunnerTriggerListener = mock((_runnerId: string, _target: string) => Promise.resolve({ removed: 1, triggerType: _target }));
const mockListRunnerTriggerListeners = mock((_runnerId: string) => Promise.resolve([] as any[]));
const mockUpdateRunnerTriggerListener = mock((_runnerId: string, _target: string, _updates: any) => Promise.resolve({ updated: false }));
mock.module("../sessions/runner-trigger-listener-store.js", () => ({
    addRunnerTriggerListener: mockAddRunnerTriggerListener,
    getRunnerTriggerListener: mockGetRunnerTriggerListener,
    removeRunnerTriggerListener: mockRemoveRunnerTriggerListener,
    listRunnerTriggerListeners: mockListRunnerTriggerListeners,
    updateRunnerTriggerListener: mockUpdateRunnerTriggerListener,
}));

const mockGetSession = mock(() => Promise.resolve(null));
const mockEmitTriggerSubscriptionDelta = mock((_runnerId: string, _delta: any) => Promise.resolve());
mock.module("../ws/namespaces/runner.js", () => ({
    sendSkillCommand: mock(() => Promise.resolve({ ok: true })),
    sendAgentCommand: mock(() => Promise.resolve({ ok: true })),
    sendRunnerCommand: mock(() => Promise.resolve({ ok: true })),
    emitTriggerSubscriptionDelta: mockEmitTriggerSubscriptionDelta,
}));
mock.module("../ws/runner-control.js", () => ({ waitForSpawnAck: mock(() => Promise.resolve({ ok: true })) }));
mock.module("../runner-recent-folders.js", () => ({
    deleteRecentFolder: mock(() => Promise.resolve(false)),
    getRecentFolders: mock(() => Promise.resolve([])),
    recordRecentFolder: mock(() => Promise.resolve()),
}));
mock.module("../user-hidden-models.js", () => ({ getHiddenModels: mock(() => Promise.resolve([])) }));
import * as _runnerRegistryModule from "../ws/sio-registry/runners.js";
import * as _sioStateModule from "../ws/sio-state/index.js";
const mockRunnerServicesSpy = spyOn(_runnerRegistryModule, "getRunnerServices").mockImplementation(mockGetRunnerServices as any);
const mockGetSessionSpy = spyOn(_sioStateModule, "getSession").mockImplementation(mockGetSession as any);

const { handleRunnersRoute } = await import("./runners.js");

function makeReq(method: string, path: string, body?: object): [Request, URL] {
    const url = new URL(`http://localhost${path}`);
    const init: RequestInit = {
        method,
        headers: { "content-type": "application/json" },
    };
    if (body) init.body = JSON.stringify(body);
    return [new Request(url.toString(), init), url];
}

describe("runner trigger listener routes", () => {
    beforeEach(() => {
        mockRequireSession.mockReset();
        mockRequireSession.mockReturnValue(Promise.resolve({ userId: "user-1", userName: "TestUser" } as any));
        mockGetRunnerData.mockReset();
        mockGetRunnerData.mockReturnValue(Promise.resolve({ userId: "user-1", runnerId: "runner-A" } as any));
        mockAddRunnerTriggerListener.mockReset();
        mockAddRunnerTriggerListener.mockReturnValue(Promise.resolve("listener-default"));
        mockRemoveRunnerTriggerListener.mockReset();
        mockRemoveRunnerTriggerListener.mockReturnValue(Promise.resolve({ removed: 1, triggerType: "svc:event" }));
        mockGetRunnerTriggerListener.mockReset();
        mockGetRunnerTriggerListener.mockReturnValue(Promise.resolve(null as any));
        mockListRunnerTriggerListeners.mockReset();
        mockListRunnerTriggerListeners.mockReturnValue(Promise.resolve([] as any[]));
        mockUpdateRunnerTriggerListener.mockReset();
        mockUpdateRunnerTriggerListener.mockReturnValue(Promise.resolve({ updated: false }));
        mockGetLocalRunnerSocket.mockReset();
        mockEmitTriggerSubscriptionDelta.mockReset();
        mockEmitTriggerSubscriptionDelta.mockReturnValue(Promise.resolve());
    });

    test("GET returns all listeners with ids", async () => {
        mockListRunnerTriggerListeners.mockReturnValue(Promise.resolve([
            { listenerId: "listener-1", triggerType: "svc:event", prompt: "one" },
            { listenerId: "listener-2", triggerType: "svc:event", prompt: "two" },
        ]));

        const [req, url] = makeReq("GET", "/api/runners/runner-A/trigger-listeners");
        const res = await handleRunnersRoute(req, url);
        expect(res!.status).toBe(200);
        const body = await res!.json();
        expect(body.listeners).toHaveLength(2);
        expect(body.listeners[0].listenerId).toBe("listener-1");
        expect(body.listeners[1].listenerId).toBe("listener-2");
    });

    test("POST returns listenerId and emits a runner subscription delta", async () => {
        mockAddRunnerTriggerListener.mockReturnValue(Promise.resolve("listener-123"));

        const [req, url] = makeReq("POST", "/api/runners/runner-A/trigger-listeners", {
            triggerType: "svc:event",
            prompt: "Investigate",
            params: { duration: "10m" },
        });
        const res = await handleRunnersRoute(req, url);
        expect(res!.status).toBe(200);
        const body = await res!.json();
        expect(body.ok).toBe(true);
        expect(body.listenerId).toBe("listener-123");
        expect(body.triggerType).toBe("svc:event");
        expect(mockEmitTriggerSubscriptionDelta).toHaveBeenCalledWith("runner-A", expect.objectContaining({
            action: "subscribe",
            subscription: expect.objectContaining({
                subscriptionId: "listener-123",
                triggerType: "svc:event",
                params: { duration: "10m" },
            }),
        }));
    });

    test("POST returns 500 when listener creation fails", async () => {
        mockAddRunnerTriggerListener.mockReturnValue(Promise.resolve(""));

        const [req, url] = makeReq("POST", "/api/runners/runner-A/trigger-listeners", {
            triggerType: "svc:event",
            prompt: "Investigate",
        });
        const res = await handleRunnersRoute(req, url);
        expect(res!.status).toBe(500);
        const body = await res!.json();
        expect(body.error).toBe("Failed to create trigger listener");
    });

    test("PUT updates one listener by id", async () => {
        const runnerEmit = mock(() => {});
        mockGetLocalRunnerSocket.mockReturnValue({ emit: runnerEmit } as any);
        mockUpdateRunnerTriggerListener.mockReturnValue(Promise.resolve({ updated: true, listenerId: "listener-123", triggerType: "svc:event" }));

        const [req, url] = makeReq("PUT", "/api/runners/runner-A/trigger-listeners/listener-123", {
            prompt: "Updated prompt",
        });
        const res = await handleRunnersRoute(req, url);
        expect(res!.status).toBe(200);
        const body = await res!.json();
        expect(body.ok).toBe(true);
        expect(body.listenerId).toBe("listener-123");
        expect(body.triggerType).toBe("svc:event");
        expect(runnerEmit).toHaveBeenCalledWith("listener_config_changed", expect.objectContaining({
            listenerId: "listener-123",
            triggerType: "svc:event",
        }));
    });

    test("DELETE removes one listener by id", async () => {
        mockRemoveRunnerTriggerListener.mockReturnValue(Promise.resolve({ removed: 1, triggerType: "svc:event" }));

        const [req, url] = makeReq("DELETE", "/api/runners/runner-A/trigger-listeners/listener-123");
        const res = await handleRunnersRoute(req, url);
        expect(res!.status).toBe(200);
        const body = await res!.json();
        expect(body.ok).toBe(true);
        expect(body.listenerId).toBe("listener-123");
        expect(body.triggerType).toBe("svc:event");
        expect(body.removed).toBe(1);
    });

    test("DELETE preserves legacy triggerType delete-all semantics", async () => {
        mockRemoveRunnerTriggerListener.mockReturnValue(Promise.resolve({ removed: 2, triggerType: "svc:event" }));

        const [req, url] = makeReq("DELETE", "/api/runners/runner-A/trigger-listeners/svc:event");
        const res = await handleRunnersRoute(req, url);
        expect(res!.status).toBe(200);
        const body = await res!.json();
        expect(body.ok).toBe(true);
        expect(body.triggerType).toBe("svc:event");
        expect(body.removed).toBe(2);
    });
});
