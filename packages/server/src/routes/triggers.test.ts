/**
 * Tests for the HTTP Trigger API route.
 *
 * Tests the route handler logic with mocked dependencies (Redis, SIO registry).
 */

import { describe, test, expect, beforeEach, afterEach, afterAll, mock, spyOn } from "bun:test";

afterAll(() => mock.restore());

// ── Mock sio-registry ────────────────────────────────────────────────────
const mockGetSharedSession = mock((_id: string) => Promise.resolve(null as any));
const mockGetLocalTuiSocket = mock((_id: string) => null as any);
const mockEmitToRelaySessionVerified = mock((_id: string, _event: string, _data: any) => Promise.resolve(false));
const mockBroadcastToSessionViewers = mock((_sid: string, _event: string, _data: any) => {});

const mockRecordRunnerSession = mock((_runnerId: string, _sessionId: string) => Promise.resolve());
const mockGetLocalRunnerSocket = mock((_runnerId: string) => null as any);
// The wake goes through emitToRunner (per-runner room) so it reaches a runner
// attached to any relay node, not just this one.
const mockEmitToRunnerCalls: Array<[string, string, any]> = [];
const mockEmitToRunner = mock((runnerId: string, event: string, data: any) => {
    mockEmitToRunnerCalls.push([runnerId, event, data]);
});
const mockLinkSessionToRunner = mock((_runnerId: string, _sessionId: string) => Promise.resolve());

mock.module("../ws/sio-registry.js", () => ({
    getSharedSession: mockGetSharedSession,
    getLocalTuiSocket: mockGetLocalTuiSocket,
    waitForLocalTuiSocket: mock(async (id: string) => !!mockGetLocalTuiSocket(id)?.connected),
    emitToRelaySessionVerified: mockEmitToRelaySessionVerified,
    broadcastToSessionViewers: mockBroadcastToSessionViewers,
    recordRunnerSession: mockRecordRunnerSession,
    getLocalRunnerSocket: mockGetLocalRunnerSocket,
    emitToRunner: mockEmitToRunner,
    linkSessionToRunner: mockLinkSessionToRunner,
    emitToRelaySession: mock((_id: string, _event: string, _data: any) => Promise.resolve(false)),
    getTerminalEntry: mock((_id: string) => Promise.resolve(null as any)),
}));


mock.module("../ws/runner-control.js", () => ({
    waitForSpawnAck: mock(() => Promise.resolve({ ok: true })),
}));

// Captured so tests can assert the runner is told about subscription changes
// (the delta is what disarms a live timer/cron on the daemon).
const mockEmitDeltaCalls: Array<[string, any]> = [];
mock.module("../ws/namespaces/runner.js", () => ({
    emitTriggerSubscriptionDelta: mock((runnerId: string, delta: any) => {
        mockEmitDeltaCalls.push([runnerId, delta]);
        return Promise.resolve();
    }),
}));

// ── Mock middleware ──────────────────────────────────────────────────────
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

// ── Mock trigger store ───────────────────────────────────────────────────
const mockPushTriggerHistory = mock((_sid: string, _entry: any) => Promise.resolve());
const mockGetTriggerHistory = mock((_sid: string, _limit?: number) => Promise.resolve([] as any[]));
const mockClearTriggerHistory = mock((_sid: string) => Promise.resolve());
mock.module("../sessions/trigger-store.js", () => ({
    pushTriggerHistory: mockPushTriggerHistory,
    getTriggerHistory: mockGetTriggerHistory,
    clearTriggerHistory: mockClearTriggerHistory,
}));

// ── Mock runners registry + stores via spyOn to avoid cross-file poison ──
import * as _runnersModule from "../ws/sio-registry/runners.js";
import * as _sessionStoreModule from "../sessions/store.js";
let mockGetRunnerServices: ReturnType<typeof spyOn>;
let mockGetRunnerData: ReturnType<typeof spyOn>;
let spyGetPersistedRelaySessionOwner: ReturnType<typeof spyOn>;

// Persisted-session fallback used by the subscription routes and the wake path.
// Defaults to "no persisted session" so existing not-found cases still 404.
const mockGetPersistedRelaySessionOwner = mock((_sid: string) => Promise.resolve(null as any));

