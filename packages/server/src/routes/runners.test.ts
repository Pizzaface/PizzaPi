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

// In-memory routes store (listeners are spawn routes since Phase 6).
const mockRoutes = new Map<string, any>();
const mockListDeliveries = mock(async () => [] as any[]);
const mockEventsForIds = mock(async () => [] as any[]);
mock.module("../events/store.js", () => ({
    createRoute: mock(async (input: any, opts?: { routeId?: string }) => {
        const route = { ...input, routeId: opts?.routeId ?? `rt_${mockRoutes.size + 1}`, createdAt: new Date().toISOString() };
        mockRoutes.set(route.routeId, route);
        return route;
    }),
    listRoutes: mock(async () => [...mockRoutes.values()]),
    getRoute: mock(async (id: string) => mockRoutes.get(id) ?? null),
    updateRoute: mock(async (id: string, patch: any) => {
        const existing = mockRoutes.get(id);
        if (!existing) return null;
        const updated = { ...existing, ...patch };
        mockRoutes.set(id, updated);
        return updated;
    }),
    deleteRoute: mock(async (id: string) => {
        const route = mockRoutes.get(id);
        // Faithful to the real store: config routes are read-only and deletion
        // throws (guards the DELETE pre-validation path).
        if (route?.origin === "config") throw new Error("Config-origin routes are read-only; edit the config file");
        return mockRoutes.delete(id);
    }),
    listDeliveries: mockListDeliveries,
    eventsForIds: mockEventsForIds,
}));

const mockGetSession = mock(() => Promise.resolve(null));
const mockGetPersistedRelaySessionOwner = mock(() => Promise.resolve(null));
mock.module("../sessions/store.js", () => ({
    getPersistedRelaySessionOwner: mockGetPersistedRelaySessionOwner,
}));
const mockEmitTriggerSubscriptionDelta = mock((_runnerId: string, _delta: any) => Promise.resolve());
const mockSendRunnerCommand = mock(() => Promise.resolve({ ok: true }));
const mockSendRunnerServiceRequest = mock(() => Promise.reject(new Error("unsupported")));
mock.module("../ws/namespaces/runner.js", () => ({
    sendSkillCommand: mock(() => Promise.resolve({ ok: true })),
    sendAgentCommand: mock(() => Promise.resolve({ ok: true })),
    sendRunnerCommand: mockSendRunnerCommand,
    sendRunnerServiceRequest: mockSendRunnerServiceRequest,
    emitTriggerSubscriptionDelta: mockEmitTriggerSubscriptionDelta,
}));
mock.module("../ws/runner-control.js", () => ({ waitForSpawnAck: mock(() => Promise.resolve({ ok: true })) }));
mock.module("../events/transport.js", () => ({ createEngineDeps: mock(() => ({}) ) }));
const mockPublishEvent = mock(() => Promise.resolve({ event: { eventId: "event-test" } }));
mock.module("../events/engine.js", () => ({ publishEvent: mockPublishEvent }));
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

    // Ephemeral relay_session rows are pruned ~10 minutes after a session goes
    // idle, so a post-hoc analysis request almost always has no owner record.
    // Denying that made the inspector 404 on every session older than the TTL.
    test("still forwards when no owner record survives (pruned relay_session row)", async () => {
        mockGetSession.mockReturnValue(Promise.resolve(null));
        mockGetPersistedRelaySessionOwner.mockReturnValue(Promise.resolve(null));

        const [req, url] = makeReq("GET", "/api/runners/runner-A/analysis/sess-pruned");
        const res = await handleRunnersRoute(req, url);

        expect(res!.status).toBe(200);
        expect(mockSendRunnerCommand).toHaveBeenCalledWith("runner-A", { type: "analyze_session", sessionId: "sess-pruned" }, 30_000);
    });

    test("a pruned row does not let a caller reach another user's runner", async () => {
        mockGetSession.mockReturnValue(Promise.resolve(null));
        mockGetPersistedRelaySessionOwner.mockReturnValue(Promise.resolve(null));
        mockGetRunnerData.mockReturnValue(Promise.resolve({ userId: "user-2", runnerId: "runner-A" } as any));

        const [req, url] = makeReq("GET", "/api/runners/runner-A/analysis/sess-pruned");
        const res = await handleRunnersRoute(req, url);

        expect(res!.status).toBe(403);
        expect(mockSendRunnerCommand).not.toHaveBeenCalled();
    });

    test("returns 403 when the persisted row names another owner", async () => {
        mockGetSession.mockReturnValue(Promise.resolve(null));
        mockGetPersistedRelaySessionOwner.mockReturnValue(Promise.resolve({ userId: "user-2", runnerId: "runner-A", cwd: "/repo" } as any));

        const [req, url] = makeReq("GET", "/api/runners/runner-A/analysis/sess-1");
        const res = await handleRunnersRoute(req, url);

        expect(res!.status).toBe(403);
        expect(mockSendRunnerCommand).not.toHaveBeenCalled();
    });
});

