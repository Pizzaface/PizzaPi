/**
 * Tests for the Webhooks API route handler.
 *
 * Tests CRUD, HMAC validation, event filtering, disabled webhook behavior,
 * and spawn-on-fire — all with mocked dependencies.
 */

import { describe, test, expect, beforeEach, afterAll, mock } from "bun:test";

afterAll(() => mock.restore());
import { createHmac } from "crypto";

// ── Helper: compute HMAC-SHA256 ──────────────────────────────────────────────
function signBody(secret: string, body: string): string {
    return createHmac("sha256", secret).update(body).digest("hex");
}

// ── Mock webhook store ───────────────────────────────────────────────────────
const mockCreateWebhook = mock((_input: any) =>
    Promise.resolve({
        id: "wh-1",
        userId: "user-1",
        name: "Test Hook",
        secret: "test-secret-abc",
        eventFilter: null as string[] | null,
        source: "custom",
        cwd: null as string | null,
        prompt: null as string | null,
        enabled: true,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
    }),
);
const mockGetWebhook = mock((_id: string) => Promise.resolve(null as any));
const mockListWebhooksForUser = mock((_userId: string) => Promise.resolve([] as any[]));
const mockUpdateWebhook = mock((_id: string, _userId: string, _input: any) =>
    Promise.resolve(null as any),
);
const mockDeleteWebhook = mock((_id: string, _userId: string) => Promise.resolve(false));

mock.module("../webhooks/store.js", () => ({
    createWebhook: mockCreateWebhook,
    getWebhook: mockGetWebhook,
    listWebhooksForUser: mockListWebhooksForUser,
    updateWebhook: mockUpdateWebhook,
    deleteWebhook: mockDeleteWebhook,
}));

// ── Mock sio-registry ────────────────────────────────────────────────────────
const mockGetSharedSession = mock((_id: string) => Promise.resolve(null as any));
const mockGetLocalTuiSocket = mock((_id: string) => null as any);
const mockEmitToRelaySessionVerified = mock(
    (_id: string, _event: string, _data: any) => Promise.resolve(false),
);
const mockBroadcastToSessionViewers = mock((_sid: string, _event: string, _data: any) => {});
const mockGetRunners = mock((_userId?: string) => Promise.resolve([] as any[]));
const mockGetLocalRunnerSocket = mock((_runnerId: string) => null as any);
const mockRecordRunnerSession = mock((_runnerId: string, _sessionId: string) => Promise.resolve());
const mockLinkSessionToRunner = mock((_runnerId: string, _sessionId: string) => Promise.resolve());

mock.module("../ws/sio-registry.js", () => ({
    getSharedSession: mockGetSharedSession,
    getLocalTuiSocket: mockGetLocalTuiSocket,
    emitToRelaySessionVerified: mockEmitToRelaySessionVerified,
    broadcastToSessionViewers: mockBroadcastToSessionViewers,
    getRunners: mockGetRunners,
    getLocalRunnerSocket: mockGetLocalRunnerSocket,
    recordRunnerSession: mockRecordRunnerSession,
    linkSessionToRunner: mockLinkSessionToRunner,
}));

// ── Mock runner-control ──────────────────────────────────────────────────────
const mockWaitForSpawnAck = mock((_sessionId: string, _timeoutMs: number) =>
    Promise.resolve({ ok: true }),
);

mock.module("../ws/runner-control.js", () => ({
    waitForSpawnAck: mockWaitForSpawnAck,
}));

// ── Mock middleware ──────────────────────────────────────────────────────────
const mockRequireSession = mock((_req: Request) =>
    Promise.resolve({ userId: "user-1", userName: "TestUser" } as any),
);

mock.module("../middleware.js", () => ({
    requireSession: mockRequireSession,
}));

// ── Mock trigger store ───────────────────────────────────────────────────────
const mockPushTriggerHistory = mock((_sid: string, _entry: any) => Promise.resolve());

mock.module("../sessions/trigger-store.js", () => ({
    pushTriggerHistory: mockPushTriggerHistory,
}));

// Import AFTER mocks
const { handleWebhooksRoute } = await import("./webhooks.js");

