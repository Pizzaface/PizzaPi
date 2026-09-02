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
    emitToRunner: mock(() => {}),
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

const mockGetSession = mock(() => Promise.resolve(null));
const mockGetPersistedRelaySessionOwner = mock(() => Promise.resolve(null));
mock.module("../sessions/store.js", () => ({
    getPersistedRelaySessionOwner: mockGetPersistedRelaySessionOwner,
}));
const mockEmitTriggerSubscriptionDelta = mock((_runnerId: string, _delta: any) => Promise.resolve());
const mockSendRunnerCommand = mock(() => Promise.resolve({ ok: true }));
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
mock.module("../user-hidden-models.js", () => ({ getHiddenModels: mock(() => Promise.resolve([])) }));
import * as _runnerRegistryModule from "../ws/sio-registry/runners.js";
import * as _sioStateModule from "../ws/sio-state/index.js";
spyOn(_runnerRegistryModule, "getRunnerServices").mockImplementation(mockGetRunnerServices as any);
spyOn(_sioStateModule, "getSession").mockImplementation(mockGetSession as any);

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

describe("runner read-file route", () => {
    beforeEach(() => {
        mockRequireSession.mockReset();
        mockRequireSession.mockReturnValue(Promise.resolve({ userId: "user-1", userName: "TestUser" } as any));
        mockGetRunnerData.mockReset();
        mockGetRunnerData.mockReturnValue(Promise.resolve({ userId: "user-1", runnerId: "runner-A" } as any));
        mockSendRunnerCommand.mockReset();
        mockSendRunnerCommand.mockReturnValue(Promise.resolve({ ok: true, size: 3, content: "AAAA" }));
    });

    test("forwards rejectTruncated and strips partial content from older runners", async () => {
        mockSendRunnerCommand.mockReturnValue(Promise.resolve({
            ok: true,
            size: 11 * 1024 * 1024,
            content: "partial",
            truncated: true,
        }));
        const [req, url] = makeReq("POST", "/api/runners/runner-A/read-file", {
            path: "/repo/demo.mp4",
            encoding: "base64",
            rejectTruncated: true,
        });

        const res = await handleRunnersRoute(req, url);

        expect(res!.status).toBe(200);
        expect(mockSendRunnerCommand).toHaveBeenCalledWith("runner-A", {
            type: "read_file",
            path: "/repo/demo.mp4",
            encoding: "base64",
            maxBytes: 10 * 1024 * 1024,
            rejectTruncated: true,
        }, 30_000, req.signal);
        expect(await res!.json()).toEqual({ ok: true, size: 11 * 1024 * 1024, truncated: true });
    });
});