describe("runner trigger listener routes", () => {
    const seedSpawnRoute = (routeId: string, eventType: string, spec: Record<string, unknown> = {}) => {
        mockRoutes.set(routeId, {
            routeId,
            eventType,
            target: { kind: "spawn", spec: { runnerId: "runner-A", ...spec } },
            deliverAs: "followUp",
            origin: "ui",
            createdAt: new Date().toISOString(),
        });
    };

    beforeEach(() => {
        mockRoutes.clear();
        mockRequireSession.mockReset();
        mockRequireSession.mockReturnValue(Promise.resolve({ userId: "user-1", userName: "TestUser" } as any));
        mockGetRunnerData.mockReset();
        mockGetRunnerData.mockReturnValue(Promise.resolve({ userId: "user-1", runnerId: "runner-A" } as any));
        mockGetRunnerServices.mockReset();
        mockGetRunnerServices.mockReturnValue(Promise.resolve(null));
        mockEmitTriggerSubscriptionDelta.mockReset();
        mockEmitTriggerSubscriptionDelta.mockReturnValue(Promise.resolve());
    });

    test("GET returns listeners mapped from spawn routes", async () => {
        seedSpawnRoute("rt_1", "svc:event", { promptTemplate: "one" });
        seedSpawnRoute("rt_2", "svc:event", { promptTemplate: "two" });

        const [req, url] = makeReq("GET", "/api/runners/runner-A/trigger-listeners");
        const res = await handleRunnersRoute(req, url);
        expect(res!.status).toBe(200);
        const body = await res!.json();
        expect(body.listeners).toHaveLength(2);
        expect(body.listeners[0].listenerId).toBe("rt_1");
        expect(body.listeners[0].triggerType).toBe("svc:event");
        expect(body.listeners[0].prompt).toBe("one");
        expect(body.listeners[1].listenerId).toBe("rt_2");
    });

    test("GET only lists spawn routes for this runner", async () => {
        seedSpawnRoute("rt_1", "svc:event");
        mockRoutes.set("rt_other", {
            routeId: "rt_other",
            eventType: "svc:event",
            target: { kind: "spawn", spec: { runnerId: "runner-B" } },
            deliverAs: "followUp",
            origin: "ui",
            createdAt: new Date().toISOString(),
        });
        mockRoutes.set("rt_sess", {
            routeId: "rt_sess",
            eventType: "svc:event",
            target: { kind: "session", sessionId: "sess-1" },
            deliverAs: "followUp",
            origin: "ui",
            createdAt: new Date().toISOString(),
        });

        const [req, url] = makeReq("GET", "/api/runners/runner-A/trigger-listeners");
        const res = await handleRunnersRoute(req, url);
        const body = await res!.json();
        expect(body.listeners).toHaveLength(1);
        expect(body.listeners[0].listenerId).toBe("rt_1");
    });

    test("POST creates a spawn route and returns its routeId as listenerId (no reconcile delta)", async () => {
        const [req, url] = makeReq("POST", "/api/runners/runner-A/trigger-listeners", {
            triggerType: "svc:event",
            prompt: "Investigate",
            params: { duration: "10m" },
        });
        const res = await handleRunnersRoute(req, url);
        expect(res!.status).toBe(200);
        const body = await res!.json();
        expect(body.ok).toBe(true);
        expect(body.listenerId).toMatch(/^rt_/);
        expect(body.triggerType).toBe("svc:event");
        const created = [...mockRoutes.values()][0];
        expect(created.eventType).toBe("svc:event");
        expect(created.target.kind).toBe("spawn");
        expect(created.target.spec.promptTemplate).toBe("Investigate");
        expect(created.target.spec.ownerUserId).toBe("user-1");
        expect(created.params).toEqual({ duration: "10m" });
        expect(mockEmitTriggerSubscriptionDelta).not.toHaveBeenCalled();
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
        expect(mockRoutes.size).toBe(0);
    });

    test("POST allows a mode-scoped trigger when listener cwd is inside the mode", async () => {
        mockGetRunnerServices.mockReturnValue(Promise.resolve({
            serviceIds: ["reporter"],
            triggerDefs: [{ type: "reporter:daily", label: "Daily", modes: ["work"] }],
            sessionModes: [{ id: "work", label: "Work", workspace: "/home/u/Workspace" }],
        }));

        const [req, url] = makeReq("POST", "/api/runners/runner-A/trigger-listeners", {
            triggerType: "reporter:daily",
            prompt: "Report",
            cwd: "/home/u/Workspace/reports",
        });
        const res = await handleRunnersRoute(req, url);
        expect(res!.status).toBe(200);
        expect((await res!.json()).listenerId).toMatch(/^rt_/);
        expect([...mockRoutes.values()][0].target.spec.cwd).toBe("/home/u/Workspace/reports");
    });

    test("PUT rejects moving a mode-scoped listener's cwd outside the mode", async () => {
        mockGetRunnerServices.mockReturnValue(Promise.resolve({
            serviceIds: ["reporter"],
            triggerDefs: [{ type: "reporter:daily", label: "Daily", modes: ["work"] }],
            sessionModes: [{ id: "work", label: "Work", workspace: "/home/u/Workspace" }],
        }));
        seedSpawnRoute("rt_1", "reporter:daily", { cwd: "/home/u/Workspace/reports" });

        const [req, url] = makeReq("PUT", "/api/runners/runner-A/trigger-listeners/rt_1", {
            cwd: "/home/u/Projects/foo",
        });
        const res = await handleRunnersRoute(req, url);
        expect(res!.status).toBe(422);
        expect(mockRoutes.get("rt_1").target.spec.cwd).toBe("/home/u/Workspace/reports");
    });

    test("PUT updates one listener by id", async () => {
        seedSpawnRoute("rt_1", "svc:event", { promptTemplate: "old" });

        const [req, url] = makeReq("PUT", "/api/runners/runner-A/trigger-listeners/rt_1", {
            prompt: "Updated prompt",
        });
        const res = await handleRunnersRoute(req, url);
        expect(res!.status).toBe(200);
        const body = await res!.json();
        expect(body.ok).toBe(true);
        expect(body.listenerId).toBe("rt_1");
        expect(body.triggerType).toBe("svc:event");
        expect(mockRoutes.get("rt_1").target.spec.promptTemplate).toBe("Updated prompt");
    });

    test("PUT resolves a legacy event-type target to the runner's spawn listener", async () => {
        seedSpawnRoute("rt_1", "linear:project_comment_added", { promptTemplate: "old" });

        const [req, url] = makeReq("PUT", "/api/runners/runner-A/trigger-listeners/linear%3Aproject_comment_added", {
            prompt: "Updated prompt",
        });
        const res = await handleRunnersRoute(req, url);
        expect(res!.status).toBe(200);
        expect((await res!.json()).listenerId).toBe("rt_1");
        expect(mockRoutes.get("rt_1").target.spec.promptTemplate).toBe("Updated prompt");
    });

    test("DELETE removes one listener by route id", async () => {
        seedSpawnRoute("rt_1", "svc:event");

        const [req, url] = makeReq("DELETE", "/api/runners/runner-A/trigger-listeners/rt_1");
        const res = await handleRunnersRoute(req, url);
        expect(res!.status).toBe(200);
        const body = await res!.json();
        expect(body.ok).toBe(true);
        expect(body.listenerId).toBe("rt_1");
        expect(body.triggerType).toBe("svc:event");
        expect(body.removed).toBe(1);
        expect(mockRoutes.size).toBe(0);
    });

    test("DELETE by triggerType removes every spawn listener of that type", async () => {
        seedSpawnRoute("rt_1", "svc:event");
        seedSpawnRoute("rt_2", "svc:event");
        seedSpawnRoute("rt_3", "other:thing");

        const [req, url] = makeReq("DELETE", "/api/runners/runner-A/trigger-listeners/svc:event");
        const res = await handleRunnersRoute(req, url);
        expect(res!.status).toBe(200);
        const body = await res!.json();
        expect(body.triggerType).toBe("svc:event");
        expect(body.removed).toBe(2);
        expect([...mockRoutes.keys()]).toEqual(["rt_3"]);
    });

    test("POST converts params to filters (legacy semantics) while keeping params", async () => {
        const [req, url] = makeReq("POST", "/api/runners/runner-A/trigger-listeners", {
            triggerType: "github:pr_opened",
            params: { repo: "org/repo", titleContains: "WIP" },
        });
        const res = await handleRunnersRoute(req, url);
        expect(res!.status).toBe(200);
        const created = [...mockRoutes.values()][0];
        expect(created.params).toEqual({ repo: "org/repo", titleContains: "WIP" });
        // Without route.filters the engine matches every payload of the type.
        expect(created.filters).toEqual([
            { field: "repo", value: "org/repo", op: "eq" },
            { field: "title", value: "WIP", op: "contains" },
        ]);
    });

    test("POST does not convert time:* params to filters (schedule config, not filters)", async () => {
        const [req, url] = makeReq("POST", "/api/runners/runner-A/trigger-listeners", {
            triggerType: "time:cron",
            params: { cron: "0 9 * * *" },
        });
        const res = await handleRunnersRoute(req, url);
        expect(res!.status).toBe(200);
        const created = [...mockRoutes.values()][0];
        expect(created.params).toEqual({ cron: "0 9 * * *" });
        expect(created.filters).toBeUndefined();
    });

    test("POST writes the prompt to route-level promptTemplate (delivery renders from there)", async () => {
        const [req, url] = makeReq("POST", "/api/runners/runner-A/trigger-listeners", {
            triggerType: "svc:event",
            prompt: "Investigate",
        });
        const res = await handleRunnersRoute(req, url);
        expect(res!.status).toBe(200);
        const created = [...mockRoutes.values()][0];
        expect(created.promptTemplate).toBe("Investigate");
        expect(created.target.spec.promptTemplate).toBe("Investigate"); // backward-compat read path
    });

    test("PUT keeps route.filters in lockstep with params", async () => {
        seedSpawnRoute("rt_1", "github:pr_opened");

        const [req, url] = makeReq("PUT", "/api/runners/runner-A/trigger-listeners/rt_1", {
            params: { repo: "org/repo" },
        });
        const res = await handleRunnersRoute(req, url);
        expect(res!.status).toBe(200);
        const updated = mockRoutes.get("rt_1");
        expect(updated.params).toEqual({ repo: "org/repo" });
        expect(updated.filters).toEqual([{ field: "repo", value: "org/repo", op: "eq" }]);
    });

    test("PUT clears filters when the new params produce none", async () => {
        mockRoutes.set("rt_1", {
            routeId: "rt_1",
            eventType: "github:pr_opened",
            target: { kind: "spawn", spec: { runnerId: "runner-A" } },
            deliverAs: "followUp",
            origin: "ui",
            params: { repo: "org/repo" },
            filters: [{ field: "repo", value: "org/repo", op: "eq" }],
            createdAt: new Date().toISOString(),
        });

        const [req, url] = makeReq("PUT", "/api/runners/runner-A/trigger-listeners/rt_1", {
            params: {},
        });
        const res = await handleRunnersRoute(req, url);
        expect(res!.status).toBe(200);
        expect(mockRoutes.get("rt_1").filters).toBeUndefined();
    });

    test("PUT writes the prompt to route-level promptTemplate", async () => {
        seedSpawnRoute("rt_1", "svc:event", { promptTemplate: "old" });

        const [req, url] = makeReq("PUT", "/api/runners/runner-A/trigger-listeners/rt_1", {
            prompt: "Updated prompt",
        });
        const res = await handleRunnersRoute(req, url);
        expect(res!.status).toBe(200);
        const updated = mockRoutes.get("rt_1");
        expect(updated.promptTemplate).toBe("Updated prompt");
        expect(updated.target.spec.promptTemplate).toBe("Updated prompt");
    });

    test("DELETE by triggerType leaves webhook and config routes alone (candidates pre-validated before any delete)", async () => {
        // Config routes make deleteRoute throw — seeded FIRST so an
        // unvalidated delete loop would abort before reaching the listener.
        mockRoutes.set("rt_cfg", {
            routeId: "rt_cfg",
            eventType: "svc:event",
            target: { kind: "spawn", spec: { runnerId: "runner-A" } },
            deliverAs: "followUp",
            origin: "config",
            createdAt: new Date().toISOString(),
        });
        seedSpawnRoute("rt_wh_wh-9", "svc:event");
        seedSpawnRoute("rt_listener", "svc:event");

        const [req, url] = makeReq("DELETE", "/api/runners/runner-A/trigger-listeners/svc:event");
        const res = await handleRunnersRoute(req, url);
        expect(res!.status).toBe(200);
        const body = await res!.json();
        expect(body.removed).toBe(1);
        expect(body.listenerId).toBe("rt_listener");
        expect(mockRoutes.has("rt_wh_wh-9")).toBe(true);
        expect(mockRoutes.has("rt_cfg")).toBe(true);
        expect(mockRoutes.has("rt_listener")).toBe(false);
    });

    test("DELETE by route id removes nothing when the id is a webhook route", async () => {
        seedSpawnRoute("rt_wh_wh-1", "webhook:thing");

        const [req, url] = makeReq("DELETE", "/api/runners/runner-A/trigger-listeners/rt_wh_wh-1");
        const res = await handleRunnersRoute(req, url);
        expect(res!.status).toBe(200);
        const body = await res!.json();
        expect(body.removed).toBe(0);
        expect(mockRoutes.has("rt_wh_wh-1")).toBe(true);
    });
});