// ── Test helpers ──────────────────────────────────────────────────────────────

function makeReq(
    method: string,
    path: string,
    body?: object | string,
    headers?: Record<string, string>,
): [Request, URL] {
    const url = new URL(`http://localhost${path}`);
    const init: RequestInit = {
        method,
        headers: { "content-type": "application/json", ...headers },
    };
    if (body !== undefined) {
        init.body = typeof body === "string" ? body : JSON.stringify(body);
    }
    return [new Request(url.toString(), init), url];
}

function makeFireReq(
    path: string,
    body: object,
    secret: string,
    extraHeaders?: Record<string, string>,
): [Request, URL] {
    const rawBody = JSON.stringify(body);
    const sig = signBody(secret, rawBody);
    return makeReq("POST", path, rawBody, {
        "x-webhook-signature": sig,
        ...extraHeaders,
    });
}

// ── CRUD tests ────────────────────────────────────────────────────────────────

describe("POST /api/webhooks — create webhook", () => {
    beforeEach(() => {
        mockRequireSession.mockReset();
        mockCreateWebhook.mockReset();
        mockRequireSession.mockReturnValue(
            Promise.resolve({ userId: "user-1", userName: "TestUser" }),
        );
    });

    test("returns 401 when not authenticated", async () => {
        mockRequireSession.mockReturnValue(
            Promise.resolve(Response.json({ error: "Unauthorized" }, { status: 401 })) as any,
        );
        const [req, url] = makeReq("POST", "/api/webhooks", { name: "Hook", source: "custom" });
        const res = await handleWebhooksRoute(req, url);
        expect(res?.status).toBe(401);
    });

    test("returns 400 when name is missing", async () => {
        const [req, url] = makeReq("POST", "/api/webhooks", { source: "custom" });
        const res = await handleWebhooksRoute(req, url);
        expect(res?.status).toBe(400);
        const body = await res!.json();
        expect(body.error).toContain("name");
    });

    test("returns 400 when source is missing", async () => {
        const [req, url] = makeReq("POST", "/api/webhooks", { name: "Hook" });
        const res = await handleWebhooksRoute(req, url);
        expect(res?.status).toBe(400);
        const body = await res!.json();
        expect(body.error).toContain("source");
    });

    test("returns 400 when eventFilter is not array of strings", async () => {
        const [req, url] = makeReq("POST", "/api/webhooks", {
            name: "Hook",
            source: "custom",
            eventFilter: "push",
        });
        const res = await handleWebhooksRoute(req, url);
        expect(res?.status).toBe(400);
    });

    test("creates webhook and returns 201", async () => {
        const created = {
            id: "wh-1",
            userId: "user-1",
            name: "My Hook",
            secret: "abc123",
            eventFilter: null,
            source: "custom",
            cwd: null,
            prompt: null,
            enabled: true,
            createdAt: "2026-01-01T00:00:00Z",
            updatedAt: "2026-01-01T00:00:00Z",
        };
        mockCreateWebhook.mockReturnValue(Promise.resolve(created));

        const [req, url] = makeReq("POST", "/api/webhooks", {
            name: "My Hook",
            source: "custom",
        });
        const res = await handleWebhooksRoute(req, url);
        expect(res?.status).toBe(201);
        const body = await res!.json();
        expect(body.webhook.id).toBe("wh-1");
        expect(body.webhook.secret).toBe("abc123");
    });

    test("creates webhook with cwd and prompt", async () => {
        const created = {
            id: "wh-2",
            userId: "user-1",
            name: "Deploy Hook",
            secret: "abc123",
            eventFilter: null,
            source: "custom",
            cwd: "/srv/my-project",
            prompt: "Handle this deploy event",
            enabled: true,
            createdAt: "2026-01-01T00:00:00Z",
            updatedAt: "2026-01-01T00:00:00Z",
        };
        mockCreateWebhook.mockReturnValue(Promise.resolve(created));

        const [req, url] = makeReq("POST", "/api/webhooks", {
            name: "Deploy Hook",
            source: "custom",
            cwd: "/srv/my-project",
            prompt: "Handle this deploy event",
        });
        const res = await handleWebhooksRoute(req, url);
        expect(res?.status).toBe(201);
        const body = await res!.json();
        expect(body.webhook.cwd).toBe("/srv/my-project");
        expect(body.webhook.prompt).toBe("Handle this deploy event");
    });

    test("creates webhook with eventFilter", async () => {
        const created = {
            id: "wh-3",
            userId: "user-1",
            name: "Filtered Hook",
            secret: "abc123",
            eventFilter: ["deploy", "build"],
            source: "custom",
            cwd: null,
            prompt: null,
            enabled: true,
            createdAt: "2026-01-01T00:00:00Z",
            updatedAt: "2026-01-01T00:00:00Z",
        };
        mockCreateWebhook.mockReturnValue(Promise.resolve(created));

        const [req, url] = makeReq("POST", "/api/webhooks", {
            name: "Filtered Hook",
            source: "custom",
            eventFilter: ["deploy", "build"],
        });
        const res = await handleWebhooksRoute(req, url);
        expect(res?.status).toBe(201);
        const body = await res!.json();
        expect(body.webhook.eventFilter).toEqual(["deploy", "build"]);
    });
});

