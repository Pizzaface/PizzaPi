/**
 * Tests for the HTTP Trigger API route.
 *
 * Tests the route handler logic with mocked dependencies (Redis, SIO registry).
 */

import { describe, test, expect, beforeEach, afterEach, afterAll, mock, spyOn } from "bun:test";

const isCI = !!process.env.CI;

afterAll(() => mock.restore());

// ── Mock sio-registry ────────────────────────────────────────────────────
const mockGetSharedSession = mock((_id: string) => Promise.resolve(null as any));
const mockGetLocalTuiSocket = mock((_id: string) => null as any);
const mockEmitToRelaySessionVerified = mock((_id: string, _event: string, _data: any) => Promise.resolve(false));
const mockBroadcastToSessionViewers = mock((_sid: string, _event: string, _data: any) => {});

const mockRecordRunnerSession = mock((_runnerId: string, _sessionId: string) => Promise.resolve());
const mockGetLocalRunnerSocket = mock((_runnerId: string) => null as any);
const mockLinkSessionToRunner = mock((_runnerId: string, _sessionId: string) => Promise.resolve());

mock.module("../ws/sio-registry.js", () => ({
    getSharedSession: mockGetSharedSession,
    getLocalTuiSocket: mockGetLocalTuiSocket,
    emitToRelaySessionVerified: mockEmitToRelaySessionVerified,
    broadcastToSessionViewers: mockBroadcastToSessionViewers,
    recordRunnerSession: mockRecordRunnerSession,
    getLocalRunnerSocket: mockGetLocalRunnerSocket,
    linkSessionToRunner: mockLinkSessionToRunner,
    emitToRelaySession: mock((_id: string, _event: string, _data: any) => Promise.resolve(false)),
    getTerminalEntry: mock((_id: string) => Promise.resolve(null as any)),
}));

const mockGetRunnerListenerTypes = mock((_runnerId: string) => Promise.resolve([] as string[]));
const mockGetRunnerTriggerListener = mock((_runnerId: string, _triggerType: string) => Promise.resolve(null as any));
const mockListRunnerTriggerListeners = mock((_runnerId: string) => Promise.resolve([] as any[]));
const mockAddRunnerTriggerListener = mock((_runnerId: string, _triggerType: string, _config: any) => Promise.resolve("listener-default"));
const mockRemoveRunnerTriggerListener = mock((_runnerId: string, _target: string) => Promise.resolve(true));
const mockUpdateRunnerTriggerListener = mock((_runnerId: string, _target: string, _updates: any) => Promise.resolve({ updated: false } as any));

mock.module("../ws/runner-control.js", () => ({
    waitForSpawnAck: mock(() => Promise.resolve({ ok: true })),
}));