describe("runner trigger fire route", () => {
    const seedOwnedRoute = (routeId: string, ownerUserId = "user-1", extra: Record<string, unknown> = {}) => {
        mockRoutes.set(routeId, {
            routeId,
            eventType: "svc:event",
            target: { kind: "spawn", spec: { runnerId: "runner-A", ownerUserId } },
            deliverAs: "followUp",
            origin: "ui",
            ownerUserId,
            createdAt: new Date().toISOString(),
            ...extra,
        });
    };
    const seedSchema = (schema: Record<string, unknown>) => {
        mockGetRunnerServices.mockReturnValue(Promise.resolve({
            serviceIds: ["svc"],
            triggerDefs: [{ type: "svc:event", label: "Event", schema }],
        } as any));
    };

    beforeEach(() => {
        mockRoutes.clear();
        mockRequireSession.mockReset();
        mockRequireSession.mockReturnValue(Promise.resolve({ userId: "user-1", userName: "TestUser" } as any));
        mockGetRunnerData.mockReset();
        mockGetRunnerData.mockReturnValue(Promise.resolve({ userId: "user-1", runnerId: "runner-A" } as any));
        mockGetRunnerServices.mockReset();
        mockGetRunnerServices.mockReturnValue(Promise.resolve(null));
        mockPublishEvent.mockReset();
        mockPublishEvent.mockReturnValue(Promise.resolve({ event: { eventId: "event-test" } }));
        mockSendRunnerServiceRequest.mockReset();
        mockSendRunnerServiceRequest.mockImplementation(() => Promise.reject(new Error("unsupported")));
    });

    test("fires a persisted route by id, passing the payload and targeting only that route", async () => {
        seedOwnedRoute("rt_1");
        seedSchema({ type: "object", required: ["repo"], properties: { repo: { type: "string" }, count: { type: "integer" } } });

        const [req, url] = makeReq("POST", "/api/runners/runner-A/trigger-listeners/rt_1/fire", {
            payload: { repo: "org/repo", count: 3 },
        });
        const res = await handleRunnersRoute(req, url);
        expect(res!.status).toBe(200);
        expect(await res!.json()).toEqual({ ok: true, eventId: "event-test" });
        expect(mockPublishEvent).toHaveBeenCalledWith(
            { type: "svc:event", payload: { repo: "org/repo", count: 3 }, routeIds: ["rt_1"] },
            expect.objectContaining({ kind: "api", userId: "user-1" }),
            expect.anything(),
        );
    });

    test("fire stays available for persisted routes when the runner runtime is unreachable (state unknown)", async () => {
        seedOwnedRoute("rt_1");
        // Runtime status lookup rejects (offline/unsupported runner) — the
        // saved route is still persisted and fireable.
        mockSendRunnerServiceRequest.mockImplementation(() => Promise.reject(new Error("offline")));

        const [listReq, listUrl] = makeReq("GET", "/api/runners/runner-A/trigger-listeners");
        const listRes = await handleRunnersRoute(listReq, listUrl);
        const listBody = await listRes!.json();
        expect(listBody.listeners[0].runtime.state).toBe("unknown");

        const [req, url] = makeReq("POST", "/api/runners/runner-A/trigger-listeners/rt_1/fire", { payload: {} });
        const res = await handleRunnersRoute(req, url);
        expect(res!.status).toBe(200);
        expect(mockPublishEvent).toHaveBeenCalled();
    });

    test("asks the route's owning service (not just time) for runtime status", async () => {
        seedOwnedRoute("rt_1");
        mockSendRunnerServiceRequest.mockImplementation(((_runner: string, serviceId: string, type: string) =>
            serviceId === "svc" && type === "trigger_status_request"
                ? Promise.resolve({ subscriptions: [{ subscriptionId: "rt_1", state: "armed" }] })
                : Promise.reject(new Error("unsupported"))) as any);

        const [req, url] = makeReq("GET", "/api/runners/runner-A/trigger-listeners");
        const body = await (await handleRunnersRoute(req, url))!.json();
        expect(body.listeners[0].runtime.state).toBe("confirmed");
    });

    test("blocks firing a disabled route (409)", async () => {
        seedOwnedRoute("rt_1", "user-1", { disabled: true });

        const [req, url] = makeReq("POST", "/api/runners/runner-A/trigger-listeners/rt_1/fire", { payload: {} });
        const res = await handleRunnersRoute(req, url);
        expect(res!.status).toBe(409);
        expect(mockPublishEvent).not.toHaveBeenCalled();
    });

    test("rejects a payload that is not an object (400)", async () => {
        seedOwnedRoute("rt_1");

        const [req, url] = makeReq("POST", "/api/runners/runner-A/trigger-listeners/rt_1/fire", { payload: [1, 2] });
        const res = await handleRunnersRoute(req, url);
        expect(res!.status).toBe(400);
        expect(mockPublishEvent).not.toHaveBeenCalled();
    });

    test("rejects a payload missing a required field (400)", async () => {
        seedOwnedRoute("rt_1");
        seedSchema({ type: "object", required: ["repo"], properties: { repo: { type: "string" } } });

        const [req, url] = makeReq("POST", "/api/runners/runner-A/trigger-listeners/rt_1/fire", { payload: {} });
        const res = await handleRunnersRoute(req, url);
        expect(res!.status).toBe(400);
        expect((await res!.json()).error).toContain("repo");
        expect(mockPublishEvent).not.toHaveBeenCalled();
    });

    test("rejects a payload whose declared top-level field type mismatches (400)", async () => {
        seedOwnedRoute("rt_1");
        seedSchema({ type: "object", properties: { repo: { type: "string" }, count: { type: "integer" } } });

        const [req, url] = makeReq("POST", "/api/runners/runner-A/trigger-listeners/rt_1/fire", { payload: { repo: 42 } });
        const res = await handleRunnersRoute(req, url);
        expect(res!.status).toBe(400);
        expect((await res!.json()).error).toContain("repo");

        const [req2, url2] = makeReq("POST", "/api/runners/runner-A/trigger-listeners/rt_1/fire", { payload: { count: 1.5 } });
        const res2 = await handleRunnersRoute(req2, url2);
        expect(res2!.status).toBe(400);
        expect((await res2!.json()).error).toContain("count");
        expect(mockPublishEvent).not.toHaveBeenCalled();
    });

    test("fires with no registered trigger schema (unknown payloads pass)", async () => {
        seedOwnedRoute("rt_1");
        // catalog null → no schema → only the object-shape check applies

        const [req, url] = makeReq("POST", "/api/runners/runner-A/trigger-listeners/rt_1/fire", { payload: { anything: true } });
        const res = await handleRunnersRoute(req, url);
        expect(res!.status).toBe(200);
        expect(mockPublishEvent).toHaveBeenCalledWith(
            expect.objectContaining({ payload: { anything: true } }),
            expect.anything(),
            expect.anything(),
        );
    });

    test("ownership rejection: another user's route is not fireable (404)", async () => {
        seedOwnedRoute("rt_1", "user-2");

        const [req, url] = makeReq("POST", "/api/runners/runner-A/trigger-listeners/rt_1/fire", { payload: {} });
        const res = await handleRunnersRoute(req, url);
        expect(res!.status).toBe(404);
        expect(mockPublishEvent).not.toHaveBeenCalled();
    });
});