describe("GET /api/webhooks — list webhooks", () => {
    beforeEach(() => {
        mockRequireSession.mockReset();
        mockListWebhooksForUser.mockReset();
        mockRequireSession.mockReturnValue(
            Promise.resolve({ userId: "user-1", userName: "TestUser" }),
        );
    });

    test("returns 401 when not authenticated", async () => {
        mockRequireSession.mockReturnValue(
            Promise.resolve(Response.json({ error: "Unauthorized" }, { status: 401 })) as any,
        );
        const [req, url] = makeReq("GET", "/api/webhooks");
        const res = await handleWebhooksRoute(req, url);
        expect(res?.status).toBe(401);
    });

    test("returns empty list when no webhooks", async () => {
        mockListWebhooksForUser.mockReturnValue(Promise.resolve([]));
        const [req, url] = makeReq("GET", "/api/webhooks");
        const res = await handleWebhooksRoute(req, url);
        expect(res?.status).toBe(200);
        const body = await res!.json();
        expect(body.webhooks).toEqual([]);
    });

    test("returns user's webhooks", async () => {
        mockListWebhooksForUser.mockReturnValue(
            Promise.resolve([
                {
                    id: "wh-1",
                    userId: "user-1",
                    name: "Hook 1",
                    source: "custom",
                    enabled: true,
                },
            ]),
        );
        const [req, url] = makeReq("GET", "/api/webhooks");
        const res = await handleWebhooksRoute(req, url);
        expect(res?.status).toBe(200);
        const body = await res!.json();
        expect(body.webhooks).toHaveLength(1);
        expect(body.webhooks[0].id).toBe("wh-1");
    });
});

describe("GET /api/webhooks/:id — get webhook", () => {
    beforeEach(() => {
        mockRequireSession.mockReset();
        mockGetWebhook.mockReset();
        mockRequireSession.mockReturnValue(
            Promise.resolve({ userId: "user-1", userName: "TestUser" }),
        );
    });

    test("returns 404 when webhook not found", async () => {
        mockGetWebhook.mockReturnValue(Promise.resolve(null));
        const [req, url] = makeReq("GET", "/api/webhooks/missing");
        const res = await handleWebhooksRoute(req, url);
        expect(res?.status).toBe(404);
    });

    test("returns 404 when webhook belongs to different user", async () => {
        mockGetWebhook.mockReturnValue(
            Promise.resolve({ id: "wh-1", userId: "user-2", name: "Hook" }),
        );
        const [req, url] = makeReq("GET", "/api/webhooks/wh-1");
        const res = await handleWebhooksRoute(req, url);
        expect(res?.status).toBe(404);
    });

    test("returns webhook details", async () => {
        const hook = { id: "wh-1", userId: "user-1", name: "Hook 1", source: "custom", enabled: true };
        mockGetWebhook.mockReturnValue(Promise.resolve(hook));
        const [req, url] = makeReq("GET", "/api/webhooks/wh-1");
        const res = await handleWebhooksRoute(req, url);
        expect(res?.status).toBe(200);
        const body = await res!.json();
        expect(body.webhook.id).toBe("wh-1");
    });
});

