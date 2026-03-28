/**
 * Tests for the HTTP Trigger API route.
 *
 * Tests the route handler logic with mocked dependencies (Redis, SIO registry).
 */

import { describe, test, expect, beforeEach, mock } from "bun:test";

// ── Mock sio-registry ────────────────────────────────────────────────────
const mockGetSharedSession = mock((_id: string) => Promise.resolve(null as any));
const mockGetLocalTuiSocket = mock((_id: string) => null as any);
const mockEmitToRelaySessionVerified = mock((_id: string, _event: string, _data: any) => Promise.resolve(false));

mock.module("../ws/sio-registry.js", () => ({
    getSharedSession: mockGetSharedSession,
    getLocalTuiSocket: mockGetLocalTuiSocket,
    emitToRelaySessionVerified: mockEmitToRelaySessionVerified,
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
mock.module("../sessions/trigger-store.js", () => ({
    pushTriggerHistory: mockPushTriggerHistory,
    getTriggerHistory: mockGetTriggerHistory,
}));

// ── Mock trigger subscription store ─────────────────────────────────────
const mockSubscribeSessionToTrigger = mock((_sid: string, _rid: string, _type: string) => Promise.resolve());
const mockUnsubscribeSessionFromTrigger = mock((_sid: string, _type: string) => Promise.resolve());
const mockListSessionSubscriptions = mock((_sid: string) => Promise.resolve([] as any[]));
const mockGetSubscribersForTrigger = mock((_rid: string, _type: string) => Promise.resolve([] as string[]));
mock.module("../sessions/trigger-subscription-store.js", () => ({
    subscribeSessionToTrigger: mockSubscribeSessionToTrigger,
    unsubscribeSessionFromTrigger: mockUnsubscribeSessionFromTrigger,
    listSessionSubscriptions: mockListSessionSubscriptions,
    getSubscribersForTrigger: mockGetSubscribersForTrigger,
}));

// ── Mock runners registry ────────────────────────────────────────────────
const mockGetRunnerServices = mock((_rid: string) => Promise.resolve(null as any));
mock.module("../ws/sio-registry/runners.js", () => ({
    getRunnerServices: mockGetRunnerServices,
}));

// ── Mock logger ──────────────────────────────────────────────────────────
mock.module("@pizzapi/tools", () => ({
    createLogger: () => ({
        info: () => {},
        warn: () => {},
        error: () => {},
        debug: () => {},
    }),
}));

// Import AFTER mocks
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
            { triggerType: "godmother:idea_moved", runnerId: "runner-A" },
        ]));

        const [req, url] = makeReq("GET", "/api/sessions/sess-1/trigger-subscriptions");
        const res = await handleTriggersRoute(req, url);
        expect(res!.status).toBe(200);
        const body = await res!.json();
        expect(body.subscriptions).toHaveLength(1);
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

    test("subscribes to a declared trigger type", async () => {
        mockGetSharedSession.mockReturnValue(
            Promise.resolve({ userId: "user-1", sessionId: "sess-1", runnerId: "runner-A" } as any),
        );
        mockGetRunnerServices.mockReturnValue(Promise.resolve({
            serviceIds: ["godmother"],
            triggerDefs: [{ type: "godmother:idea_moved", label: "Idea Moved" }],
        }));

        const [req, url] = makeReq("POST", "/api/sessions/sess-1/trigger-subscriptions", {
            triggerType: "godmother:idea_moved",
        });
        const res = await handleTriggersRoute(req, url);
        expect(res!.status).toBe(200);
        const body = await res!.json();
        expect(body.ok).toBe(true);
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
        // Runner exists but hasn't re-announced → getRunnerServices returns null
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

describe("DELETE /api/sessions/:id/trigger-subscriptions/:triggerType", () => {
    beforeEach(() => {
        mockGetSharedSession.mockReset();
        mockUnsubscribeSessionFromTrigger.mockReset();
        mockRequireSession.mockReturnValue(
            Promise.resolve({ userId: "user-1", userName: "TestUser" }),
        );
    });

    test("unsubscribes from a trigger type", async () => {
        mockGetSharedSession.mockReturnValue(
            Promise.resolve({ userId: "user-1", sessionId: "sess-1", runnerId: "runner-A" } as any),
        );

        const [req, url] = makeReq("DELETE", "/api/sessions/sess-1/trigger-subscriptions/godmother:idea_moved");
        const res = await handleTriggersRoute(req, url);
        expect(res!.status).toBe(200);
        const body = await res!.json();
        expect(body.ok).toBe(true);
        expect(body.triggerType).toBe("godmother:idea_moved");
        expect(mockUnsubscribeSessionFromTrigger).toHaveBeenCalledTimes(1);
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
});

describe("non-matching routes", () => {
    test("returns undefined for unmatched paths", async () => {
        const [req, url] = makeReq("GET", "/api/something-else");
        const res = await handleTriggersRoute(req, url);
        expect(res).toBeUndefined();
    });
});