describe("session-owned routes on the listener surface", () => {
    const seedSessionRoute = (routeId: string, ownerUserId = "user-1", extra: Record<string, unknown> = {}) => {
        mockRoutes.set(routeId, {
            routeId,
            eventType: "svc:event",
            target: { kind: "session", sessionId: "sess-1", runnerId: "runner-A" },
            deliverAs: "followUp",
            origin: "agent",
            ownerUserId,
            createdAt: new Date().toISOString(),
            ...extra,
        });
    };

    beforeEach(() => {
        mockRoutes.clear();
        mockRequireSession.mockReset();
        mockRequireSession.mockReturnValue(Promise.resolve({ userId: "user-1", userName: "TestUser" } as any));
        mockGetRunnerData.mockReset();
        mockGetRunnerData.mockReturnValue(Promise.resolve({ userId: "user-1", runnerId: "runner-A" } as any));
        mockGetRunnerServices.mockReset();
        mockGetRunnerServices.mockReturnValue(Promise.resolve(null));
        mockGetSession.mockReset();
        mockGetSession.mockReturnValue(Promise.resolve(null));
        mockGetPersistedRelaySessionOwner.mockReset();
        mockGetPersistedRelaySessionOwner.mockReturnValue(Promise.resolve(null));
        mockPublishEvent.mockReset();
        mockPublishEvent.mockReturnValue(Promise.resolve({ event: { eventId: "event-test" } }));
    });

    test("GET lists session routes with their owning session and owned flag", async () => {
        seedSessionRoute("rt_mine", "user-1");
        seedSessionRoute("rt_theirs", "user-2");

        const [req, url] = makeReq("GET", "/api/runners/runner-A/trigger-listeners");
        const res = await handleRunnersRoute(req, url);
        expect(res!.status).toBe(200);
        const body = await res!.json();
        expect(body.listeners).toHaveLength(2);
        const mine = body.listeners.find((l: any) => l.listenerId === "rt_mine");
        const theirs = body.listeners.find((l: any) => l.listenerId === "rt_theirs");
        expect(mine.ownerSessionId).toBe("sess-1");
        expect(mine.owned).toBe(true);
        expect(theirs.owned).toBe(false);
    });

    test("PUT disables an owned session route by route id", async () => {
        seedSessionRoute("rt_mine");

        const [req, url] = makeReq("PUT", "/api/runners/runner-A/trigger-listeners/rt_mine", { disabled: true });
        const res = await handleRunnersRoute(req, url);
        expect(res!.status).toBe(200);
        const body = await res!.json();
        expect(body.ok).toBe(true);
        expect(body.disabled).toBe(true);
        expect(mockRoutes.get("rt_mine").disabled).toBe(true);
        expect(mockRoutes.get("rt_mine").target.kind).toBe("session");
    });

    test("PUT re-enables a disabled session route", async () => {
        seedSessionRoute("rt_mine", "user-1", { disabled: true });

        const [req, url] = makeReq("PUT", "/api/runners/runner-A/trigger-listeners/rt_mine", { disabled: false });
        const res = await handleRunnersRoute(req, url);
        expect(res!.status).toBe(200);
        expect((await res!.json()).disabled).toBe(false);
        expect(mockRoutes.get("rt_mine").disabled).toBe(false);
    });

    test("PUT on another user's session route is rejected (403) and the route is untouched", async () => {
        seedSessionRoute("rt_theirs", "user-2");

        const [req, url] = makeReq("PUT", "/api/runners/runner-A/trigger-listeners/rt_theirs", { disabled: true });
        const res = await handleRunnersRoute(req, url);
        expect(res!.status).toBe(403);
        expect(mockRoutes.get("rt_theirs").disabled).toBeUndefined();
    });

    test("PUT rejects spawn-only field edits on a session route (400)", async () => {
        seedSessionRoute("rt_mine");

        const [req, url] = makeReq("PUT", "/api/runners/runner-A/trigger-listeners/rt_mine", { prompt: "rewrite history" });
        const res = await handleRunnersRoute(req, url);
        expect(res!.status).toBe(400);
        expect(mockRoutes.get("rt_mine").target.spec).toBeUndefined();
    });

    test("PUT without a disabled field on a session route is rejected (400)", async () => {
        seedSessionRoute("rt_mine");

        const [req, url] = makeReq("PUT", "/api/runners/runner-A/trigger-listeners/rt_mine", {});
        const res = await handleRunnersRoute(req, url);
        expect(res!.status).toBe(400);
    });

    test("DELETE removes an owned session route by id", async () => {
        seedSessionRoute("rt_mine");

        const [req, url] = makeReq("DELETE", "/api/runners/runner-A/trigger-listeners/rt_mine");
        const res = await handleRunnersRoute(req, url);
        expect(res!.status).toBe(200);
        const body = await res!.json();
        expect(body.removed).toBe(1);
        expect(mockRoutes.size).toBe(0);
    });

    test("DELETE on another user's session route is rejected (403)", async () => {
        seedSessionRoute("rt_theirs", "user-2");

        const [req, url] = makeReq("DELETE", "/api/runners/runner-A/trigger-listeners/rt_theirs");
        const res = await handleRunnersRoute(req, url);
        expect(res!.status).toBe(403);
        expect(mockRoutes.has("rt_theirs")).toBe(true);
    });

    test("PUT disables a spawn listener too (same toggle for both kinds)", async () => {
        mockRoutes.set("rt_spawn", {
            routeId: "rt_spawn",
            eventType: "svc:event",
            target: { kind: "spawn", spec: { runnerId: "runner-A", promptTemplate: "keep" } },
            deliverAs: "followUp",
            origin: "ui",
            createdAt: new Date().toISOString(),
        });

        const [req, url] = makeReq("PUT", "/api/runners/runner-A/trigger-listeners/rt_spawn", { disabled: true });
        const res = await handleRunnersRoute(req, url);
        expect(res!.status).toBe(200);
        const route = mockRoutes.get("rt_spawn");
        expect(route.disabled).toBe(true);
        // A disable-only PUT must not rewrite the spawn spec.
        expect(route.target.spec.promptTemplate).toBe("keep");
    });
});