describe("PUT /api/webhooks/:id — update webhook", () => {
    beforeEach(() => {
        mockRequireSession.mockReset();
        mockGetWebhook.mockReset();
        mockUpdateWebhook.mockReset();
        mockRequireSession.mockReturnValue(
            Promise.resolve({ userId: "user-1", userName: "TestUser" }),
        );
    });

    test("returns 404 when webhook not found", async () => {
        mockGetWebhook.mockReturnValue(Promise.resolve(null));
        const [req, url] = makeReq("PUT", "/api/webhooks/missing", { name: "New Name" });
        const res = await handleWebhooksRoute(req, url);
        expect(res?.status).toBe(404);
    });

    test("returns 400 when eventFilter is invalid", async () => {
        mockGetWebhook.mockReturnValue(
            Promise.resolve({ id: "wh-1", userId: "user-1", name: "Hook" }),
        );
        const [req, url] = makeReq("PUT", "/api/webhooks/wh-1", { eventFilter: "bad" });
        const res = await handleWebhooksRoute(req, url);
        expect(res?.status).toBe(400);
    });

    test("updates webhook", async () => {
        mockGetWebhook.mockReturnValue(
            Promise.resolve({ id: "wh-1", userId: "user-1", name: "Hook" }),
        );
        const updated = { id: "wh-1", userId: "user-1", name: "Updated", source: "custom", enabled: true };
        mockUpdateWebhook.mockReturnValue(Promise.resolve(updated));

        const [req, url] = makeReq("PUT", "/api/webhooks/wh-1", { name: "Updated", enabled: false });
        const res = await handleWebhooksRoute(req, url);
        expect(res?.status).toBe(200);
        const body = await res!.json();
        expect(body.webhook.id).toBe("wh-1");
    });

    test("updates cwd and prompt", async () => {
        mockGetWebhook.mockReturnValue(
            Promise.resolve({ id: "wh-1", userId: "user-1", name: "Hook" }),
        );
        const updated = {
            id: "wh-1", userId: "user-1", name: "Hook",
            cwd: "/new/path", prompt: "Do the thing",
        };
        mockUpdateWebhook.mockReturnValue(Promise.resolve(updated));

        const [req, url] = makeReq("PUT", "/api/webhooks/wh-1", {
            cwd: "/new/path",
            prompt: "Do the thing",
        });
        const res = await handleWebhooksRoute(req, url);
        expect(res?.status).toBe(200);
        expect(mockUpdateWebhook).toHaveBeenCalledTimes(1);
        const call = mockUpdateWebhook.mock.calls[0] as any[];
        expect(call[2].cwd).toBe("/new/path");
        expect(call[2].prompt).toBe("Do the thing");
    });

    test("can clear eventFilter by setting to null", async () => {
        mockGetWebhook.mockReturnValue(
            Promise.resolve({ id: "wh-1", userId: "user-1", name: "Hook" }),
        );
        const updated = { id: "wh-1", userId: "user-1", name: "Hook", eventFilter: null };
        mockUpdateWebhook.mockReturnValue(Promise.resolve(updated));

        const [req, url] = makeReq("PUT", "/api/webhooks/wh-1", { eventFilter: null });
        const res = await handleWebhooksRoute(req, url);
        expect(res?.status).toBe(200);
        expect(mockUpdateWebhook).toHaveBeenCalledTimes(1);
    });
});

describe("DELETE /api/webhooks/:id — delete webhook", () => {
    beforeEach(() => {
        mockRequireSession.mockReset();
        mockDeleteWebhook.mockReset();
        mockRequireSession.mockReturnValue(
            Promise.resolve({ userId: "user-1", userName: "TestUser" }),
        );
    });

    test("returns 404 when webhook not found", async () => {
        mockDeleteWebhook.mockReturnValue(Promise.resolve(false));
        const [req, url] = makeReq("DELETE", "/api/webhooks/missing");
        const res = await handleWebhooksRoute(req, url);
        expect(res?.status).toBe(404);
    });

    test("deletes webhook and returns ok", async () => {
        mockDeleteWebhook.mockReturnValue(Promise.resolve(true));
        const [req, url] = makeReq("DELETE", "/api/webhooks/wh-1");
        const res = await handleWebhooksRoute(req, url);
        expect(res?.status).toBe(200);
        const body = await res!.json();
        expect(body.ok).toBe(true);
    });
});