beforeEach(() => {
    mockGetRunnerServices = spyOn(_runnersModule, "getRunnerServices")
        .mockImplementation((_rid: string) => Promise.resolve(null as any));
    mockGetRunnerData = spyOn(_runnersModule, "getRunnerData")
        .mockImplementation((_rid: string) => Promise.resolve({ userId: "user-1", runnerId: "runner-A" } as any));



    spyGetPersistedRelaySessionOwner = spyOn(_sessionStoreModule, "getPersistedRelaySessionOwner").mockImplementation(mockGetPersistedRelaySessionOwner as any);
});

afterEach(() => {
    mockGetRunnerServices.mockRestore();
    mockGetRunnerData.mockRestore();
    spyGetPersistedRelaySessionOwner.mockRestore();
});

// ── Mock logger ──────────────────────────────────────────────────────────
// NOTE: @pizzapi/tools mock removed — log calls in tests are harmless,
// and mock.module("@pizzapi/tools") poisons every other test file's logger.

// Import route handler — uses real modules, spyOn overrides individual functions.
const { handleTriggersRoute } = await import("./triggers.js");

function makeReq(
    method: string,
    path: string,
    body?: object,
    headers?: Record<string, string>,
): [Request, URL] {
    const url = new URL(`http://localhost${path}`);
    const init: RequestInit = {
        method,
        headers: { "content-type": "application/json", ...headers },
    };
    if (body) init.body = JSON.stringify(body);
    return [new Request(url.toString(), init), url];
}

describe("GET /api/sessions/:id/triggers", () => {
    beforeEach(() => {
        mockGetSharedSession.mockReset();
        mockGetTriggerHistory.mockReset();
        mockRequireSession.mockReturnValue(
            Promise.resolve({ userId: "user-1", userName: "TestUser" }),
        );
    });

    test("returns trigger history", async () => {
        mockGetSharedSession.mockReturnValue(
            Promise.resolve({ userId: "user-1", sessionId: "sess-1" } as any),
        );
        mockGetTriggerHistory.mockReturnValue(
            Promise.resolve([
                {
                    triggerId: "ext_abc123",
                    type: "webhook",
                    source: "github",
                    payload: { event: "push" },
                    deliverAs: "steer" as const,
                    ts: "2026-03-27T00:00:00Z",
                    direction: "inbound" as const,
                },
            ] as any[]),
        );

        const [req, url] = makeReq("GET", "/api/sessions/sess-1/triggers");
        const res = await handleTriggersRoute(req, url);
        expect(res).toBeDefined();
        expect(res!.status).toBe(200);
        const body = await res!.json();
        expect(body.triggers).toHaveLength(1);
        expect(body.triggers[0].triggerId).toBe("ext_abc123");
    });

    test("returns 404 for wrong user", async () => {
        mockGetSharedSession.mockReturnValue(
            Promise.resolve({ userId: "user-2", sessionId: "sess-1" } as any),
        );

        const [req, url] = makeReq("GET", "/api/sessions/sess-1/triggers");
        const res = await handleTriggersRoute(req, url);
        expect(res!.status).toBe(404);
    });

    test("returns empty array when no history", async () => {
        mockGetSharedSession.mockReturnValue(
            Promise.resolve({ userId: "user-1", sessionId: "sess-1" } as any),
        );
        mockGetTriggerHistory.mockReturnValue(Promise.resolve([]));

        const [req, url] = makeReq("GET", "/api/sessions/sess-1/triggers");
        const res = await handleTriggersRoute(req, url);
        expect(res!.status).toBe(200);
        const body = await res!.json();
        expect(body.triggers).toHaveLength(0);
    });
});

describe("DELETE /api/sessions/:id/triggers", () => {
    beforeEach(() => {
        mockGetSharedSession.mockReset();
        mockClearTriggerHistory.mockReset();
        mockBroadcastToSessionViewers.mockReset();
        mockRequireSession.mockReturnValue(
            Promise.resolve({ userId: "user-1", userName: "TestUser" }),
        );
    });

    test("clears trigger history for the session", async () => {
        mockGetSharedSession.mockReturnValue(
            Promise.resolve({ userId: "user-1", sessionId: "sess-1" } as any),
        );

        const [req, url] = makeReq("DELETE", "/api/sessions/sess-1/triggers");
        const res = await handleTriggersRoute(req, url);
        expect(res!.status).toBe(200);
        const body = await res!.json();
        expect(body.ok).toBe(true);
        expect(mockClearTriggerHistory).toHaveBeenCalledWith("sess-1");
        expect(mockBroadcastToSessionViewers).toHaveBeenCalled();
    });

    test("returns 404 for wrong user", async () => {
        mockGetSharedSession.mockReturnValue(
            Promise.resolve({ userId: "other-user", sessionId: "sess-1" } as any),
        );

        const [req, url] = makeReq("DELETE", "/api/sessions/sess-1/triggers");
        const res = await handleTriggersRoute(req, url);
        expect(res!.status).toBe(404);
    });
});