describe("listener delivery history", () => {
    beforeEach(() => {
        mockRoutes.clear();
        mockRequireSession.mockReset();
        mockRequireSession.mockReturnValue(Promise.resolve({ userId: "user-1", userName: "TestUser" } as any));
        mockGetRunnerData.mockReset();
        mockGetRunnerData.mockReturnValue(Promise.resolve({ userId: "user-1", runnerId: "runner-A" } as any));
        mockGetRunnerServices.mockReset();
        mockGetRunnerServices.mockReturnValue(Promise.resolve(null));
        mockListDeliveries.mockReset();
        mockListDeliveries.mockReturnValue(Promise.resolve([]));
        mockEventsForIds.mockReset();
        mockEventsForIds.mockReturnValue(Promise.resolve([]));
    });

    test("GET attaches recent deliveries per listener with outcome, time, and session", async () => {
        mockRoutes.set("rt_1", {
            routeId: "rt_1",
            eventType: "svc:event",
            target: { kind: "spawn", spec: { runnerId: "runner-A" } },
            deliverAs: "followUp",
            origin: "ui",
            createdAt: new Date().toISOString(),
        });
        mockListDeliveries.mockReturnValue(Promise.resolve([
            { deliveryId: "d2", eventId: "e2", routeId: "rt_1", status: "pending", sessionId: "sess-b", createdAt: "2026-04-03T00:02:00.000Z" },
            { deliveryId: "d1", eventId: "e1", routeId: "rt_1", status: "delivered", sessionId: "sess-a", createdAt: "2026-04-03T00:01:00.000Z" },
            { deliveryId: "d_other", eventId: "e3", routeId: "rt_x", status: "delivered", sessionId: "sess-c", createdAt: "2026-04-03T00:03:00.000Z" },
        ]));
        mockEventsForIds.mockReturnValue(Promise.resolve([{ eventId: "e1", type: "svc:event" }, { eventId: "e2", type: "svc:event" }] as any));

        const [req, url] = makeReq("GET", "/api/runners/runner-A/trigger-listeners");
        const res = await handleRunnersRoute(req, url);
        expect(res!.status).toBe(200);
        const body = await res!.json();
        expect(body.listeners).toHaveLength(1);
        const history = body.listeners[0].history;
        expect(history).toHaveLength(2);
        expect(history[0]).toEqual({
            deliveryId: "d2", eventId: "e2", status: "pending", sessionId: "sess-b",
            eventType: "svc:event", createdAt: "2026-04-03T00:02:00.000Z",
        });
        expect(history[1].deliveryId).toBe("d1");
    });
});