// ── Fire endpoint tests ───────────────────────────────────────────────────────

const ACTIVE_WEBHOOK = {
    id: "wh-1",
    userId: "user-1",
    name: "Test Hook",
    secret: "test-secret-xyz",
    eventFilter: null,
    source: "custom",
    cwd: "/srv/project",
    prompt: "Handle this webhook",
    enabled: true,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
};

const MOCK_RUNNER = { runnerId: "runner-1", userId: "user-1", name: "My Runner", roots: [] };

/**
 * Set up mocks so that fire spawns a session and delivers the trigger.
 */
function setupSpawnAndDeliverMocks() {
    mockGetRunners.mockReturnValue(Promise.resolve([MOCK_RUNNER]));
    const runnerEmitMock = mock(() => {});
    mockGetLocalRunnerSocket.mockReturnValue({ emit: runnerEmitMock });
    mockWaitForSpawnAck.mockReturnValue(Promise.resolve({ ok: true }));

    // After spawn, the session socket must appear
    const sessionEmitMock = mock(() => {});
    mockGetLocalTuiSocket.mockReturnValue({ connected: true, emit: sessionEmitMock });
    mockGetSharedSession.mockReturnValue(Promise.resolve({ userId: "user-1" }));

    return { runnerEmitMock, sessionEmitMock };
}

describe("POST /api/webhooks/:id/fire — HMAC validation", () => {
    beforeEach(() => {
        mockGetWebhook.mockReset();
        mockGetSharedSession.mockReset();
        mockGetLocalTuiSocket.mockReset();
        mockEmitToRelaySessionVerified.mockReset();
        mockPushTriggerHistory.mockReset();
        mockGetRunners.mockReset();
        mockGetLocalRunnerSocket.mockReset();
        mockWaitForSpawnAck.mockReset();
        mockRecordRunnerSession.mockReset();
        mockLinkSessionToRunner.mockReset();
    });

    test("returns 404 for unknown webhook", async () => {
        mockGetWebhook.mockReturnValue(Promise.resolve(null));
        const [req, url] = makeReq("POST", "/api/webhooks/missing/fire", { event: "test" });
        const res = await handleWebhooksRoute(req, url);
        expect(res?.status).toBe(404);
    });

    test("returns 404 for disabled webhook", async () => {
        mockGetWebhook.mockReturnValue(
            Promise.resolve({ ...ACTIVE_WEBHOOK, enabled: false }),
        );
        const [req, url] = makeReq("POST", "/api/webhooks/wh-1/fire", { event: "test" });
        const res = await handleWebhooksRoute(req, url);
        expect(res?.status).toBe(404);
    });

    test("returns 401 when X-Webhook-Signature is missing", async () => {
        mockGetWebhook.mockReturnValue(Promise.resolve(ACTIVE_WEBHOOK));
        const [req, url] = makeReq("POST", "/api/webhooks/wh-1/fire", { event: "test" });
        const res = await handleWebhooksRoute(req, url);
        expect(res?.status).toBe(401);
        const body = await res!.json();
        expect(body.error).toContain("X-Webhook-Signature");
    });

    test("returns 401 when signature is invalid", async () => {
        mockGetWebhook.mockReturnValue(Promise.resolve(ACTIVE_WEBHOOK));
        const [req, url] = makeReq(
            "POST",
            "/api/webhooks/wh-1/fire",
            JSON.stringify({ event: "test" }),
            { "x-webhook-signature": "bad-signature" },
        );
        const res = await handleWebhooksRoute(req, url);
        expect(res?.status).toBe(401);
        const body = await res!.json();
        expect(body.error).toContain("signature");
    });

    test("spawns session and delivers trigger on valid HMAC", async () => {
        mockGetWebhook.mockReturnValue(Promise.resolve(ACTIVE_WEBHOOK));
        const { sessionEmitMock } = setupSpawnAndDeliverMocks();

        const body = { event: "deploy", repo: "test/repo" };
        const [req, url] = makeFireReq("/api/webhooks/wh-1/fire", body, ACTIVE_WEBHOOK.secret);
        const res = await handleWebhooksRoute(req, url);
        expect(res?.status).toBe(200);
        const resBody = await res!.json();
        expect(resBody.ok).toBe(true);
        expect(resBody.triggerId).toMatch(/^wh_/);
        expect(resBody.sessionId).toBeTruthy();

        // Session should have received the trigger
        expect(sessionEmitMock).toHaveBeenCalledTimes(1);
        expect(mockPushTriggerHistory).toHaveBeenCalledTimes(1);
        // Runner spawn should have been called
        expect(mockRecordRunnerSession).toHaveBeenCalledTimes(1);
        expect(mockLinkSessionToRunner).toHaveBeenCalledTimes(1);
    });

    test("returns 503 when no runner is connected", async () => {
        mockGetWebhook.mockReturnValue(Promise.resolve(ACTIVE_WEBHOOK));
        mockGetRunners.mockReturnValue(Promise.resolve([]));

        const body = { event: "test" };
        const [req, url] = makeFireReq("/api/webhooks/wh-1/fire", body, ACTIVE_WEBHOOK.secret);
        const res = await handleWebhooksRoute(req, url);
        expect(res?.status).toBe(503);
        const resBody = await res!.json();
        expect(resBody.error).toContain("runner");
    });
});