describe("GET /api/sessions/:id/available-triggers", () => {
    beforeEach(() => {
        mockGetSharedSession.mockReset();
        mockGetRunnerServices.mockReset();
        mockRequireSession.mockReturnValue(
            Promise.resolve({ userId: "user-1", userName: "TestUser" }),
        );
    });

    test("returns triggerDefs from the session's runner", async () => {
        mockGetSharedSession.mockReturnValue(
            Promise.resolve({ userId: "user-1", sessionId: "sess-1", runnerId: "runner-A" } as any),
        );
        mockGetRunnerServices.mockReturnValue(Promise.resolve({
            serviceIds: ["godmother"],
            triggerDefs: [
                { type: "godmother:idea_moved", label: "Idea Status Changed" },
                { type: "godmother:idea_created", label: "Idea Created" },
            ],
        }));

        const [req, url] = makeReq("GET", "/api/sessions/sess-1/available-triggers");
        const res = await handleTriggersRoute(req, url);
        expect(res).toBeDefined();
        expect(res!.status).toBe(200);
        const body = await res!.json();
        expect(body.triggerDefs).toHaveLength(2);
        expect(body.triggerDefs[0].type).toBe("godmother:idea_moved");
    });

    test("returns empty array when session has no runner", async () => {
        mockGetSharedSession.mockReturnValue(
            Promise.resolve({ userId: "user-1", sessionId: "sess-1", runnerId: null } as any),
        );

        const [req, url] = makeReq("GET", "/api/sessions/sess-1/available-triggers");
        const res = await handleTriggersRoute(req, url);
        expect(res!.status).toBe(200);
        const body = await res!.json();
        expect(body.triggerDefs).toHaveLength(0);
    });

    test("returns 404 for wrong user", async () => {
        mockGetSharedSession.mockReturnValue(
            Promise.resolve({ userId: "user-2", sessionId: "sess-1" } as any),
        );

        const [req, url] = makeReq("GET", "/api/sessions/sess-1/available-triggers");
        const res = await handleTriggersRoute(req, url);
        expect(res!.status).toBe(404);
    });

    test("returns empty array when runner has no trigger defs", async () => {
        mockGetSharedSession.mockReturnValue(
            Promise.resolve({ userId: "user-1", sessionId: "sess-1", runnerId: "runner-A" } as any),
        );
        mockGetRunnerServices.mockReturnValue(Promise.resolve({ serviceIds: ["terminal"] }));

        const [req, url] = makeReq("GET", "/api/sessions/sess-1/available-triggers");
        const res = await handleTriggersRoute(req, url);
        expect(res!.status).toBe(200);
        const body = await res!.json();
        expect(body.triggerDefs).toHaveLength(0);
    });

    test("filters mode-scoped trigger defs by the session's cwd", async () => {
        const catalog = {
            serviceIds: ["reporter"],
            triggerDefs: [
                { type: "reporter:daily", label: "Daily", modes: ["work"] },
                { type: "godmother:idea_moved", label: "Idea Moved" },
            ],
            sessionModes: [{ id: "work", label: "Work", workspace: "/home/u/Workspace" }],
        };
        mockGetRunnerServices.mockReturnValue(Promise.resolve(catalog));

        // Out-of-mode session only sees the unscoped trigger.
        mockGetSharedSession.mockReturnValue(
            Promise.resolve({ userId: "user-1", sessionId: "sess-1", runnerId: "runner-A", cwd: "/home/u/Projects/foo" } as any),
        );
        let [req, url] = makeReq("GET", "/api/sessions/sess-1/available-triggers");
        let body = await (await handleTriggersRoute(req, url))!.json();
        expect(body.triggerDefs.map((d: any) => d.type)).toEqual(["godmother:idea_moved"]);

        // In-mode session sees both.
        mockGetSharedSession.mockReturnValue(
            Promise.resolve({ userId: "user-1", sessionId: "sess-1", runnerId: "runner-A", cwd: "/home/u/Workspace/reports" } as any),
        );
        [req, url] = makeReq("GET", "/api/sessions/sess-1/available-triggers");
        body = await (await handleTriggersRoute(req, url))!.json();
        expect(body.triggerDefs).toHaveLength(2);
    });
});

