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