describe("POST /api/webhooks/:id/fire — event filtering", () => {
    beforeEach(() => {
        mockGetWebhook.mockReset();
        mockGetSharedSession.mockReset();
        mockGetLocalTuiSocket.mockReset();
        mockEmitToRelaySessionVerified.mockReset();
        mockPushTriggerHistory.mockReset();
        mockGetRunners.mockReset();
        mockGetLocalRunnerSocket.mockReset();
        mockWaitForSpawnAck.mockReset();
        mockRecordRunnerSession.mockReset();
        mockLinkSessionToRunner.mockReset();
    });

    const FILTERED_WEBHOOK = {
        ...ACTIVE_WEBHOOK,
        eventFilter: ["deploy", "build"],
        source: "custom",
    };

    test("forwards matching events", async () => {
        mockGetWebhook.mockReturnValue(Promise.resolve(FILTERED_WEBHOOK));
        const { sessionEmitMock } = setupSpawnAndDeliverMocks();

        const body = { type: "deploy", env: "production" };
        const [req, url] = makeFireReq("/api/webhooks/wh-1/fire", body, ACTIVE_WEBHOOK.secret);
        const res = await handleWebhooksRoute(req, url);
        expect(res?.status).toBe(200);
        const resBody = await res!.json();
        expect(resBody.ok).toBe(true);
        expect(resBody.filtered).toBeUndefined();
        expect(sessionEmitMock).toHaveBeenCalledTimes(1);
    });

    test("silently drops events not in filter", async () => {
        mockGetWebhook.mockReturnValue(Promise.resolve(FILTERED_WEBHOOK));

        const body = { type: "star", action: "created" };
        const [req, url] = makeFireReq("/api/webhooks/wh-1/fire", body, ACTIVE_WEBHOOK.secret);
        const res = await handleWebhooksRoute(req, url);
        expect(res?.status).toBe(200);
        const resBody = await res!.json();
        expect(resBody.ok).toBe(true);
        expect(resBody.filtered).toBe(true);
        // Should NOT have spawned or delivered anything
        expect(mockGetRunners).not.toHaveBeenCalled();
        expect(mockPushTriggerHistory).not.toHaveBeenCalled();
    });
});