describe("GET /api/sessions/:id/available-sigils", () => {
    beforeEach(() => {
        mockGetSharedSession.mockReset();
        mockGetRunnerServices.mockReset();
        mockRequireSession.mockReturnValue(
            Promise.resolve({ userId: "user-1", userName: "TestUser" }),
        );
    });

    test("returns sigilDefs from the session's runner", async () => {
        mockGetSharedSession.mockReturnValue(
            Promise.resolve({ userId: "user-1", sessionId: "sess-1", runnerId: "runner-A" } as any),
        );
        mockGetRunnerServices.mockReturnValue(Promise.resolve({
            serviceIds: ["github"],
            sigilDefs: [
                { type: "pr", label: "Pull Request", aliases: ["mr"] },
                { type: "commit", label: "Commit" },
            ],
        }));

        const [req, url] = makeReq("GET", "/api/sessions/sess-1/available-sigils");
        const res = await handleTriggersRoute(req, url);
        expect(res).toBeDefined();
        expect(res!.status).toBe(200);
        const body = await res!.json();
        expect(body.sigilDefs).toHaveLength(2);
        expect(body.sigilDefs[0].type).toBe("pr");
        expect(body.sigilDefs[0].aliases).toEqual(["mr"]);
    });

    test("returns empty array when session has no runner", async () => {
        mockGetSharedSession.mockReturnValue(
            Promise.resolve({ userId: "user-1", sessionId: "sess-1", runnerId: null } as any),
        );

        const [req, url] = makeReq("GET", "/api/sessions/sess-1/available-sigils");
        const res = await handleTriggersRoute(req, url);
        expect(res!.status).toBe(200);
        const body = await res!.json();
        expect(body.sigilDefs).toHaveLength(0);
    });

    test("returns 404 for wrong user", async () => {
        mockGetSharedSession.mockReturnValue(
            Promise.resolve({ userId: "user-2", sessionId: "sess-1" } as any),
        );

        const [req, url] = makeReq("GET", "/api/sessions/sess-1/available-sigils");
        const res = await handleTriggersRoute(req, url);
        expect(res!.status).toBe(404);
    });

    test("returns empty array when runner has no sigil defs", async () => {
        mockGetSharedSession.mockReturnValue(
            Promise.resolve({ userId: "user-1", sessionId: "sess-1", runnerId: "runner-A" } as any),
        );
        mockGetRunnerServices.mockReturnValue(Promise.resolve({ serviceIds: ["terminal"] }));

        const [req, url] = makeReq("GET", "/api/sessions/sess-1/available-sigils");
        const res = await handleTriggersRoute(req, url);
        expect(res!.status).toBe(200);
        const body = await res!.json();
        expect(body.sigilDefs).toHaveLength(0);
    });
});

