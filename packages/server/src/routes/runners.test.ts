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
const mockGetLocalTuiSocket = mock((_sessionId: string) => undefined as any);
const mockGetConnectedSessionsForRunner = mock((_runnerId: string) => Promise.resolve([] as Array<{ sessionId: string; cwd: string }>));
const mockLinkSessionToRunner = mock((_runnerId: string, _sessionId: string) => Promise.resolve());
const mockRecordRunnerSession = mock((_runnerId: string, _sessionId: string) => Promise.resolve());
const mockRegisterTerminal = mock((_terminalId: string, _runnerId: string, _userId: string, _opts: any) => Promise.resolve());
mock.module("../ws/sio-registry.js", () => ({
    getRunnerData: mockGetRunnerData,
    getRunners: mockGetRunners,
    getLocalRunnerSocket: mockGetLocalRunnerSocket,
    getLocalTuiSocket: mockGetLocalTuiSocket,
    getConnectedSessionsForRunner: mockGetConnectedSessionsForRunner,
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

const mockGetHiddenModels = mock(() => Promise.resolve([] as string[]));
const mockGetSession = mock(() => Promise.resolve(null));
const mockEmitTriggerSubscriptionDelta = mock((_runnerId: string, _delta: any) => Promise.resolve());
const mockSendRunnerCommand = mock((_runnerId: string, _command: Record<string, unknown>) => Promise.resolve({ ok: true } as any));
mock.module("../ws/namespaces/runner.js", () => ({
    sendSkillCommand: mock(() => Promise.resolve({ ok: true })),
    sendAgentCommand: mock(() => Promise.resolve({ ok: true })),
    sendRunnerCommand: mockSendRunnerCommand,
    emitTriggerSubscriptionDelta: mockEmitTriggerSubscriptionDelta,
}));
mock.module("../ws/runner-control.js", () => ({ waitForSpawnAck: mock(() => Promise.resolve({ ok: true })) }));
mock.module("../runner-recent-folders.js", () => ({
    deleteRecentFolder: mock(() => Promise.resolve(false)),
    getRecentFolders: mock(() => Promise.resolve([])),
    recordRecentFolder: mock(() => Promise.resolve()),
}));
mock.module("../user-hidden-models.js", () => ({ getHiddenModels: mockGetHiddenModels }));
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

describe("runner service toggle route", () => {
    beforeEach(() => {
        mockRequireSession.mockReset();
        mockRequireSession.mockReturnValue(Promise.resolve({ userId: "user-1", userName: "TestUser" } as any));
        mockGetRunnerData.mockReset();
        mockGetRunnerData.mockReturnValue(Promise.resolve({ userId: "user-1", runnerId: "runner-A" } as any));
        mockGetRunnerServices.mockReset();
        mockGetLocalRunnerSocket.mockReset();
    });

    test("sends the changed service id so the runner can merge against runtime state", async () => {
        const emit = mock(() => {});
        mockGetRunnerServices.mockReturnValue(Promise.resolve({
            serviceIds: ["taxonomy", "nightshift"],
            disabledServiceIds: [],
            panels: [],
            triggerDefs: [],
            sigilDefs: [],
        }));
        mockGetLocalRunnerSocket.mockReturnValue({ emit } as any);

        const [req, url] = makeReq("PUT", "/api/runners/runner-A/services/taxonomy/enabled", { enabled: false });
        const res = await handleRunnersRoute(req, url);
        expect(res!.status).toBe(200);
        expect(emit).toHaveBeenCalledWith("reconfigure_services", {
            disabledServiceIds: ["taxonomy"],
            serviceId: "taxonomy",
            enabled: false,
        });
    });
});

describe("runner model routes", () => {
    beforeEach(() => {
        mockRequireSession.mockReset();
        mockRequireSession.mockReturnValue(Promise.resolve({ userId: "user-1", userName: "TestUser" } as any));
        mockGetRunnerData.mockReset();
        mockGetRunnerData.mockReturnValue(Promise.resolve({ userId: "user-1", runnerId: "runner-A" } as any));
        mockSendRunnerCommand.mockReset();
        mockGetHiddenModels.mockReset();
        mockGetHiddenModels.mockReturnValue(Promise.resolve([]));
    });

    test("relays the runner-provided visible and full model catalogs", async () => {
        mockSendRunnerCommand.mockReturnValue(Promise.resolve({
            models: [{ provider: "openai", id: "visible" }],
            allModels: [{ provider: "openai", id: "visible" }, { provider: "openai", id: "hidden" }],
            hiddenModels: ["openai/hidden"],
        }));

        const [req, url] = makeReq("GET", "/api/runners/runner-A/models");
        const res = await handleRunnersRoute(req, url);

        expect(res!.status).toBe(200);
        expect(await res!.json()).toEqual({
            models: [{ provider: "openai", id: "visible" }],
            allModels: [{ provider: "openai", id: "visible" }, { provider: "openai", id: "hidden" }],
            hiddenModels: ["openai/hidden"],
        });
        expect(mockSendRunnerCommand).toHaveBeenCalledWith("runner-A", { type: "list_models" });
    });

    test("migrates legacy preferences into an unconfigured new runner", async () => {
        mockSendRunnerCommand
            .mockReturnValueOnce(Promise.resolve({
                models: [{ provider: "openai", id: "visible" }, { provider: "openai", id: "hidden" }],
                allModels: [{ provider: "openai", id: "visible" }, { provider: "openai", id: "hidden" }],
                hiddenModels: [],
                modelVisibilityConfigured: false,
            }))
            .mockReturnValueOnce(Promise.resolve({ ok: true }));
        mockGetHiddenModels.mockReturnValue(Promise.resolve(["openai/hidden"]));

        const [req, url] = makeReq("GET", "/api/runners/runner-A/models");
        const res = await handleRunnersRoute(req, url);
        expect(await res!.json()).toEqual({
            models: [{ provider: "openai", id: "visible" }],
            allModels: [{ provider: "openai", id: "visible" }, { provider: "openai", id: "hidden" }],
            hiddenModels: ["openai/hidden"],
        });
        expect(mockSendRunnerCommand).toHaveBeenLastCalledWith("runner-A", {
            type: "set_hidden_models",
            hiddenModels: ["openai/hidden"],
        });
    });

    test("falls back to legacy relay preferences for an old runner", async () => {
        mockSendRunnerCommand.mockReturnValue(Promise.resolve({
            models: [{ provider: "openai", id: "visible" }, { provider: "openai", id: "hidden" }],
        }));
        mockGetHiddenModels.mockReturnValue(Promise.resolve(["openai/hidden"]));

        const [req, url] = makeReq("GET", "/api/runners/runner-A/models");
        const res = await handleRunnersRoute(req, url);
        expect(await res!.json()).toEqual({
            models: [{ provider: "openai", id: "visible" }],
            allModels: [{ provider: "openai", id: "visible" }, { provider: "openai", id: "hidden" }],
            hiddenModels: ["openai/hidden"],
        });
    });

    test("relays visibility updates to the runner", async () => {
        mockSendRunnerCommand.mockReturnValue(Promise.resolve({ ok: true, hiddenModels: ["openai/hidden"] }));
        const [req, url] = makeReq("PUT", "/api/runners/runner-A/models", { hiddenModels: ["openai/hidden"] });
        const res = await handleRunnersRoute(req, url);

        expect(res!.status).toBe(200);
        expect(mockSendRunnerCommand).toHaveBeenCalledWith("runner-A", {
            type: "set_hidden_models",
            hiddenModels: ["openai/hidden"],
        });
    });
});

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
        mockGetLocalTuiSocket.mockReset();
        mockGetConnectedSessionsForRunner.mockReset();
        mockGetConnectedSessionsForRunner.mockReturnValue(Promise.resolve([]));
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

describe("runner MCP reload route", () => {
    beforeEach(() => {
        mockRequireSession.mockReset();
        mockRequireSession.mockReturnValue(Promise.resolve({ userId: "user-1", userName: "TestUser" } as any));
        mockGetRunnerData.mockReset();
        mockGetRunnerData.mockReturnValue(Promise.resolve({ userId: "user-1", runnerId: "runner-A" } as any));
        mockGetConnectedSessionsForRunner.mockReset();
        mockGetLocalTuiSocket.mockReset();
    });

    test("POST reloads MCP for each connected runner session", async () => {
        const emitA = mock(() => {});
        const emitB = mock(() => {});
        mockGetConnectedSessionsForRunner.mockReturnValue(Promise.resolve([
            { sessionId: "sess-1", cwd: "/tmp/a" },
            { sessionId: "sess-2", cwd: "/tmp/b" },
        ]));
        mockGetLocalTuiSocket.mockImplementation((sessionId: string) => {
            if (sessionId === "sess-1") return { emit: emitA } as any;
            if (sessionId === "sess-2") return { emit: emitB } as any;
            return undefined;
        });

        const [req, url] = makeReq("POST", "/api/runners/runner-A/mcp/reload");
        const res = await handleRunnersRoute(req, url);
        expect(res!.status).toBe(200);
        const body = await res!.json();
        expect(body.ok).toBe(true);
        expect(body.reloaded).toBe(2);
        expect(body.failed).toBe(0);
        expect(emitA).toHaveBeenCalledWith("exec", expect.objectContaining({ command: "mcp", action: "reload" }));
        expect(emitB).toHaveBeenCalledWith("exec", expect.objectContaining({ command: "mcp", action: "reload" }));
    });

    test("POST reports sessions that could not be reloaded", async () => {
        const emitA = mock(() => {});
        mockGetConnectedSessionsForRunner.mockReturnValue(Promise.resolve([
            { sessionId: "sess-1", cwd: "/tmp/a" },
            { sessionId: "sess-2", cwd: "/tmp/b" },
        ]));
        mockGetLocalTuiSocket.mockImplementation((sessionId: string) => (
            sessionId === "sess-1" ? { emit: emitA } as any : undefined
        ));

        const [req, url] = makeReq("POST", "/api/runners/runner-A/mcp/reload");
        const res = await handleRunnersRoute(req, url);
        expect(res!.status).toBe(200);
        const body = await res!.json();
        expect(body.reloaded).toBe(1);
        expect(body.failed).toBe(1);
        expect(body.sessionIds).toEqual(["sess-1"]);
        expect(body.failedSessionIds).toEqual(["sess-2"]);
    });

    test("POST reports when all active sessions fail to reload", async () => {
        mockGetConnectedSessionsForRunner.mockReturnValue(Promise.resolve([
            { sessionId: "sess-1", cwd: "/tmp/a" },
            { sessionId: "sess-2", cwd: "/tmp/b" },
        ]));
        mockGetLocalTuiSocket.mockReturnValue(undefined as any);

        const [req, url] = makeReq("POST", "/api/runners/runner-A/mcp/reload");
        const res = await handleRunnersRoute(req, url);
        expect(res!.status).toBe(200);
        const body = await res!.json();
        expect(body.reloaded).toBe(0);
        expect(body.failed).toBe(2);
        expect(body.sessionIds).toEqual([]);
        expect(body.failedSessionIds).toEqual(["sess-1", "sess-2"]);
    });
});
