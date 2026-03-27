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

describe("non-matching routes", () => {
    test("returns undefined for unmatched paths", async () => {
        const [req, url] = makeReq("GET", "/api/something-else");
        const res = await handleTriggersRoute(req, url);
        expect(res).toBeUndefined();
    });
});