describe("runner spawn effort", () => {
    beforeEach(() => {
        mockRequireSession.mockReset();
        mockRequireSession.mockReturnValue(Promise.resolve({ userId: "user-1", userName: "TestUser" } as any));
        mockGetRunnerData.mockReset();
        mockGetRunnerData.mockReturnValue(Promise.resolve({ userId: "user-1", runnerId: "runner-A" } as any));
        mockGetLocalRunnerSocket.mockReset();
    });

    test("forwards a valid effort to the runner worker", async () => {
        const emit = mock(() => {});
        mockGetLocalRunnerSocket.mockReturnValue({ emit } as any);

        const [req, url] = makeReq("POST", "/api/runners/spawn", {
            runnerId: "runner-A",
            prompt: "do the thing",
            effort: "high",
        });
        const res = await handleRunnersRoute(req, url);

        expect(res!.status).toBe(200);
        expect(emit).toHaveBeenCalledWith("new_session", expect.objectContaining({ effort: "high" }));
    });

    test("rejects an unsupported effort before contacting the runner", async () => {
        const [req, url] = makeReq("POST", "/api/runners/spawn", {
            runnerId: "runner-A",
            effort: "turbo",
        });
        const res = await handleRunnersRoute(req, url);

        expect(res!.status).toBe(400);
        expect(mockGetLocalRunnerSocket).not.toHaveBeenCalled();
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
