/**
 * Tests for the Webhooks API route handler.
 *
 * Tests CRUD, HMAC validation, event filtering, disabled webhook behavior,
 * and GitHub event mapping — all with mocked dependencies.
 */

import { describe, test, expect, beforeEach, mock } from "bun:test";
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
        targetSessionId: "sess-1" as string | null,
        secret: "test-secret-abc",
        eventFilter: null as string[] | null,
        source: "custom",
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
const mockGetMostRecentActiveSessionId = mock((_userId: string) =>
    Promise.resolve(null as string | null),
);

mock.module("../webhooks/store.js", () => ({
    createWebhook: mockCreateWebhook,
    getWebhook: mockGetWebhook,
    listWebhooksForUser: mockListWebhooksForUser,
    updateWebhook: mockUpdateWebhook,
    deleteWebhook: mockDeleteWebhook,
    getMostRecentActiveSessionId: mockGetMostRecentActiveSessionId,
}));

// ── Mock sio-registry ────────────────────────────────────────────────────────
const mockGetSharedSession = mock((_id: string) => Promise.resolve(null as any));
const mockGetLocalTuiSocket = mock((_id: string) => null as any);
const mockEmitToRelaySessionVerified = mock(
    (_id: string, _event: string, _data: any) => Promise.resolve(false),
);