describe("POST /api/webhooks/:id/fire — spawn behavior", () => {
    beforeEach(() => {
        mockGetWebhook.mockReset();
        mockGetSharedSession.mockReset();
        mockGetLocalTuiSocket.mockReset();
        mockEmitToRelaySessionVerified.mockReset();
        mockPushTriggerHistory.mockReset();
        mockGetRunners.mockReset();
        mockGetLocalRunnerSocket.mockReset();
        mockWaitForSpawnAck.mockReset();
        mockRecordRunnerSession.mockReset();
        mockLinkSessionToRunner.mockReset();
    });

    test("passes cwd and prompt to runner spawn", async () => {
        const hook = { ...ACTIVE_WEBHOOK, cwd: "/my/project", prompt: "Handle deploy" };
        mockGetWebhook.mockReturnValue(Promise.resolve(hook));

        mockGetRunners.mockReturnValue(Promise.resolve([MOCK_RUNNER]));
        const runnerEmitMock = mock(() => {});
        mockGetLocalRunnerSocket.mockReturnValue({ emit: runnerEmitMock });
        mockWaitForSpawnAck.mockReturnValue(Promise.resolve({ ok: true }));
        const sessionEmitMock = mock(() => {});
        mockGetLocalTuiSocket.mockReturnValue({ connected: true, emit: sessionEmitMock });

        const body = { event: "deploy" };
        const [req, url] = makeFireReq("/api/webhooks/wh-1/fire", body, hook.secret);
        const res = await handleWebhooksRoute(req, url);
        expect(res?.status).toBe(200);

        // Verify runner received cwd and prompt
        expect(runnerEmitMock).toHaveBeenCalledTimes(1);
        const spawnArgs = (runnerEmitMock.mock.calls[0] as any[])[1];
        expect(spawnArgs.cwd).toBe("/my/project");
        expect(spawnArgs.prompt).toBe("Handle deploy");
    });

    test("returns 502 when runner rejects spawn", async () => {
        mockGetWebhook.mockReturnValue(Promise.resolve(ACTIVE_WEBHOOK));
        mockGetRunners.mockReturnValue(Promise.resolve([MOCK_RUNNER]));
        const runnerEmitMock = mock(() => {});
        mockGetLocalRunnerSocket.mockReturnValue({ emit: runnerEmitMock });
        mockWaitForSpawnAck.mockReturnValue(Promise.resolve({ ok: false, message: "cwd not allowed" }));

        const body = { event: "test" };
        const [req, url] = makeFireReq("/api/webhooks/wh-1/fire", body, ACTIVE_WEBHOOK.secret);
        const res = await handleWebhooksRoute(req, url);
        expect(res?.status).toBe(502);
    });

    test("cross-node fallback delivery", async () => {
        mockGetWebhook.mockReturnValue(Promise.resolve(ACTIVE_WEBHOOK));
        mockGetRunners.mockReturnValue(Promise.resolve([MOCK_RUNNER]));
        const runnerEmitMock = mock(() => {});
        mockGetLocalRunnerSocket.mockReturnValue({ emit: runnerEmitMock });
        mockWaitForSpawnAck.mockReturnValue(Promise.resolve({ ok: true }));

        // No local socket, but shared session exists (cross-node)
        mockGetLocalTuiSocket.mockReturnValue(null);
        mockGetSharedSession.mockReturnValue(Promise.resolve({ userId: "user-1" }));
        mockEmitToRelaySessionVerified.mockReturnValue(Promise.resolve(true));

        const body = { event: "test" };
        const [req, url] = makeFireReq("/api/webhooks/wh-1/fire", body, ACTIVE_WEBHOOK.secret);
        const res = await handleWebhooksRoute(req, url);
        expect(res?.status).toBe(200);
        expect(mockEmitToRelaySessionVerified).toHaveBeenCalledTimes(1);
    });
});

describe("non-matching routes", () => {
    test("returns undefined for unmatched paths", async () => {
        const [req, url] = makeReq("GET", "/api/something-else");
        const res = await handleWebhooksRoute(req, url);
        expect(res).toBeUndefined();
    });

    test("returns undefined for unmatched webhook sub-paths", async () => {
        const [req, url] = makeReq("GET", "/api/webhooks/wh-1/unknown");
        const res = await handleWebhooksRoute(req, url);
        expect(res).toBeUndefined();
    });
});