describe("POST /api/sessions/:id/model", () => {
    const collabSession = (userId = "user-1") => ({ userId, sessionId: "sess-1", collabMode: true } as any);

    beforeEach(() => {
        mockGetSharedSession.mockReset();
        mockGetLocalTuiSocket.mockReset();
        mockEmitToRelaySessionVerified.mockReset();
        mockEmitToRelaySessionVerified.mockReturnValue(Promise.resolve(false));
        mockValidateApiKey.mockReturnValue(Promise.resolve({ userId: "user-1", userName: "TestUser" }));
        mockRequireSession.mockReturnValue(Promise.resolve({ userId: "user-1", userName: "TestUser" }));
    });

    test("switches the model via the local TUI socket using an API key", async () => {
        mockGetSharedSession.mockReturnValue(Promise.resolve(collabSession()));
        const emitMock = mock(() => {});
        mockGetLocalTuiSocket.mockReturnValue({ connected: true, emit: emitMock });

        const [req, url] = makeReq(
            "POST", "/api/sessions/sess-1/model",
            { provider: "anthropic", modelId: "claude-sonnet-5" },
            { "x-api-key": "test-key" },
        );
        const res = await handleTriggersRoute(req, url);
        expect(res?.status).toBe(200);
        expect(emitMock).toHaveBeenCalledTimes(1);
        const args = emitMock.mock.calls[0] as any[];
        expect(args[0]).toBe("model_set");
        expect(args[1]).toEqual({ provider: "anthropic", modelId: "claude-sonnet-5" });
    });

    test("trims whitespace around provider and modelId", async () => {
        mockGetSharedSession.mockReturnValue(Promise.resolve(collabSession()));
        const emitMock = mock(() => {});
        mockGetLocalTuiSocket.mockReturnValue({ connected: true, emit: emitMock });

        const [req, url] = makeReq(
            "POST", "/api/sessions/sess-1/model",
            { provider: "  anthropic ", modelId: " claude-sonnet-5  " },
            { "x-api-key": "test-key" },
        );
        await handleTriggersRoute(req, url);
        expect((emitMock.mock.calls[0] as any[])[1]).toEqual({ provider: "anthropic", modelId: "claude-sonnet-5" });
    });

    test("falls back to cross-node delivery when there is no local socket", async () => {
        mockGetSharedSession.mockReturnValue(Promise.resolve(collabSession()));
        mockGetLocalTuiSocket.mockReturnValue(null);
        mockEmitToRelaySessionVerified.mockReturnValue(Promise.resolve(true));

        const [req, url] = makeReq(
            "POST", "/api/sessions/sess-1/model",
            { provider: "anthropic", modelId: "claude-sonnet-5" },
            { "x-api-key": "test-key" },
        );
        const res = await handleTriggersRoute(req, url);
        expect(res?.status).toBe(200);
        expect(mockEmitToRelaySessionVerified).toHaveBeenCalled();
    });

    test("returns 503 when the session is registered but unreachable", async () => {
        mockGetSharedSession.mockReturnValue(Promise.resolve(collabSession()));
        mockGetLocalTuiSocket.mockReturnValue(null);
        mockEmitToRelaySessionVerified.mockReturnValue(Promise.resolve(false));

        const [req, url] = makeReq(
            "POST", "/api/sessions/sess-1/model",
            { provider: "anthropic", modelId: "claude-sonnet-5" },
            { "x-api-key": "test-key" },
        );
        expect((await handleTriggersRoute(req, url))?.status).toBe(503);
    });

    test("returns 409 when the session is not in collab mode", async () => {
        mockGetSharedSession.mockReturnValue(
            Promise.resolve({ userId: "user-1", sessionId: "sess-1", collabMode: false } as any),
        );

        const [req, url] = makeReq(
            "POST", "/api/sessions/sess-1/model",
            { provider: "anthropic", modelId: "claude-sonnet-5" },
            { "x-api-key": "test-key" },
        );
        expect((await handleTriggersRoute(req, url))?.status).toBe(409);
    });

    test("returns 404 for a session owned by another user", async () => {
        mockGetSharedSession.mockReturnValue(Promise.resolve(collabSession("someone-else")));

        const [req, url] = makeReq(
            "POST", "/api/sessions/sess-1/model",
            { provider: "anthropic", modelId: "claude-sonnet-5" },
            { "x-api-key": "test-key" },
        );
        expect((await handleTriggersRoute(req, url))?.status).toBe(404);
    });

    test("returns 404 for an unknown session", async () => {
        mockGetSharedSession.mockReturnValue(Promise.resolve(null));

        const [req, url] = makeReq(
            "POST", "/api/sessions/nope/model",
            { provider: "anthropic", modelId: "claude-sonnet-5" },
            { "x-api-key": "test-key" },
        );
        expect((await handleTriggersRoute(req, url))?.status).toBe(404);
    });

    test("rejects a missing provider or modelId", async () => {
        mockGetSharedSession.mockReturnValue(Promise.resolve(collabSession()));
        mockGetLocalTuiSocket.mockReturnValue({ connected: true, emit: mock(() => {}) });

        for (const body of [{ modelId: "m" }, { provider: "p" }, { provider: "  ", modelId: "m" }, {}]) {
            const [req, url] = makeReq("POST", "/api/sessions/sess-1/model", body, { "x-api-key": "test-key" });
            expect((await handleTriggersRoute(req, url))?.status).toBe(400);
        }
    });

    test("returns 401 when no credentials are supplied", async () => {
        mockRequireSession.mockReturnValue(Promise.resolve(new Response(null, { status: 401 })) as any);

        const [req, url] = makeReq("POST", "/api/sessions/sess-1/model", { provider: "p", modelId: "m" });
        expect((await handleTriggersRoute(req, url))?.status).toBe(401);
    });

    test("ignores GET on the model route", async () => {
        const [req, url] = makeReq("GET", "/api/sessions/sess-1/model");
        expect(await handleTriggersRoute(req, url)).toBeUndefined();
    });
});