mock.module("../ws/sio-registry.js", () => ({
    getSharedSession: mockGetSharedSession,
    getLocalTuiSocket: mockGetLocalTuiSocket,
    emitToRelaySessionVerified: mockEmitToRelaySessionVerified,
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

// ── Mock logger ──────────────────────────────────────────────────────────────
mock.module("@pizzapi/tools", () => ({
    createLogger: () => ({
        info: () => {},
        warn: () => {},
        error: () => {},
        debug: () => {},
    }),
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
        const [req, url] = makeReq("POST", "/api/webhooks", { name: "Hook", source: "github" });
        const res = await handleWebhooksRoute(req, url);
        expect(res?.status).toBe(401);
    });

    test("returns 400 when name is missing", async () => {
        const [req, url] = makeReq("POST", "/api/webhooks", { source: "github" });
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
            source: "github",
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
            targetSessionId: null,
            secret: "abc123",
            eventFilter: null,
            source: "github",
            enabled: true,
            createdAt: "2026-01-01T00:00:00Z",
            updatedAt: "2026-01-01T00:00:00Z",
        };
        mockCreateWebhook.mockReturnValue(Promise.resolve(created));

        const [req, url] = makeReq("POST", "/api/webhooks", {
            name: "My Hook",
            source: "github",
        });
        const res = await handleWebhooksRoute(req, url);
        expect(res?.status).toBe(201);
        const body = await res!.json();
        expect(body.webhook.id).toBe("wh-1");
        expect(body.webhook.secret).toBe("abc123");
    });

    test("creates webhook with eventFilter", async () => {
        const created = {
            id: "wh-2",
            userId: "user-1",
            name: "Filtered Hook",
            targetSessionId: null,
            secret: "abc123",
            eventFilter: ["push", "pull_request"],
            source: "github",
            enabled: true,
            createdAt: "2026-01-01T00:00:00Z",
            updatedAt: "2026-01-01T00:00:00Z",
        };
        mockCreateWebhook.mockReturnValue(Promise.resolve(created));

        const [req, url] = makeReq("POST", "/api/webhooks", {
            name: "Filtered Hook",
            source: "github",
            eventFilter: ["push", "pull_request"],
        });
        const res = await handleWebhooksRoute(req, url);
        expect(res?.status).toBe(201);
        const body = await res!.json();
        expect(body.webhook.eventFilter).toEqual(["push", "pull_request"]);
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
                    source: "github",
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
        const hook = { id: "wh-1", userId: "user-1", name: "Hook 1", source: "github", enabled: true };
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
        const updated = { id: "wh-1", userId: "user-1", name: "Updated", source: "github", enabled: true };
        mockUpdateWebhook.mockReturnValue(Promise.resolve(updated));

        const [req, url] = makeReq("PUT", "/api/webhooks/wh-1", { name: "Updated", enabled: false });
        const res = await handleWebhooksRoute(req, url);
        expect(res?.status).toBe(200);
        const body = await res!.json();
        expect(body.webhook.id).toBe("wh-1");
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
        // updateWebhook was called with eventFilter: null
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
    targetSessionId: "sess-1",
    secret: "test-secret-xyz",
    eventFilter: null,
    source: "custom",
    enabled: true,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
};

const ACTIVE_SESSION = { userId: "user-1", sessionId: "sess-1" };

describe("POST /api/webhooks/:id/fire — HMAC validation", () => {
    beforeEach(() => {
        mockGetWebhook.mockReset();
        mockGetSharedSession.mockReset();
        mockGetLocalTuiSocket.mockReset();
        mockEmitToRelaySessionVerified.mockReset();
        mockPushTriggerHistory.mockReset();
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
        expect(body.error).toContain("Signature");
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

    test("accepts valid HMAC signature and fires trigger", async () => {
        mockGetWebhook.mockReturnValue(Promise.resolve(ACTIVE_WEBHOOK));
        mockGetSharedSession.mockReturnValue(Promise.resolve(ACTIVE_SESSION));
        const emitMock = mock(() => {});
        mockGetLocalTuiSocket.mockReturnValue({ connected: true, emit: emitMock });

        const body = { event: "deploy", repo: "test/repo" };
        const [req, url] = makeFireReq("/api/webhooks/wh-1/fire", body, ACTIVE_WEBHOOK.secret);
        const res = await handleWebhooksRoute(req, url);
        expect(res?.status).toBe(200);
        const resBody = await res!.json();
        expect(resBody.ok).toBe(true);
        expect(resBody.triggerId).toMatch(/^wh_/);

        expect(emitMock).toHaveBeenCalledTimes(1);
        expect(mockPushTriggerHistory).toHaveBeenCalledTimes(1);
    });

    test("falls back to cross-node delivery", async () => {
        mockGetWebhook.mockReturnValue(Promise.resolve(ACTIVE_WEBHOOK));
        mockGetSharedSession.mockReturnValue(Promise.resolve(ACTIVE_SESSION));
        mockGetLocalTuiSocket.mockReturnValue(null);
        mockEmitToRelaySessionVerified.mockReturnValue(Promise.resolve(true));

        const body = { event: "test" };
        const [req, url] = makeFireReq("/api/webhooks/wh-1/fire", body, ACTIVE_WEBHOOK.secret);
        const res = await handleWebhooksRoute(req, url);
        expect(res?.status).toBe(200);
        expect(mockEmitToRelaySessionVerified).toHaveBeenCalledTimes(1);
    });

    test("returns 503 when session not connected", async () => {
        mockGetWebhook.mockReturnValue(Promise.resolve(ACTIVE_WEBHOOK));
        mockGetSharedSession.mockReturnValue(Promise.resolve(ACTIVE_SESSION));
        mockGetLocalTuiSocket.mockReturnValue(null);
        mockEmitToRelaySessionVerified.mockReturnValue(Promise.resolve(false));

        const body = { event: "test" };
        const [req, url] = makeFireReq("/api/webhooks/wh-1/fire", body, ACTIVE_WEBHOOK.secret);
        const res = await handleWebhooksRoute(req, url);
        expect(res?.status).toBe(503);
    });

    test("returns 404 when target session belongs to different user", async () => {
        mockGetWebhook.mockReturnValue(Promise.resolve(ACTIVE_WEBHOOK));
        mockGetSharedSession.mockReturnValue(
            Promise.resolve({ userId: "user-2", sessionId: "sess-1" }),
        );

        const body = { event: "test" };
        const [req, url] = makeFireReq("/api/webhooks/wh-1/fire", body, ACTIVE_WEBHOOK.secret);
        const res = await handleWebhooksRoute(req, url);
        expect(res?.status).toBe(404);
    });
});

describe("POST /api/webhooks/:id/fire — event filtering", () => {
    beforeEach(() => {
        mockGetWebhook.mockReset();
        mockGetSharedSession.mockReset();
        mockGetLocalTuiSocket.mockReset();
        mockEmitToRelaySessionVerified.mockReset();
        mockPushTriggerHistory.mockReset();
    });

    const FILTERED_WEBHOOK = {
        ...ACTIVE_WEBHOOK,
        eventFilter: ["push", "pull_request"],
        source: "github",
    };

    test("forwards matching events", async () => {
        mockGetWebhook.mockReturnValue(Promise.resolve(FILTERED_WEBHOOK));
        mockGetSharedSession.mockReturnValue(Promise.resolve(ACTIVE_SESSION));
        const emitMock = mock(() => {});
        mockGetLocalTuiSocket.mockReturnValue({ connected: true, emit: emitMock });

        const body = { ref: "refs/heads/main", head_commit: { id: "abc123" } };
        const [req, url] = makeFireReq("/api/webhooks/wh-1/fire", body, ACTIVE_WEBHOOK.secret, {
            "x-github-event": "push",
        });
        const res = await handleWebhooksRoute(req, url);
        expect(res?.status).toBe(200);
        const resBody = await res!.json();
        expect(resBody.ok).toBe(true);
        expect(resBody.filtered).toBeUndefined();
        expect(emitMock).toHaveBeenCalledTimes(1);
    });

    test("silently drops events not in filter", async () => {
        mockGetWebhook.mockReturnValue(Promise.resolve(FILTERED_WEBHOOK));
        mockGetSharedSession.mockReturnValue(Promise.resolve(ACTIVE_SESSION));
        const emitMock = mock(() => {});
        mockGetLocalTuiSocket.mockReturnValue({ connected: true, emit: emitMock });

        const body = { action: "created" };
        const [req, url] = makeFireReq("/api/webhooks/wh-1/fire", body, ACTIVE_WEBHOOK.secret, {
            "x-github-event": "star",
        });
        const res = await handleWebhooksRoute(req, url);
        expect(res?.status).toBe(200);
        const resBody = await res!.json();
        expect(resBody.ok).toBe(true);
        expect(resBody.filtered).toBe(true);
        // Should NOT have delivered anything
        expect(emitMock).not.toHaveBeenCalled();
        expect(mockPushTriggerHistory).not.toHaveBeenCalled();
    });
});

describe("POST /api/webhooks/:id/fire — GitHub event mapping", () => {
    beforeEach(() => {
        mockGetWebhook.mockReset();
        mockGetSharedSession.mockReset();
        mockGetLocalTuiSocket.mockReset();
        mockPushTriggerHistory.mockReset();
    });

    const GITHUB_WEBHOOK = { ...ACTIVE_WEBHOOK, source: "github", eventFilter: null };

    test("maps push event fields", async () => {
        mockGetWebhook.mockReturnValue(Promise.resolve(GITHUB_WEBHOOK));
        mockGetSharedSession.mockReturnValue(Promise.resolve(ACTIVE_SESSION));
        const emitMock = mock(() => {});
        mockGetLocalTuiSocket.mockReturnValue({ connected: true, emit: emitMock });

        const body = {
            ref: "refs/heads/main",
            head_commit: { id: "deadbeef" },
            repository: { full_name: "owner/repo" },
            sender: { login: "octocat" },
        };
        const [req, url] = makeFireReq("/api/webhooks/wh-1/fire", body, ACTIVE_WEBHOOK.secret, {
            "x-github-event": "push",
        });
        const res = await handleWebhooksRoute(req, url);
        expect(res?.status).toBe(200);

        const call = emitMock.mock.calls[0] as any[];
        const trigger = call[1].trigger;
        expect(trigger.payload.event).toBe("push");
        expect(trigger.payload.ref).toBe("refs/heads/main");
        expect(trigger.payload.commit).toBe("deadbeef");
        expect(trigger.payload.repository).toBe("owner/repo");
        expect(trigger.payload.sender).toBe("octocat");
    });

    test("maps pull_request event fields", async () => {
        mockGetWebhook.mockReturnValue(Promise.resolve(GITHUB_WEBHOOK));
        mockGetSharedSession.mockReturnValue(Promise.resolve(ACTIVE_SESSION));
        const emitMock = mock(() => {});
        mockGetLocalTuiSocket.mockReturnValue({ connected: true, emit: emitMock });

        const body = {
            action: "opened",
            pull_request: { number: 42, title: "Add feature" },
            repository: { full_name: "owner/repo" },
            sender: { login: "dev" },
        };
        const [req, url] = makeFireReq("/api/webhooks/wh-1/fire", body, ACTIVE_WEBHOOK.secret, {
            "x-github-event": "pull_request",
        });
        const res = await handleWebhooksRoute(req, url);
        expect(res?.status).toBe(200);

        const call = emitMock.mock.calls[0] as any[];
        const trigger = call[1].trigger;
        expect(trigger.payload.event).toBe("pull_request");
        expect(trigger.payload.action).toBe("opened");
        expect(trigger.payload.prNumber).toBe(42);
        expect(trigger.payload.prTitle).toBe("Add feature");
    });

    test("maps issues event fields", async () => {
        mockGetWebhook.mockReturnValue(Promise.resolve(GITHUB_WEBHOOK));
        mockGetSharedSession.mockReturnValue(Promise.resolve(ACTIVE_SESSION));
        const emitMock = mock(() => {});
        mockGetLocalTuiSocket.mockReturnValue({ connected: true, emit: emitMock });

        const body = {
            action: "closed",
            issue: { number: 7, title: "Bug fix" },
            repository: { full_name: "owner/repo" },
            sender: { login: "dev" },
        };
        const [req, url] = makeFireReq("/api/webhooks/wh-1/fire", body, ACTIVE_WEBHOOK.secret, {
            "x-github-event": "issues",
        });
        const res = await handleWebhooksRoute(req, url);
        expect(res?.status).toBe(200);

        const call = emitMock.mock.calls[0] as any[];
        const trigger = call[1].trigger;
        expect(trigger.payload.event).toBe("issues");
        expect(trigger.payload.action).toBe("closed");
        expect(trigger.payload.issueNumber).toBe(7);
        expect(trigger.payload.issueTitle).toBe("Bug fix");
    });

    test("passes unknown events through with raw body", async () => {
        mockGetWebhook.mockReturnValue(Promise.resolve(GITHUB_WEBHOOK));
        mockGetSharedSession.mockReturnValue(Promise.resolve(ACTIVE_SESSION));
        const emitMock = mock(() => {});
        mockGetLocalTuiSocket.mockReturnValue({ connected: true, emit: emitMock });

        const body = { some_field: "value" };
        const [req, url] = makeFireReq("/api/webhooks/wh-1/fire", body, ACTIVE_WEBHOOK.secret, {
            "x-github-event": "workflow_run",
        });
        const res = await handleWebhooksRoute(req, url);
        expect(res?.status).toBe(200);

        const call = emitMock.mock.calls[0] as any[];
        const trigger = call[1].trigger;
        expect(trigger.payload.event).toBe("workflow_run");
        expect(trigger.payload.raw).toEqual(body);
    });
});

describe("POST /api/webhooks/:id/fire — targetSessionId fallback", () => {
    beforeEach(() => {
        mockGetWebhook.mockReset();
        mockGetSharedSession.mockReset();
        mockGetLocalTuiSocket.mockReset();
        mockGetMostRecentActiveSessionId.mockReset();
        mockPushTriggerHistory.mockReset();
    });

    test("uses most recent active session when targetSessionId is null", async () => {
        const nullTargetHook = { ...ACTIVE_WEBHOOK, targetSessionId: null };
        mockGetWebhook.mockReturnValue(Promise.resolve(nullTargetHook));
        mockGetMostRecentActiveSessionId.mockReturnValue(Promise.resolve("sess-fallback"));
        mockGetSharedSession.mockReturnValue(
            Promise.resolve({ userId: "user-1", sessionId: "sess-fallback" }),
        );
        const emitMock = mock(() => {});
        mockGetLocalTuiSocket.mockReturnValue({ connected: true, emit: emitMock });

        const body = { event: "test" };
        const [req, url] = makeFireReq("/api/webhooks/wh-1/fire", body, ACTIVE_WEBHOOK.secret);
        const res = await handleWebhooksRoute(req, url);
        expect(res?.status).toBe(200);
        expect(mockGetMostRecentActiveSessionId).toHaveBeenCalledWith("user-1");
        expect(emitMock).toHaveBeenCalledTimes(1);
    });

    test("returns 404 when no active session found for user", async () => {
        const nullTargetHook = { ...ACTIVE_WEBHOOK, targetSessionId: null };
        mockGetWebhook.mockReturnValue(Promise.resolve(nullTargetHook));
        mockGetMostRecentActiveSessionId.mockReturnValue(Promise.resolve(null));

        const body = { event: "test" };
        const [req, url] = makeFireReq("/api/webhooks/wh-1/fire", body, ACTIVE_WEBHOOK.secret);
        const res = await handleWebhooksRoute(req, url);
        expect(res?.status).toBe(404);
        const resBody = await res!.json();
        expect(resBody.error).toContain("No active session");
    });
});

describe("POST /api/webhooks/:id/fire — GitHub X-Hub-Signature-256", () => {
    function makeGitHubFireReq(
        path: string,
        body: object,
        secret: string,
    ): [Request, URL] {
        const bodyStr = JSON.stringify(body);
        const sig = `sha256=${signBody(secret, bodyStr)}`;
        const url = new URL(`http://localhost${path}`);
        const req = new Request(url.toString(), {
            method: "POST",
            headers: {
                "content-type": "application/json",
                "x-hub-signature-256": sig,
                "x-github-event": "push",
            },
            body: bodyStr,
        });
        return [req, url];
    }

    test("accepts X-Hub-Signature-256 with sha256= prefix (GitHub format)", async () => {
        mockGetWebhook.mockReturnValue(Promise.resolve(ACTIVE_WEBHOOK));
        mockGetSharedSession.mockReturnValue(Promise.resolve(ACTIVE_SESSION));
        const emitMock = mock(() => {});
        mockGetLocalTuiSocket.mockReturnValue({ connected: true, emit: emitMock });

        const body = { ref: "refs/heads/main", repository: { full_name: "org/repo" } };
        const [req, url] = makeGitHubFireReq("/api/webhooks/wh-1/fire", body, ACTIVE_WEBHOOK.secret);
        const res = await handleWebhooksRoute(req, url);
        expect(res?.status).toBe(200);
        const resBody = await res!.json();
        expect(resBody.ok).toBe(true);
        expect(emitMock).toHaveBeenCalledTimes(1);
    });

    test("rejects X-Hub-Signature-256 with wrong secret", async () => {
        mockGetWebhook.mockReturnValue(Promise.resolve(ACTIVE_WEBHOOK));

        const body = { ref: "refs/heads/main" };
        const bodyStr = JSON.stringify(body);
        const badSig = `sha256=${signBody("wrong-secret", bodyStr)}`;
        const url = new URL("http://localhost/api/webhooks/wh-1/fire");
        const req = new Request(url.toString(), {
            method: "POST",
            headers: {
                "content-type": "application/json",
                "x-hub-signature-256": badSig,
            },
            body: bodyStr,
        });
        const res = await handleWebhooksRoute(req, url);
        expect(res?.status).toBe(401);
    });

    test("returns 401 when both x-webhook-signature and x-hub-signature-256 are absent", async () => {
        mockGetWebhook.mockReturnValue(Promise.resolve(ACTIVE_WEBHOOK));
        const [req, url] = makeReq("POST", "/api/webhooks/wh-1/fire", { event: "test" });
        const res = await handleWebhooksRoute(req, url);
        expect(res?.status).toBe(401);
        const resBody = await res!.json();
        expect(resBody.error).toContain("signature");
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