describe("runner analysis route", () => {
    beforeEach(() => {
        mockRequireSession.mockReset();
        mockRequireSession.mockReturnValue(Promise.resolve({ userId: "user-1", userName: "TestUser" } as any));
        mockGetRunnerData.mockReset();
        mockGetRunnerData.mockReturnValue(Promise.resolve({ userId: "user-1", runnerId: "runner-A" } as any));
        mockSendRunnerCommand.mockReset();
        mockSendRunnerCommand.mockReturnValue(Promise.resolve({ ok: true }));
        mockGetSession.mockReset();
        mockGetSession.mockReturnValue(Promise.resolve(null));
        mockGetPersistedRelaySessionOwner.mockReset();
        mockGetPersistedRelaySessionOwner.mockReturnValue(Promise.resolve(null));
    });

    test("forwards analyze_session when the session is owned by the caller", async () => {
        mockGetSession.mockReturnValue(Promise.resolve({ userId: "user-1", sessionId: "sess-1" } as any));

        const [req, url] = makeReq("GET", "/api/runners/runner-A/analysis/sess-1");
        const res = await handleRunnersRoute(req, url);

        expect(res!.status).toBe(200);
        expect(mockSendRunnerCommand).toHaveBeenCalledWith("runner-A", { type: "analyze_session", sessionId: "sess-1" }, 30_000);
    });

    test("resolves ownership from the persisted store when the session is not live", async () => {
        mockGetSession.mockReturnValue(Promise.resolve(null));
        mockGetPersistedRelaySessionOwner.mockReturnValue(Promise.resolve({ userId: "user-1", runnerId: "runner-A", cwd: "/repo" } as any));

        const [req, url] = makeReq("GET", "/api/runners/runner-A/analysis/sess-1");
        const res = await handleRunnersRoute(req, url);

        expect(res!.status).toBe(200);
        expect(mockSendRunnerCommand).toHaveBeenCalledWith("runner-A", { type: "analyze_session", sessionId: "sess-1" }, 30_000);
    });

    test("returns 403 and does not forward when the session is owned by another user", async () => {
        mockGetSession.mockReturnValue(Promise.resolve({ userId: "user-2", sessionId: "sess-1" } as any));

        const [req, url] = makeReq("GET", "/api/runners/runner-A/analysis/sess-1");
        const res = await handleRunnersRoute(req, url);

        expect(res!.status).toBe(403);
        expect(mockSendRunnerCommand).not.toHaveBeenCalled();
    });

    test("returns 404 and does not forward when the session is not found", async () => {
        mockGetSession.mockReturnValue(Promise.resolve(null));
        mockGetPersistedRelaySessionOwner.mockReturnValue(Promise.resolve(null));

        const [req, url] = makeReq("GET", "/api/runners/runner-A/analysis/sess-missing");
        const res = await handleRunnersRoute(req, url);

        expect(res!.status).toBe(404);
        expect(mockSendRunnerCommand).not.toHaveBeenCalled();
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
        mockGetRunnerServices.mockReset();
        mockGetRunnerServices.mockReturnValue(Promise.resolve(null));
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

    test("POST rejects a mode-scoped trigger when listener cwd is outside the mode", async () => {
        mockGetRunnerServices.mockReturnValue(Promise.resolve({
            serviceIds: ["reporter"],
            triggerDefs: [{ type: "reporter:daily", label: "Daily", modes: ["work"] }],
            sessionModes: [{ id: "work", label: "Work", workspace: "/home/u/Workspace" }],
        }));

        const [req, url] = makeReq("POST", "/api/runners/runner-A/trigger-listeners", {
            triggerType: "reporter:daily",
            prompt: "Report",
            cwd: "/home/u/Projects/foo",
        });
        const res = await handleRunnersRoute(req, url);
        expect(res!.status).toBe(422);
        const body = await res!.json();
        expect(body.error).toContain("scoped to session mode");
        expect(mockAddRunnerTriggerListener).not.toHaveBeenCalled();
    });

    test("POST allows a mode-scoped trigger when listener cwd is inside the mode", async () => {
        mockGetRunnerServices.mockReturnValue(Promise.resolve({
            serviceIds: ["reporter"],
            triggerDefs: [{ type: "reporter:daily", label: "Daily", modes: ["work"] }],
            sessionModes: [{ id: "work", label: "Work", workspace: "/home/u/Workspace" }],
        }));
        mockAddRunnerTriggerListener.mockReturnValue(Promise.resolve("listener-work"));

        const [req, url] = makeReq("POST", "/api/runners/runner-A/trigger-listeners", {
            triggerType: "reporter:daily",
            prompt: "Report",
            cwd: "/home/u/Workspace/reports",
        });
        const res = await handleRunnersRoute(req, url);
        expect(res!.status).toBe(200);
        expect((await res!.json()).listenerId).toBe("listener-work");
    });

    test("PUT rejects moving a mode-scoped listener's cwd outside the mode", async () => {
        mockGetRunnerServices.mockReturnValue(Promise.resolve({
            serviceIds: ["reporter"],
            triggerDefs: [{ type: "reporter:daily", label: "Daily", modes: ["work"] }],
            sessionModes: [{ id: "work", label: "Work", workspace: "/home/u/Workspace" }],
        }));
        mockGetRunnerTriggerListener.mockReturnValue(Promise.resolve({ listenerId: "listener-123", triggerType: "reporter:daily" }));

        const [req, url] = makeReq("PUT", "/api/runners/runner-A/trigger-listeners/listener-123", {
            cwd: "/home/u/Projects/foo",
        });
        const res = await handleRunnersRoute(req, url);
        expect(res!.status).toBe(422);
        expect(mockUpdateRunnerTriggerListener).not.toHaveBeenCalled();
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

describe("skills reload route", () => {
    beforeEach(() => {
        mockRequireSession.mockReset();
        mockRequireSession.mockReturnValue(Promise.resolve({ userId: "user-1", userName: "TestUser" } as any));
        mockGetRunnerData.mockReset();
        mockGetRunnerData.mockReturnValue(Promise.resolve({ userId: "user-1", runnerId: "runner-A" } as any));
        mockGetConnectedSessionsForRunner.mockReset();
        mockGetLocalTuiSocket.mockReset();
    });

    test("POST re-scans and sends /skills reload to every live session", async () => {
        const emitA = mock(() => {});
        const emitB = mock(() => {});
        mockGetConnectedSessionsForRunner.mockReturnValue(Promise.resolve([
            { sessionId: "sess-1", cwd: "/tmp/a" },
            { sessionId: "sess-2", cwd: "/tmp/b" },
        ]));
        mockGetLocalTuiSocket.mockImplementation((sessionId: string) => (
            sessionId === "sess-1" ? { emit: emitA } as any : { emit: emitB } as any
        ));

        const [req, url] = makeReq("POST", "/api/runners/runner-A/skills/reload");
        const res = await handleRunnersRoute(req, url);
        expect(res!.status).toBe(200);
        const body = await res!.json();
        expect(body.reloaded).toBe(2);
        expect(body.failed).toBe(0);
        expect(emitA).toHaveBeenCalledWith("input", {
            text: "/skills reload",
            attachments: [],
            deliverAs: "followUp",
        });
        expect(emitB).toHaveBeenCalled();
    });

    test("POST still succeeds when no sessions are live", async () => {
        mockGetConnectedSessionsForRunner.mockReturnValue(Promise.resolve([]));
        const [req, url] = makeReq("POST", "/api/runners/runner-A/skills/reload");
        const res = await handleRunnersRoute(req, url);
        expect(res!.status).toBe(200);
        const body = await res!.json();
        expect(body.ok).toBe(true);
        expect(body.reloaded).toBe(0);
    });

    test("POST counts sessions whose socket is gone as failed", async () => {
        mockGetConnectedSessionsForRunner.mockReturnValue(Promise.resolve([{ sessionId: "sess-1", cwd: "/tmp/a" }]));
        mockGetLocalTuiSocket.mockReturnValue(undefined as any);
        const [req, url] = makeReq("POST", "/api/runners/runner-A/skills/reload");
        const res = await handleRunnersRoute(req, url);
        const body = await res!.json();
        expect(body.failed).toBe(1);
        expect(body.failedSessionIds).toEqual(["sess-1"]);
    });
});