describe("POST /api/sessions/:id/abort", () => {
    const collabSession = (userId = "user-1") => ({ userId, sessionId: "sess-1", collabMode: true } as any);

    beforeEach(() => {
        mockGetSharedSession.mockReset();
        mockGetLocalTuiSocket.mockReset();
        mockEmitToRelaySessionVerified.mockReset();
        mockEmitToRelaySessionVerified.mockReturnValue(Promise.resolve(false));
        mockValidateApiKey.mockReturnValue(Promise.resolve({ userId: "user-1", userName: "TestUser" }));
        mockRequireSession.mockReturnValue(Promise.resolve({ userId: "user-1", userName: "TestUser" }));
    });

    test("delivers an exec abort via the local TUI socket using an API key", async () => {
        mockGetSharedSession.mockReturnValue(Promise.resolve(collabSession()));
        const emitMock = mock(() => {});
        mockGetLocalTuiSocket.mockReturnValue({ connected: true, emit: emitMock });

        const [req, url] = makeReq("POST", "/api/sessions/sess-1/abort", {}, { "x-api-key": "test-key" });
        const res = await handleTriggersRoute(req, url);
        expect(res?.status).toBe(200);
        expect(emitMock).toHaveBeenCalledTimes(1);
        const args = emitMock.mock.calls[0] as any[];
        expect(args[0]).toBe("exec");
        expect(args[1]).toMatchObject({ type: "exec", command: "abort" });
        expect(typeof args[1].id).toBe("string");
    });

    test("falls back to cross-node delivery when there is no local socket", async () => {
        mockGetSharedSession.mockReturnValue(Promise.resolve(collabSession()));
        mockGetLocalTuiSocket.mockReturnValue(null);
        mockEmitToRelaySessionVerified.mockReturnValue(Promise.resolve(true));

        const [req, url] = makeReq("POST", "/api/sessions/sess-1/abort", {}, { "x-api-key": "test-key" });
        expect((await handleTriggersRoute(req, url))?.status).toBe(200);
        expect(mockEmitToRelaySessionVerified).toHaveBeenCalledWith(
            "sess-1", "exec", expect.objectContaining({ command: "abort" }),
        );
    });

    test("returns 503 when the session is registered but unreachable", async () => {
        mockGetSharedSession.mockReturnValue(Promise.resolve(collabSession()));
        mockGetLocalTuiSocket.mockReturnValue(null);
        mockEmitToRelaySessionVerified.mockReturnValue(Promise.resolve(false));

        const [req, url] = makeReq("POST", "/api/sessions/sess-1/abort", {}, { "x-api-key": "test-key" });
        expect((await handleTriggersRoute(req, url))?.status).toBe(503);
    });

    test("returns 409 when the session is not in collab mode", async () => {
        mockGetSharedSession.mockReturnValue(
            Promise.resolve({ userId: "user-1", sessionId: "sess-1", collabMode: false } as any),
        );

        const [req, url] = makeReq("POST", "/api/sessions/sess-1/abort", {}, { "x-api-key": "test-key" });
        expect((await handleTriggersRoute(req, url))?.status).toBe(409);
    });

    test("returns 404 for a session owned by another user", async () => {
        mockGetSharedSession.mockReturnValue(Promise.resolve(collabSession("someone-else")));

        const [req, url] = makeReq("POST", "/api/sessions/sess-1/abort", {}, { "x-api-key": "test-key" });
        expect((await handleTriggersRoute(req, url))?.status).toBe(404);
    });

    test("returns 401 when no credentials are supplied", async () => {
        mockRequireSession.mockReturnValue(Promise.resolve(new Response(null, { status: 401 })) as any);

        const [req, url] = makeReq("POST", "/api/sessions/sess-1/abort", {});
        expect((await handleTriggersRoute(req, url))?.status).toBe(401);
    });

    test("ignores GET on the abort route", async () => {
        const [req, url] = makeReq("GET", "/api/sessions/sess-1/abort");
        expect(await handleTriggersRoute(req, url)).toBeUndefined();
    });
});