mock.module("../ws/namespaces/runner.js", () => ({
    emitTriggerSubscriptionDelta: mock(() => Promise.resolve()),
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

// ── Mock trigger subscription store ─────────────────────────────────────
const mockSubscribeSessionToTrigger = mock((_sid: string, _rid: string, _type: string, _ttl?: number, _params?: any) => Promise.resolve("sub-default"));
const mockUnsubscribeSessionFromTrigger = mock((_sid: string, _target: string) => Promise.resolve({ removed: 1, triggerType: _target }));
const mockUnsubscribeSessionSubscription = mock((_sid: string, _subscriptionId: string) => Promise.resolve(true));
const mockListSessionSubscriptions = mock((_sid: string) => Promise.resolve([] as any[]));
const mockGetSubscribersForTrigger = mock((_rid: string, _type: string) => Promise.resolve([] as string[]));
const mockGetSubscriptionParams = mock((_sid: string, _type: string) => Promise.resolve(undefined as any));
const mockGetSubscriptionFilters = mock((_sid: string, _type: string) => Promise.resolve(undefined as any));
const mockUpdateSessionSubscription = mock((_sid: string, _target: string, _updates: any) => Promise.resolve({ updated: false } as any));
const mockClearSessionSubscriptions = mock((_sid: string) => Promise.resolve());
const mockGetSubscriptionsForRunnerSessions = mock((_runnerId: string, _sessionIds: string[]) => Promise.resolve([] as any[]));

// ── Mock runners registry + stores via spyOn to avoid cross-file poison ──
import * as _runnersModule from "../ws/sio-registry/runners.js";
import * as _triggerSubsModule from "../sessions/trigger-subscription-store.js";
import * as _runnerListenersModule from "../sessions/runner-trigger-listener-store.js";
let mockGetRunnerServices: ReturnType<typeof spyOn>;
let mockGetRunnerData: ReturnType<typeof spyOn>;
let spySubscribeSessionToTrigger: ReturnType<typeof spyOn>;
let spyUnsubscribeSessionFromTrigger: ReturnType<typeof spyOn>;
let spyUnsubscribeSessionSubscription: ReturnType<typeof spyOn>;
let spyListSessionSubscriptions: ReturnType<typeof spyOn>;
let spyGetSubscribersForTrigger: ReturnType<typeof spyOn>;
let spyGetSubscriptionParams: ReturnType<typeof spyOn>;
let spyGetSubscriptionFilters: ReturnType<typeof spyOn>;
let spyUpdateSessionSubscription: ReturnType<typeof spyOn>;
let spyClearSessionSubscriptions: ReturnType<typeof spyOn>;
let spyGetSubscriptionsForRunnerSessions: ReturnType<typeof spyOn>;
let spyGetRunnerListenerTypes: ReturnType<typeof spyOn>;
let spyGetRunnerTriggerListener: ReturnType<typeof spyOn>;
let spyListRunnerTriggerListeners: ReturnType<typeof spyOn>;
let spyAddRunnerTriggerListener: ReturnType<typeof spyOn>;
let spyRemoveRunnerTriggerListener: ReturnType<typeof spyOn>;
let spyUpdateRunnerTriggerListener: ReturnType<typeof spyOn>;

beforeEach(() => {
    mockGetRunnerServices = spyOn(_runnersModule, "getRunnerServices")
        .mockImplementation((_rid: string) => Promise.resolve(null as any));
    mockGetRunnerData = spyOn(_runnersModule, "getRunnerData")
        .mockImplementation((_rid: string) => Promise.resolve({ userId: "user-1", runnerId: "runner-A" } as any));

    spySubscribeSessionToTrigger = spyOn(_triggerSubsModule, "subscribeSessionToTrigger").mockImplementation(mockSubscribeSessionToTrigger as any);
    spyUnsubscribeSessionFromTrigger = spyOn(_triggerSubsModule, "unsubscribeSessionFromTrigger").mockImplementation(mockUnsubscribeSessionFromTrigger as any);
    spyUnsubscribeSessionSubscription = spyOn(_triggerSubsModule, "unsubscribeSessionSubscription").mockImplementation(mockUnsubscribeSessionSubscription as any);
    spyListSessionSubscriptions = spyOn(_triggerSubsModule, "listSessionSubscriptions").mockImplementation(mockListSessionSubscriptions as any);
    spyGetSubscribersForTrigger = spyOn(_triggerSubsModule, "getSubscribersForTrigger").mockImplementation(mockGetSubscribersForTrigger as any);
    spyGetSubscriptionParams = spyOn(_triggerSubsModule, "getSubscriptionParams").mockImplementation(mockGetSubscriptionParams as any);
    spyGetSubscriptionFilters = spyOn(_triggerSubsModule, "getSubscriptionFilters").mockImplementation(mockGetSubscriptionFilters as any);
    spyUpdateSessionSubscription = spyOn(_triggerSubsModule, "updateSessionSubscription").mockImplementation(mockUpdateSessionSubscription as any);
    spyClearSessionSubscriptions = spyOn(_triggerSubsModule, "clearSessionSubscriptions").mockImplementation(mockClearSessionSubscriptions as any);
    spyGetSubscriptionsForRunnerSessions = spyOn(_triggerSubsModule, "getSubscriptionsForRunnerSessions").mockImplementation(mockGetSubscriptionsForRunnerSessions as any);

    spyGetRunnerListenerTypes = spyOn(_runnerListenersModule, "getRunnerListenerTypes").mockImplementation(mockGetRunnerListenerTypes as any);
    spyGetRunnerTriggerListener = spyOn(_runnerListenersModule, "getRunnerTriggerListener").mockImplementation(mockGetRunnerTriggerListener as any);
    spyListRunnerTriggerListeners = spyOn(_runnerListenersModule, "listRunnerTriggerListeners").mockImplementation(mockListRunnerTriggerListeners as any);
    spyAddRunnerTriggerListener = spyOn(_runnerListenersModule, "addRunnerTriggerListener").mockImplementation(mockAddRunnerTriggerListener as any);
    spyRemoveRunnerTriggerListener = spyOn(_runnerListenersModule, "removeRunnerTriggerListener").mockImplementation(mockRemoveRunnerTriggerListener as any);
    spyUpdateRunnerTriggerListener = spyOn(_runnerListenersModule, "updateRunnerTriggerListener").mockImplementation(mockUpdateRunnerTriggerListener as any);
});

afterEach(() => {
    mockGetRunnerServices.mockRestore();
    mockGetRunnerData.mockRestore();
    spySubscribeSessionToTrigger.mockRestore();
    spyUnsubscribeSessionFromTrigger.mockRestore();
    spyUnsubscribeSessionSubscription.mockRestore();
    spyListSessionSubscriptions.mockRestore();
    spyGetSubscribersForTrigger.mockRestore();
    spyGetSubscriptionParams.mockRestore();
    spyGetSubscriptionFilters.mockRestore();
    spyUpdateSessionSubscription.mockRestore();
    spyClearSessionSubscriptions.mockRestore();
    spyGetSubscriptionsForRunnerSessions.mockRestore();
    spyGetRunnerListenerTypes.mockRestore();
    spyGetRunnerTriggerListener.mockRestore();
    spyListRunnerTriggerListeners.mockRestore();
    spyAddRunnerTriggerListener.mockRestore();
    spyRemoveRunnerTriggerListener.mockRestore();
    spyUpdateRunnerTriggerListener.mockRestore();
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

describe("POST /api/sessions/:id/trigger", () => {
    beforeEach(() => {
        mockGetSharedSession.mockReset();
        mockGetLocalTuiSocket.mockReset();
        mockEmitToRelaySessionVerified.mockReset();
        mockRequireSession.mockReset();
        mockValidateApiKey.mockReset();
        mockPushTriggerHistory.mockReset();

        mockRequireSession.mockReturnValue(
            Promise.resolve({ userId: "user-1", userName: "TestUser" }),
        );
    });

    test("returns 401 when not authenticated", async () => {
        mockRequireSession.mockReturnValue(
            Promise.resolve(Response.json({ error: "Unauthorized" }, { status: 401 })) as any,
        );
        const [req, url] = makeReq("POST", "/api/sessions/sess-1/trigger", {
            type: "test",
            payload: { msg: "hello" },
        });
        const res = await handleTriggersRoute(req, url);
        expect(res).toBeDefined();
        expect(res!.status).toBe(401);
    });

    test("returns 404 when session not found", async () => {
        mockGetSharedSession.mockReturnValue(Promise.resolve(null));
        const [req, url] = makeReq("POST", "/api/sessions/sess-1/trigger", {
            type: "test",
            payload: { msg: "hello" },
        });
        const res = await handleTriggersRoute(req, url);
        expect(res).toBeDefined();
        expect(res!.status).toBe(404);
    });

    test("returns 404 when session belongs to different user", async () => {
        mockGetSharedSession.mockReturnValue(
            Promise.resolve({ userId: "user-2", sessionId: "sess-1" } as any),
        );
        const [req, url] = makeReq("POST", "/api/sessions/sess-1/trigger", {
            type: "test",
            payload: { msg: "hello" },
        });
        const res = await handleTriggersRoute(req, url);
        expect(res).toBeDefined();
        expect(res!.status).toBe(404);
    });

    test("returns 400 when type is missing", async () => {
        mockGetSharedSession.mockReturnValue(
            Promise.resolve({ userId: "user-1", sessionId: "sess-1" } as any),
        );
        const [req, url] = makeReq("POST", "/api/sessions/sess-1/trigger", {
            payload: { msg: "hello" },
        });
        const res = await handleTriggersRoute(req, url);
        expect(res).toBeDefined();
        expect(res!.status).toBe(400);
        const body = await res!.json();
        expect(body.error).toContain("type");
    });

    test("returns 400 when payload is missing", async () => {
        mockGetSharedSession.mockReturnValue(
            Promise.resolve({ userId: "user-1", sessionId: "sess-1" } as any),
        );
        const [req, url] = makeReq("POST", "/api/sessions/sess-1/trigger", {
            type: "test",
        });
        const res = await handleTriggersRoute(req, url);
        expect(res).toBeDefined();
        expect(res!.status).toBe(400);
        const body = await res!.json();
        expect(body.error).toContain("payload");
    });

    test("returns 400 when payload is an array", async () => {
        mockGetSharedSession.mockReturnValue(
            Promise.resolve({ userId: "user-1", sessionId: "sess-1" } as any),
        );
        const [req, url] = makeReq("POST", "/api/sessions/sess-1/trigger", {
            type: "test",
            payload: [1, 2, 3],
        });
        const res = await handleTriggersRoute(req, url);
        expect(res).toBeDefined();
        expect(res!.status).toBe(400);
    });

    test("delivers trigger to local socket", async () => {
        const emitMock = mock(() => {});
        mockGetSharedSession.mockReturnValue(
            Promise.resolve({ userId: "user-1", sessionId: "sess-1" } as any),
        );
        mockGetLocalTuiSocket.mockReturnValue({ connected: true, emit: emitMock });

        const [req, url] = makeReq("POST", "/api/sessions/sess-1/trigger", {
            type: "webhook",
            payload: { event: "push", repo: "test/repo" },
            source: "github",
            summary: "Push to main",
        });
        const res = await handleTriggersRoute(req, url);
        expect(res).toBeDefined();
        expect(res!.status).toBe(200);
        const body = await res!.json();
        expect(body.ok).toBe(true);
        expect(body.triggerId).toMatch(/^ext_/);

        // Verify the trigger was emitted
        expect(emitMock).toHaveBeenCalledTimes(1);
        const args = emitMock.mock.calls[0] as any[];
        expect(args[0]).toBe("session_trigger");
        expect(args[1].trigger.type).toBe("webhook");
        expect(args[1].trigger.payload.event).toBe("push");
        expect(args[1].trigger.sourceSessionId).toBe("external:github");

        // Verify history was recorded
        expect(mockPushTriggerHistory).toHaveBeenCalledTimes(1);
    });

    test("falls back to cross-node delivery", async () => {
        mockGetSharedSession.mockReturnValue(
            Promise.resolve({ userId: "user-1", sessionId: "sess-1" } as any),
        );
        mockGetLocalTuiSocket.mockReturnValue(null);
        mockEmitToRelaySessionVerified.mockReturnValue(Promise.resolve(true));

        const [req, url] = makeReq("POST", "/api/sessions/sess-1/trigger", {
            type: "cron",
            payload: { job: "daily-report" },
        });
        const res = await handleTriggersRoute(req, url);
        expect(res).toBeDefined();
        expect(res!.status).toBe(200);
        expect(mockEmitToRelaySessionVerified).toHaveBeenCalledTimes(1);
    });

    test("returns 503 when session not connected anywhere", async () => {
        mockGetSharedSession.mockReturnValue(
            Promise.resolve({ userId: "user-1", sessionId: "sess-1" } as any),
        );
        mockGetLocalTuiSocket.mockReturnValue(null);
        mockEmitToRelaySessionVerified.mockReturnValue(Promise.resolve(false));

        const [req, url] = makeReq("POST", "/api/sessions/sess-1/trigger", {
            type: "test",
            payload: { msg: "hello" },
        });
        const res = await handleTriggersRoute(req, url);
        expect(res).toBeDefined();
        expect(res!.status).toBe(503);
    });

    test("uses API key auth when x-api-key header present", async () => {
        mockValidateApiKey.mockReturnValue(
            Promise.resolve({ userId: "user-1", userName: "ApiUser" }),
        );
        mockGetSharedSession.mockReturnValue(
            Promise.resolve({ userId: "user-1", sessionId: "sess-1" } as any),
        );
        mockGetLocalTuiSocket.mockReturnValue({ connected: true, emit: mock(() => {}) });

        const [req, url] = makeReq(
            "POST",
            "/api/sessions/sess-1/trigger",
            { type: "test", payload: { x: 1 } },
            { "x-api-key": "test-key-123" },
        );
        const res = await handleTriggersRoute(req, url);
        expect(res!.status).toBe(200);
        expect(mockValidateApiKey).toHaveBeenCalledTimes(1);
        // Should NOT have called requireSession since API key was present
        expect(mockRequireSession).not.toHaveBeenCalled();
    });

    test("returns 400 for invalid deliverAs", async () => {
        mockGetSharedSession.mockReturnValue(
            Promise.resolve({ userId: "user-1", sessionId: "sess-1" } as any),
        );
        const [req, url] = makeReq("POST", "/api/sessions/sess-1/trigger", {
            type: "test",
            payload: { x: 1 },
            deliverAs: "invalid",
        });
        const res = await handleTriggersRoute(req, url);
        expect(res!.status).toBe(400);
    });
});

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

describe("GET /api/sessions/:id/trigger-subscriptions", () => {
    beforeEach(() => {
        mockGetSharedSession.mockReset();
        mockListSessionSubscriptions.mockReset();
        mockRequireSession.mockReturnValue(
            Promise.resolve({ userId: "user-1", userName: "TestUser" }),
        );
    });

    test("returns active subscriptions", async () => {
        mockGetSharedSession.mockReturnValue(
            Promise.resolve({ userId: "user-1", sessionId: "sess-1", runnerId: "runner-A" } as any),
        );
        mockListSessionSubscriptions.mockReturnValue(Promise.resolve([
            { subscriptionId: "sub-1", triggerType: "godmother:idea_moved", runnerId: "runner-A" },
            { subscriptionId: "sub-2", triggerType: "godmother:idea_moved", runnerId: "runner-A" },
        ]));

        const [req, url] = makeReq("GET", "/api/sessions/sess-1/trigger-subscriptions");
        const res = await handleTriggersRoute(req, url);
        expect(res!.status).toBe(200);
        const body = await res!.json();
        expect(body.subscriptions).toHaveLength(2);
        expect(body.subscriptions[0].subscriptionId).toBe("sub-1");
        expect(body.subscriptions[1].subscriptionId).toBe("sub-2");
        expect(body.subscriptions[0].triggerType).toBe("godmother:idea_moved");
    });

    test("returns 404 for wrong user", async () => {
        mockGetSharedSession.mockReturnValue(
            Promise.resolve({ userId: "user-2", sessionId: "sess-1" } as any),
        );

        const [req, url] = makeReq("GET", "/api/sessions/sess-1/trigger-subscriptions");
        const res = await handleTriggersRoute(req, url);
        expect(res!.status).toBe(404);
    });
});

describe("POST /api/sessions/:id/trigger-subscriptions", () => {
    beforeEach(() => {
        mockGetSharedSession.mockReset();
        mockGetRunnerServices.mockReset();
        mockSubscribeSessionToTrigger.mockReset();
        mockRequireSession.mockReturnValue(
            Promise.resolve({ userId: "user-1", userName: "TestUser" }),
        );
    });

    test("subscribes to a declared trigger type and returns subscriptionId", async () => {
        mockGetSharedSession.mockReturnValue(
            Promise.resolve({ userId: "user-1", sessionId: "sess-1", runnerId: "runner-A" } as any),
        );
        mockGetRunnerServices.mockReturnValue(Promise.resolve({
            serviceIds: ["godmother"],
            triggerDefs: [{ type: "godmother:idea_moved", label: "Idea Moved" }],
        }));
        mockSubscribeSessionToTrigger.mockReturnValue(Promise.resolve("sub-123"));

        const [req, url] = makeReq("POST", "/api/sessions/sess-1/trigger-subscriptions", {
            triggerType: "godmother:idea_moved",
        });
        const res = await handleTriggersRoute(req, url);
        expect(res!.status).toBe(200);
        const body = await res!.json();
        expect(body.ok).toBe(true);
        expect(body.subscriptionId).toBe("sub-123");
        expect(body.triggerType).toBe("godmother:idea_moved");
        expect(mockSubscribeSessionToTrigger).toHaveBeenCalledTimes(1);
    });

    test("returns 422 when trigger type is not declared on runner", async () => {
        mockGetSharedSession.mockReturnValue(
            Promise.resolve({ userId: "user-1", sessionId: "sess-1", runnerId: "runner-A" } as any),
        );
        mockGetRunnerServices.mockReturnValue(Promise.resolve({
            serviceIds: ["godmother"],
            triggerDefs: [{ type: "godmother:idea_moved", label: "Idea Moved" }],
        }));

        const [req, url] = makeReq("POST", "/api/sessions/sess-1/trigger-subscriptions", {
            triggerType: "undeclared:event",
        });
        const res = await handleTriggersRoute(req, url);
        expect(res!.status).toBe(422);
        const body = await res!.json();
        expect(body.error).toContain("not available");
    });

    test("returns 503 when runner catalog is unavailable (runner restarted)", async () => {
        mockGetSharedSession.mockReturnValue(
            Promise.resolve({ userId: "user-1", sessionId: "sess-1", runnerId: "runner-A" } as any),
        );
        mockGetRunnerServices.mockReturnValue(Promise.resolve(null));

        const [req, url] = makeReq("POST", "/api/sessions/sess-1/trigger-subscriptions", {
            triggerType: "svc:event",
        });
        const res = await handleTriggersRoute(req, url);
        expect(res!.status).toBe(503);
        const body = await res!.json();
        expect(body.error).toContain("unavailable");
    });

    test("returns 422 when session has no runner", async () => {
        mockGetSharedSession.mockReturnValue(
            Promise.resolve({ userId: "user-1", sessionId: "sess-1", runnerId: null } as any),
        );

        const [req, url] = makeReq("POST", "/api/sessions/sess-1/trigger-subscriptions", {
            triggerType: "svc:event",
        });
        const res = await handleTriggersRoute(req, url);
        expect(res!.status).toBe(422);
    });

    test("returns 400 when triggerType is missing", async () => {
        mockGetSharedSession.mockReturnValue(
            Promise.resolve({ userId: "user-1", sessionId: "sess-1", runnerId: "runner-A" } as any),
        );

        const [req, url] = makeReq("POST", "/api/sessions/sess-1/trigger-subscriptions", {});
        const res = await handleTriggersRoute(req, url);
        expect(res!.status).toBe(400);
    });

    test("returns 404 for wrong user", async () => {
        mockGetSharedSession.mockReturnValue(
            Promise.resolve({ userId: "user-2", sessionId: "sess-1" } as any),
        );

        const [req, url] = makeReq("POST", "/api/sessions/sess-1/trigger-subscriptions", {
            triggerType: "svc:event",
        });
        const res = await handleTriggersRoute(req, url);
        expect(res!.status).toBe(404);
    });
});

describe("DELETE /api/sessions/:id/trigger-subscriptions/:target", () => {
    beforeEach(() => {
        mockGetSharedSession.mockReset();
        mockUnsubscribeSessionFromTrigger.mockReset();
        mockUnsubscribeSessionSubscription.mockReset();
        mockRequireSession.mockReturnValue(
            Promise.resolve({ userId: "user-1", userName: "TestUser" }),
        );
    });

    test("unsubscribes from a specific subscription id when provided", async () => {
        mockGetSharedSession.mockReturnValue(
            Promise.resolve({ userId: "user-1", sessionId: "sess-1", runnerId: "runner-A" } as any),
        );
        mockUnsubscribeSessionSubscription.mockReturnValue(Promise.resolve(true));

        const [req, url] = makeReq("DELETE", "/api/sessions/sess-1/trigger-subscriptions/godmother:idea_moved?subscriptionId=sub-123");
        const res = await handleTriggersRoute(req, url);
        expect(res!.status).toBe(200);
        const body = await res!.json();
        expect(body.ok).toBe(true);
        expect(body.subscriptionId).toBe("sub-123");
        expect(body.triggerType).toBe("godmother:idea_moved");
        expect(mockUnsubscribeSessionSubscription).toHaveBeenCalledWith("sess-1", "sub-123");
        expect(mockUnsubscribeSessionFromTrigger).not.toHaveBeenCalled();
    });

    test("supports legacy triggerType delete-all semantics", async () => {
        mockGetSharedSession.mockReturnValue(
            Promise.resolve({ userId: "user-1", sessionId: "sess-1", runnerId: "runner-A" } as any),
        );
        mockUnsubscribeSessionFromTrigger.mockReturnValue(Promise.resolve({ removed: 2, triggerType: "svc:event" }));

        const [req, url] = makeReq("DELETE", "/api/sessions/sess-1/trigger-subscriptions/svc:event");
        const res = await handleTriggersRoute(req, url);
        expect(res!.status).toBe(200);
        const body = await res!.json();
        expect(body.ok).toBe(true);
        expect(body.triggerType).toBe("svc:event");
        expect(body.removed).toBe(2);
        expect(mockUnsubscribeSessionFromTrigger).toHaveBeenCalledWith("sess-1", "svc:event");
        expect(mockUnsubscribeSessionSubscription).not.toHaveBeenCalled();
    });

    test("treats colonless path targets as legacy trigger types unless subscriptionId query is present", async () => {
        mockGetSharedSession.mockReturnValue(
            Promise.resolve({ userId: "user-1", sessionId: "sess-1", runnerId: "runner-A" } as any),
        );
        mockUnsubscribeSessionFromTrigger.mockReturnValue(Promise.resolve({ removed: 1, triggerType: "button_clicked" }));

        const [req, url] = makeReq("DELETE", "/api/sessions/sess-1/trigger-subscriptions/button_clicked");
        const res = await handleTriggersRoute(req, url);
        expect(res!.status).toBe(200);
        const body = await res!.json();
        expect(body.ok).toBe(true);
        expect(body.triggerType).toBe("button_clicked");
        expect(body.removed).toBe(1);
        expect(mockUnsubscribeSessionFromTrigger).toHaveBeenCalledWith("sess-1", "button_clicked");
        expect(mockUnsubscribeSessionSubscription).not.toHaveBeenCalled();
    });

    test("returns 404 for wrong user", async () => {
        mockGetSharedSession.mockReturnValue(
            Promise.resolve({ userId: "user-2", sessionId: "sess-1" } as any),
        );

        const [req, url] = makeReq("DELETE", "/api/sessions/sess-1/trigger-subscriptions/svc:event");
        const res = await handleTriggersRoute(req, url);
        expect(res!.status).toBe(404);
    });
});

describe("POST /api/runners/:runnerId/trigger-broadcast", () => {
    beforeEach(() => {
        mockGetSharedSession.mockReset();
        mockGetLocalTuiSocket.mockReset();
        mockEmitToRelaySessionVerified.mockReset();
        mockPushTriggerHistory.mockReset();
        mockGetSubscribersForTrigger.mockReset();
        mockGetSubscriptionParams.mockReset();
        mockGetSubscriptionParams.mockReturnValue(Promise.resolve(undefined));
        mockGetSubscriptionFilters.mockReset();
        mockGetSubscriptionFilters.mockReturnValue(Promise.resolve(undefined));
        mockGetRunnerData.mockReset();
        mockGetRunnerData.mockImplementation((_rid: string) => Promise.resolve({ userId: "user-1", runnerId: "runner-A" } as any));
        mockValidateApiKey.mockReturnValue(
            Promise.resolve({ userId: "user-1", userName: "TestUser" }),
        );
    });

    test("returns 401 when no API key provided", async () => {
        const [req, url] = makeReq("POST", "/api/runners/runner-A/trigger-broadcast", {
            type: "svc:event",
            payload: { x: 1 },
        });
        const res = await handleTriggersRoute(req, url);
        expect(res?.status).toBe(401);
    });

    test("returns delivered=0 when no subscribers", async () => {
        mockGetSubscribersForTrigger.mockReturnValue(Promise.resolve([]));

        const [req, url] = makeReq(
            "POST", "/api/runners/runner-A/trigger-broadcast",
            { type: "svc:event", payload: { x: 1 } },
            { "x-api-key": "test-key" },
        );
        const res = await handleTriggersRoute(req, url);
        expect(res?.status).toBe(200);
        const body = await res!.json();
        expect(body.ok).toBe(true);
        expect(body.delivered).toBe(0);
    });

    test("delivers to all subscribed sessions via local socket", async () => {
        mockGetSubscribersForTrigger.mockReturnValue(
            Promise.resolve(["sess-1", "sess-2"]),
        );
        mockGetSharedSession.mockImplementation((id: string) =>
            Promise.resolve({ userId: "user-1", sessionId: id } as any),
        );
        const emitMock = mock(() => {});
        mockGetLocalTuiSocket.mockReturnValue({ connected: true, emit: emitMock });

        const [req, url] = makeReq(
            "POST", "/api/runners/runner-A/trigger-broadcast",
            { type: "svc:event", payload: { msg: "hello" }, source: "svc" },
            { "x-api-key": "test-key" },
        );
        const res = await handleTriggersRoute(req, url);
        expect(res?.status).toBe(200);
        const body = await res!.json();
        expect(body.ok).toBe(true);
        expect(body.delivered).toBe(2);
        expect(emitMock).toHaveBeenCalledTimes(2);
    });

    test("skips sessions belonging to a different user", async () => {
        mockGetSubscribersForTrigger.mockReturnValue(
            Promise.resolve(["sess-other", "sess-mine"]),
        );
        mockGetSharedSession.mockImplementation((id: string) =>
            Promise.resolve({
                userId: id === "sess-mine" ? "user-1" : "user-2",
                sessionId: id,
            } as any),
        );
        const emitMock = mock(() => {});
        mockGetLocalTuiSocket.mockReturnValue({ connected: true, emit: emitMock });

        const [req, url] = makeReq(
            "POST", "/api/runners/runner-A/trigger-broadcast",
            { type: "svc:event", payload: {} },
            { "x-api-key": "test-key" },
        );
        const res = await handleTriggersRoute(req, url);
        const body = await res!.json();
        expect(body.delivered).toBe(1); // only sess-mine
    });

    test("falls back to cross-node delivery when local socket absent", async () => {
        mockGetSubscribersForTrigger.mockReturnValue(Promise.resolve(["sess-1"]));
        mockGetSharedSession.mockReturnValue(
            Promise.resolve({ userId: "user-1", sessionId: "sess-1" } as any),
        );
        mockGetLocalTuiSocket.mockReturnValue(null);
        mockEmitToRelaySessionVerified.mockReturnValue(Promise.resolve(true));

        const [req, url] = makeReq(
            "POST", "/api/runners/runner-A/trigger-broadcast",
            { type: "svc:event", payload: {} },
            { "x-api-key": "test-key" },
        );
        const res = await handleTriggersRoute(req, url);
        const body = await res!.json();
        expect(body.delivered).toBe(1);
        expect(mockEmitToRelaySessionVerified).toHaveBeenCalledTimes(1);
    });

    test("returns 400 for missing type field", async () => {
        const [req, url] = makeReq(
            "POST", "/api/runners/runner-A/trigger-broadcast",
            { payload: {} },
            { "x-api-key": "test-key" },
        );
        const res = await handleTriggersRoute(req, url);
        expect(res?.status).toBe(400);
    });

    test("filters by subscription params — only matching subscribers receive trigger", async () => {
        mockGetSubscribersForTrigger.mockReturnValue(
            Promise.resolve(["sess-pr42", "sess-pr99", "sess-all"]),
        );
        mockGetSharedSession.mockImplementation((id: string) =>
            Promise.resolve({ userId: "user-1", sessionId: id } as any),
        );
        // sess-pr42 subscribes with prNumber=42, sess-pr99 with prNumber=99, sess-all has no params
        mockGetSubscriptionParams.mockImplementation((sid: string, _type: string) => {
            if (sid === "sess-pr42") return Promise.resolve({ prNumber: 42 });
            if (sid === "sess-pr99") return Promise.resolve({ prNumber: 99 });
            return Promise.resolve(undefined); // sess-all — no params, receives everything
        });
        const emitMock = mock(() => {});
        mockGetLocalTuiSocket.mockReturnValue({ connected: true, emit: emitMock });

        const [req, url] = makeReq(
            "POST", "/api/runners/runner-A/trigger-broadcast",
            { type: "github:pr_comment", payload: { prNumber: 42, comment: "hello" }, source: "github" },
            { "x-api-key": "test-key" },
        );
        const res = await handleTriggersRoute(req, url);
        const body = await res!.json();
        // sess-pr42 matches (prNumber=42), sess-all matches (no filter), sess-pr99 does NOT match
        expect(body.delivered).toBe(2);
        expect(emitMock).toHaveBeenCalledTimes(2);
    });

    test("multiselect array params — matches when payload value is in subscriber's array", async () => {
        mockGetSubscribersForTrigger.mockReturnValue(
            Promise.resolve(["sess-multi", "sess-single", "sess-miss"]),
        );
        mockGetSharedSession.mockImplementation((id: string) =>
            Promise.resolve({ userId: "user-1", sessionId: id } as any),
        );
        // sess-multi subscribed with channels=["alerts","debug"], sess-single with channel="alerts", sess-miss with channels=["info"]
        mockGetSubscriptionParams.mockImplementation((sid: string, _type: string) => {
            if (sid === "sess-multi") return Promise.resolve({ channel: ["alerts", "debug"] });
            if (sid === "sess-single") return Promise.resolve({ channel: "alerts" });
            if (sid === "sess-miss") return Promise.resolve({ channel: ["info", "warn"] });
            return Promise.resolve(undefined);
        });
        const emitMock = mock(() => {});
        mockGetLocalTuiSocket.mockReturnValue({ connected: true, emit: emitMock });

        const [req, url] = makeReq(
            "POST", "/api/runners/runner-A/trigger-broadcast",
            { type: "demo:message_sent", payload: { channel: "alerts", message: "hi" }, source: "demo" },
            { "x-api-key": "test-key" },
        );
        const res = await handleTriggersRoute(req, url);
        const body = await res!.json();
        // sess-multi matches ("alerts" in ["alerts","debug"]), sess-single matches ("alerts"=="alerts"),
        // sess-miss does NOT match ("alerts" not in ["info","warn"])
        expect(body.delivered).toBe(2);
        expect(emitMock).toHaveBeenCalledTimes(2);
    });

    (isCI ? test.skip : test)("array payloads match scalar subscription filters and bodyContains performs substring matching", async () => {
        mockGetSubscribersForTrigger.mockReturnValue(
            Promise.resolve(["sess-label", "sess-body", "sess-miss"]),
        );
        mockGetSharedSession.mockImplementation((id: string) =>
            Promise.resolve({ userId: "user-1", sessionId: id } as any),
        );
        mockGetSubscriptionParams.mockImplementation((sid: string, _type: string) => {
            if (sid === "sess-label") return Promise.resolve({ labels: "bug" });
            if (sid === "sess-body") return Promise.resolve({ bodyContains: "urgent fix" });
            if (sid === "sess-miss") return Promise.resolve({ labels: "docs", bodyContains: "not here" });
            return Promise.resolve(undefined);
        });
        const emitMock = mock(() => {});
        mockGetLocalTuiSocket.mockReturnValue({ connected: true, emit: emitMock });

        const [req, url] = makeReq(
            "POST", "/api/runners/runner-A/trigger-broadcast",
            {
                type: "github:pr_comment",
                payload: {
                    labels: ["bug", "needs-review"],
                    body: "This is an urgent fix for the failing test",
                },
                source: "github",
            },
            { "x-api-key": "test-key" },
        );
        const res = await handleTriggersRoute(req, url);
        const body = await res!.json();
        expect(body.delivered).toBe(2);
        expect(emitMock).toHaveBeenCalledTimes(2);
    });
});


describe("POST /api/runners/:runnerId/trigger-broadcast — filter-based delivery", () => {
    beforeEach(() => {
        mockGetSharedSession.mockReset();
        mockGetLocalTuiSocket.mockReset();
        mockEmitToRelaySessionVerified.mockReset();
        mockGetSubscriptionParams.mockReset();
        mockGetSubscriptionParams.mockReturnValue(Promise.resolve(undefined));
        mockGetSubscriptionFilters.mockReset();
        mockGetSubscriptionFilters.mockReturnValue(Promise.resolve(undefined));
    });

    test("filters by subscription filters (AND mode) — only matching subscribers receive trigger", async () => {
        mockGetSubscribersForTrigger.mockReturnValue(
            Promise.resolve(["sess-status", "sess-project", "sess-both", "sess-none"]),
        );
        mockGetSharedSession.mockImplementation((id: string) =>
            Promise.resolve({ userId: "user-1", sessionId: id } as any),
        );
        mockGetSubscriptionFilters.mockImplementation((sid: string, _type: string) => {
            if (sid === "sess-status") return Promise.resolve([{ subscriptionId: "sub-status", filters: [{ field: "status", value: "shipped" }] }]);
            if (sid === "sess-project") return Promise.resolve([{ subscriptionId: "sub-project", filters: [{ field: "project", value: "PizzaPi" }] }]);
            if (sid === "sess-both") return Promise.resolve([{ subscriptionId: "sub-both", filters: [{ field: "status", value: "shipped" }, { field: "project", value: "Other" }], filterMode: "and" }]);
            if (sid === "sess-none") return Promise.resolve([]);
            return Promise.resolve([]);
        });
        const emitMock = mock(() => {});
        mockGetLocalTuiSocket.mockReturnValue({ connected: true, emit: emitMock });

        const [req, url] = makeReq(
            "POST", "/api/runners/runner-A/trigger-broadcast",
            { type: "svc:event", payload: { status: "shipped", project: "PizzaPi" }, source: "test" },
            { "x-api-key": "test-key" },
        );
        const res = await handleTriggersRoute(req, url);
        const body = await res!.json();
        expect(body.delivered).toBe(3);
    });

    test("filters with OR mode — any filter matching delivers", async () => {
        mockGetSubscribersForTrigger.mockReturnValue(
            Promise.resolve(["sess-or-match", "sess-or-miss"]),
        );
        mockGetSharedSession.mockImplementation((id: string) =>
            Promise.resolve({ userId: "user-1", sessionId: id } as any),
        );
        mockGetSubscriptionFilters.mockImplementation((sid: string, _type: string) => {
            if (sid === "sess-or-match") return Promise.resolve([{
                subscriptionId: "sub-or-match",
                filters: [{ field: "status", value: "shipped" }, { field: "project", value: "Other" }],
                filterMode: "or",
            }]);
            if (sid === "sess-or-miss") return Promise.resolve([{
                subscriptionId: "sub-or-miss",
                filters: [{ field: "status", value: "pending" }, { field: "project", value: "Other" }],
                filterMode: "or",
            }]);
            return Promise.resolve([]);
        });
        const emitMock = mock(() => {});
        mockGetLocalTuiSocket.mockReturnValue({ connected: true, emit: emitMock });

        const [req, url] = makeReq(
            "POST", "/api/runners/runner-A/trigger-broadcast",
            { type: "svc:event", payload: { status: "shipped", project: "PizzaPi" }, source: "test" },
            { "x-api-key": "test-key" },
        );
        const res = await handleTriggersRoute(req, url);
        const body = await res!.json();
        expect(body.delivered).toBe(1);
    });

    test("filters with contains op — substring matching", async () => {
        mockGetSubscribersForTrigger.mockReturnValue(
            Promise.resolve(["sess-contains"]),
        );
        mockGetSharedSession.mockImplementation((id: string) =>
            Promise.resolve({ userId: "user-1", sessionId: id } as any),
        );
        mockGetSubscriptionFilters.mockImplementation((_sid: string, _type: string) => {
            return Promise.resolve([{
                subscriptionId: "sub-contains",
                filters: [{ field: "message", value: "hello", op: "contains" }],
            }]);
        });
        const emitMock = mock(() => {});
        mockGetLocalTuiSocket.mockReturnValue({ connected: true, emit: emitMock });

        const [req, url] = makeReq(
            "POST", "/api/runners/runner-A/trigger-broadcast",
            { type: "svc:event", payload: { message: "Say Hello World!" }, source: "test" },
            { "x-api-key": "test-key" },
        );
        const res = await handleTriggersRoute(req, url);
        const body = await res!.json();
        expect(body.delivered).toBe(1);
    });

    test("legacy params fallback — old subscriptions without filters still work", async () => {
        mockGetSubscribersForTrigger.mockReturnValue(
            Promise.resolve(["sess-legacy"]),
        );
        mockGetSharedSession.mockImplementation((id: string) =>
            Promise.resolve({ userId: "user-1", sessionId: id } as any),
        );
        // getSubscriptionFilters returns undefined (no filters), falls back to legacy params
        mockGetSubscriptionFilters.mockReturnValue(Promise.resolve(undefined));
        mockGetSubscriptionParams.mockImplementation((_sid: string, _type: string) => {
            return Promise.resolve({ prNumber: 42 });
        });
        const emitMock = mock(() => {});
        mockGetLocalTuiSocket.mockReturnValue({ connected: true, emit: emitMock });

        // Payload matches prNumber=42
        const [req1, url1] = makeReq(
            "POST", "/api/runners/runner-A/trigger-broadcast",
            { type: "github:pr_comment", payload: { prNumber: 42, comment: "hi" }, source: "github" },
            { "x-api-key": "test-key" },
        );
        const res1 = await handleTriggersRoute(req1, url1);
        const body1 = await res1!.json();
        expect(body1.delivered).toBe(1);

        emitMock.mockClear();

        // Payload does NOT match prNumber=99
        const [req2, url2] = makeReq(
            "POST", "/api/runners/runner-A/trigger-broadcast",
            { type: "github:pr_comment", payload: { prNumber: 99, comment: "hi" }, source: "github" },
            { "x-api-key": "test-key" },
        );
        const res2 = await handleTriggersRoute(req2, url2);
        const body2 = await res2!.json();
        expect(body2.delivered).toBe(0);
    });

    test("filters with array value — matches if payload value is in array", async () => {
        mockGetSubscribersForTrigger.mockReturnValue(
            Promise.resolve(["sess-array"]),
        );
        mockGetSharedSession.mockImplementation((id: string) =>
            Promise.resolve({ userId: "user-1", sessionId: id } as any),
        );
        mockGetSubscriptionFilters.mockImplementation((_sid: string, _type: string) => {
            return Promise.resolve([{
                subscriptionId: "sub-array",
                filters: [{ field: "status", value: ["shipped", "review"] }],
            }]);
        });
        const emitMock = mock(() => {});
        mockGetLocalTuiSocket.mockReturnValue({ connected: true, emit: emitMock });

        // status=shipped matches [shipped, review]
        const [req, url] = makeReq(
            "POST", "/api/runners/runner-A/trigger-broadcast",
            { type: "svc:event", payload: { status: "shipped" }, source: "test" },
            { "x-api-key": "test-key" },
        );
        const res = await handleTriggersRoute(req, url);
        const body = await res!.json();
        expect(body.delivered).toBe(1);
    });
});

// ── PUT /api/sessions/:id/trigger-subscriptions/:triggerType ──────────
describe("PUT /api/sessions/:id/trigger-subscriptions/:triggerType", () => {
    beforeEach(() => {
        mockGetSharedSession.mockReset();
        mockValidateApiKey.mockReset();
        mockRequireSession.mockReset();
        mockUpdateSessionSubscription.mockReset();
        mockBroadcastToSessionViewers.mockReset();

        mockValidateApiKey.mockReturnValue(
            Promise.resolve({ userId: "user-1", userName: "TestUser" }),
        );
    });

    test("updates subscription params successfully", async () => {
        mockGetSharedSession.mockReturnValue(
            Promise.resolve({ userId: "user-1", runnerId: "runner-A" }),
        );
        mockGetRunnerServices.mockReturnValue(
            Promise.resolve({ serviceIds: [], triggerDefs: [{ type: "svc:event", label: "Event" }] }),
        );
        mockUpdateSessionSubscription.mockReturnValue(
            Promise.resolve({ updated: true, runnerId: "runner-A" }),
        );

        const [req, url] = makeReq(
            "PUT", "/api/sessions/session-1/trigger-subscriptions/svc:event",
            { params: { repo: "pizzapi" } },
            { "x-api-key": "test-key" },
        );
        const res = await handleTriggersRoute(req, url);
        expect(res).toBeTruthy();
        const body = await res!.json();
        expect(body.ok).toBe(true);
        expect(body.triggerType).toBe("svc:event");
        expect(body.runnerId).toBe("runner-A");
        expect(body.params).toEqual({ repo: "pizzapi" });
    });

    test("returns 404 when session is not subscribed", async () => {
        mockGetSharedSession.mockReturnValue(
            Promise.resolve({ userId: "user-1", runnerId: "runner-A" }),
        );
        mockGetRunnerServices.mockReturnValue(
            Promise.resolve({ serviceIds: [], triggerDefs: [{ type: "svc:event", label: "Event" }] }),
        );
        mockUpdateSessionSubscription.mockReturnValue(
            Promise.resolve({ updated: false }),
        );

        const [req, url] = makeReq(
            "PUT", "/api/sessions/session-1/trigger-subscriptions/svc:event",
            { params: { repo: "pizzapi" } },
            { "x-api-key": "test-key" },
        );
        const res = await handleTriggersRoute(req, url);
        expect(res).toBeTruthy();
        expect(res!.status).toBe(404);
    });

    test("returns 404 when session not found", async () => {
        mockGetSharedSession.mockReturnValue(Promise.resolve(null));

        const [req, url] = makeReq(
            "PUT", "/api/sessions/session-1/trigger-subscriptions/svc:event",
            { params: { repo: "new" } },
            { "x-api-key": "test-key" },
        );
        const res = await handleTriggersRoute(req, url);
        expect(res).toBeTruthy();
        expect(res!.status).toBe(404);
    });

    test("updates filters and filterMode", async () => {
        mockGetSharedSession.mockReturnValue(
            Promise.resolve({ userId: "user-1", runnerId: "runner-A" }),
        );
        mockGetRunnerServices.mockReturnValue(
            Promise.resolve({ serviceIds: [], triggerDefs: [{ type: "svc:event", label: "Event", schema: { properties: { status: { type: "string" } } } }] }),
        );
        mockUpdateSessionSubscription.mockReturnValue(
            Promise.resolve({ updated: true, runnerId: "runner-A" }),
        );

        const [req, url] = makeReq(
            "PUT", "/api/sessions/session-1/trigger-subscriptions/svc:event",
            { filters: [{ field: "status", value: "shipped" }], filterMode: "or" },
            { "x-api-key": "test-key" },
        );
        const res = await handleTriggersRoute(req, url);
        const body = await res!.json();
        expect(body.ok).toBe(true);
        expect(body.filters).toEqual([{ field: "status", value: "shipped", op: "eq" }]);
        expect(body.filterMode).toBe("or");
    });

    test("broadcasts trigger_subscriptions_changed with action 'update'", async () => {
        mockGetSharedSession.mockReturnValue(
            Promise.resolve({ userId: "user-1", runnerId: "runner-A" }),
        );
        mockGetRunnerServices.mockReturnValue(
            Promise.resolve({ serviceIds: [], triggerDefs: [{ type: "svc:event", label: "Event" }] }),
        );
        mockUpdateSessionSubscription.mockReturnValue(
            Promise.resolve({ updated: true, runnerId: "runner-A" }),
        );

        const [req, url] = makeReq(
            "PUT", "/api/sessions/session-1/trigger-subscriptions/svc:event",
            { params: { repo: "new" } },
            { "x-api-key": "test-key" },
        );
        await handleTriggersRoute(req, url);
        expect(mockBroadcastToSessionViewers).toHaveBeenCalledWith(
            "session-1", "trigger_subscriptions_changed", { triggerType: "svc:event", action: "update" },
        );
    });
});

describe("POST /api/runners/:runnerId/trigger-broadcast — filter-based delivery", () => {
    beforeEach(() => {
        mockGetSharedSession.mockReset();
        mockGetLocalTuiSocket.mockReset();
        mockEmitToRelaySessionVerified.mockReset();
        mockGetSubscriptionParams.mockReset();
        mockGetSubscriptionParams.mockReturnValue(Promise.resolve(undefined));
        mockGetSubscriptionFilters.mockReset();
        mockGetSubscriptionFilters.mockReturnValue(Promise.resolve(undefined));
    });

    test("delivers once when one of multiple same-type subscriptions matches", async () => {
        mockGetSubscribersForTrigger.mockReturnValue(Promise.resolve(["sess-1"]));
        mockGetSharedSession.mockImplementation((id: string) =>
            Promise.resolve({ userId: "user-1", sessionId: id } as any),
        );
        mockGetSubscriptionFilters.mockImplementation((_sid: string, _type: string) => Promise.resolve([
            { subscriptionId: "sub-nope", filters: [{ field: "status", value: "pending" }] },
            { subscriptionId: "sub-hit", filters: [{ field: "status", value: "shipped" }] },
        ]));
        const emitMock = mock(() => {});
        mockGetLocalTuiSocket.mockReturnValue({ connected: true, emit: emitMock });

        const [req, url] = makeReq(
            "POST", "/api/runners/runner-A/trigger-broadcast",
            { type: "svc:event", payload: { status: "shipped" }, source: "test" },
            { "x-api-key": "test-key" },
        );
        const res = await handleTriggersRoute(req, url);
        const body = await res!.json();
        expect(body.delivered).toBe(1);
        expect(emitMock).toHaveBeenCalledTimes(1);
    });

    test("does not duplicate delivery when multiple same-type subscriptions match", async () => {
        mockGetSubscribersForTrigger.mockReturnValue(Promise.resolve(["sess-1"]));
        mockGetSharedSession.mockImplementation((id: string) =>
            Promise.resolve({ userId: "user-1", sessionId: id } as any),
        );
        mockGetSubscriptionFilters.mockImplementation((_sid: string, _type: string) => Promise.resolve([
            { subscriptionId: "sub-hit-1", filters: [{ field: "status", value: "shipped" }] },
            { subscriptionId: "sub-hit-2", filters: [{ field: "project", value: "PizzaPi" }] },
        ]));
        const emitMock = mock(() => {});
        mockGetLocalTuiSocket.mockReturnValue({ connected: true, emit: emitMock });

        const [req, url] = makeReq(
            "POST", "/api/runners/runner-A/trigger-broadcast",
            { type: "svc:event", payload: { status: "shipped", project: "PizzaPi" }, source: "test" },
            { "x-api-key": "test-key" },
        );
        const res = await handleTriggersRoute(req, url);
        const body = await res!.json();
        expect(body.delivered).toBe(1);
        expect(emitMock).toHaveBeenCalledTimes(1);
    });
});

describe("POST /api/runners/:runnerId/trigger-broadcast — auto-spawn listeners", () => {
    beforeEach(() => {
        mockGetSharedSession.mockReset();
        mockGetLocalTuiSocket.mockReset();
        mockEmitToRelaySessionVerified.mockReset();
        mockBroadcastToSessionViewers.mockReset();
        mockGetSubscribersForTrigger.mockReset();
        mockGetSubscribersForTrigger.mockReturnValue(Promise.resolve([]));
        mockGetSubscriptionParams.mockReset();
        mockGetSubscriptionParams.mockReturnValue(Promise.resolve(undefined));
        mockGetSubscriptionFilters.mockReset();
        mockGetSubscriptionFilters.mockReturnValue(Promise.resolve(undefined));
        mockGetRunnerListenerTypes.mockReset();
        mockGetRunnerTriggerListener.mockReset();
        mockGetLocalRunnerSocket.mockReset();
        mockRecordRunnerSession.mockReset();
        mockRecordRunnerSession.mockReturnValue(Promise.resolve());
        mockLinkSessionToRunner.mockReset();
        mockLinkSessionToRunner.mockReturnValue(Promise.resolve());
        mockPushTriggerHistory.mockReset();
        mockPushTriggerHistory.mockReturnValue(Promise.resolve());
    });

    test("prepends the listener prompt into the spawned trigger payload", async () => {
        const runnerEmitMock = mock(() => {});
        const sessionEmitMock = mock(() => {});

        mockGetRunnerListenerTypes.mockReturnValue(Promise.resolve(["svc:event"]));
        mockGetRunnerTriggerListener.mockReturnValue(Promise.resolve({
            triggerType: "svc:event",
            prompt: "Focus on the failing tests first.",
            createdAt: "2026-03-29T00:00:00.000Z",
        } as any));
        mockGetLocalRunnerSocket.mockReturnValue({ connected: true, emit: runnerEmitMock } as any);
        mockGetLocalTuiSocket.mockReturnValue({ connected: true, emit: sessionEmitMock } as any);
        mockGetSharedSession.mockReturnValue(Promise.resolve({ userId: "user-1", sessionId: "sess-1" } as any));

        const [req, url] = makeReq(
            "POST", "/api/runners/runner-A/trigger-broadcast",
            { type: "svc:event", payload: { message: "hello" }, source: "svc" },
            { "x-api-key": "test-key" },
        );
        const res = await handleTriggersRoute(req, url);
        expect(res?.status).toBe(200);

        expect(runnerEmitMock).toHaveBeenCalledWith("new_session", expect.objectContaining({
            prompt: "Focus on the failing tests first.",
        }));
        expect(sessionEmitMock).toHaveBeenCalledWith("session_trigger", expect.objectContaining({
            trigger: expect.objectContaining({
                payload: expect.objectContaining({
                    message: "hello",
                    prompt: "Focus on the failing tests first.",
                }),
            }),
        }));
    });

    test("spawns one session per matching auto-spawn listener", async () => {
        const runnerEmitMock = mock(() => {});
        const sessionEmitMock = mock(() => {});

        mockGetRunnerListenerTypes.mockReturnValue(Promise.resolve(["svc:event"]));
        mockGetRunnerTriggerListener.mockReturnValue(Promise.resolve([
            {
                listenerId: "listener-1",
                triggerType: "svc:event",
                prompt: "first prompt",
                createdAt: "2026-03-29T00:00:00.000Z",
            },
            {
                listenerId: "listener-2",
                triggerType: "svc:event",
                prompt: "second prompt",
                createdAt: "2026-03-29T00:00:01.000Z",
            },
        ] as any));
        mockGetLocalRunnerSocket.mockReturnValue({ connected: true, emit: runnerEmitMock } as any);
        mockGetLocalTuiSocket.mockReturnValue({ connected: true, emit: sessionEmitMock } as any);
        mockGetSharedSession.mockReturnValue(Promise.resolve({ userId: "user-1", sessionId: "sess-1" } as any));

        const [req, url] = makeReq(
            "POST", "/api/runners/runner-A/trigger-broadcast",
            { type: "svc:event", payload: { message: "hello" }, source: "svc" },
            { "x-api-key": "test-key" },
        );
        const res = await handleTriggersRoute(req, url);
        expect(res?.status).toBe(200);

        const body = await res!.json();
        expect(body.spawned).toBe(2);
        expect(runnerEmitMock).toHaveBeenCalledTimes(2);
        expect(sessionEmitMock).toHaveBeenCalledTimes(2);
        expect(sessionEmitMock).toHaveBeenNthCalledWith(1, "session_trigger", expect.objectContaining({
            trigger: expect.objectContaining({
                payload: expect.objectContaining({ prompt: "first prompt" }),
            }),
        }));
        expect(sessionEmitMock).toHaveBeenNthCalledWith(2, "session_trigger", expect.objectContaining({
            trigger: expect.objectContaining({
                payload: expect.objectContaining({ prompt: "second prompt" }),
            }),
        }));
    });
});

describe("non-matching routes", () => {
    test("returns undefined for unmatched paths", async () => {
        const [req, url] = makeReq("GET", "/api/something-else");
        const res = await handleTriggersRoute(req, url);
        expect(res).toBeUndefined();
    });
});