describe("POST /api/sessions/:id/thinking", () => {
    const collabSession = (userId = "user-1") => ({ userId, sessionId: "sess-1", collabMode: true } as any);

    beforeEach(() => {
        mockGetSharedSession.mockReset();
        mockGetLocalTuiSocket.mockReset();
        mockEmitToRelaySessionVerified.mockReset();
        mockEmitToRelaySessionVerified.mockReturnValue(Promise.resolve(false));
        mockValidateApiKey.mockReturnValue(Promise.resolve({ userId: "user-1", userName: "TestUser" }));
        mockRequireSession.mockReturnValue(Promise.resolve({ userId: "user-1", userName: "TestUser" }));
    });

    test("delivers an exec set_thinking_level via the local TUI socket", async () => {
        mockGetSharedSession.mockReturnValue(Promise.resolve(collabSession()));
        const emitMock = mock(() => {});
        mockGetLocalTuiSocket.mockReturnValue({ connected: true, emit: emitMock });

        const [req, url] = makeReq("POST", "/api/sessions/sess-1/thinking", { level: "high" }, { "x-api-key": "test-key" });
        const res = await handleTriggersRoute(req, url);
        expect(res?.status).toBe(200);
        expect(emitMock).toHaveBeenCalledTimes(1);
        const args = emitMock.mock.calls[0] as any[];
        expect(args[0]).toBe("exec");
        expect(args[1]).toMatchObject({ type: "exec", command: "set_thinking_level", level: "high" });
        expect(typeof args[1].id).toBe("string");
    });

    test("falls back to cross-node delivery when there is no local socket", async () => {
        mockGetSharedSession.mockReturnValue(Promise.resolve(collabSession()));
        mockGetLocalTuiSocket.mockReturnValue(null);
        mockEmitToRelaySessionVerified.mockReturnValue(Promise.resolve(true));

        const [req, url] = makeReq("POST", "/api/sessions/sess-1/thinking", { level: "low" }, { "x-api-key": "test-key" });
        expect((await handleTriggersRoute(req, url))?.status).toBe(200);
        expect(mockEmitToRelaySessionVerified).toHaveBeenCalledWith(
            "sess-1", "exec", expect.objectContaining({ command: "set_thinking_level", level: "low" }),
        );
    });

    test("rejects an invalid level", async () => {
        mockGetSharedSession.mockReturnValue(Promise.resolve(collabSession()));

        const [req, url] = makeReq("POST", "/api/sessions/sess-1/thinking", { level: "turbo" }, { "x-api-key": "test-key" });
        expect((await handleTriggersRoute(req, url))?.status).toBe(400);
    });

    test("returns 409 when the session is not in collab mode", async () => {
        mockGetSharedSession.mockReturnValue(
            Promise.resolve({ userId: "user-1", sessionId: "sess-1", collabMode: false } as any),
        );

        const [req, url] = makeReq("POST", "/api/sessions/sess-1/thinking", { level: "high" }, { "x-api-key": "test-key" });
        expect((await handleTriggersRoute(req, url))?.status).toBe(409);
    });

    test("returns 404 for a session owned by another user", async () => {
        mockGetSharedSession.mockReturnValue(Promise.resolve(collabSession("someone-else")));

        const [req, url] = makeReq("POST", "/api/sessions/sess-1/thinking", { level: "high" }, { "x-api-key": "test-key" });
        expect((await handleTriggersRoute(req, url))?.status).toBe(404);
    });

    test("returns 503 when the session is registered but unreachable", async () => {
        mockGetSharedSession.mockReturnValue(Promise.resolve(collabSession()));
        mockGetLocalTuiSocket.mockReturnValue(null);
        mockEmitToRelaySessionVerified.mockReturnValue(Promise.resolve(false));

        const [req, url] = makeReq("POST", "/api/sessions/sess-1/thinking", { level: "high" }, { "x-api-key": "test-key" });
        expect((await handleTriggersRoute(req, url))?.status).toBe(503);
    });
});

