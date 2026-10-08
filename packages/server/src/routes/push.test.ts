/**
 * Route-level tests for handlePushRoute.
 *
 * Mocks all dependencies so no DB or network is needed.
 * Focuses on: auth guards, 404 path, success path for native-child-suppression
 * routes, and the suppressChildNotifications field in register-native response.
 */

import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";

// ── Mocks (must be declared before the import under test) ────────────────────

const mockRequireSession = mock(
    async (_req: Request): Promise<{ userId: string; userName: string } | Response> => ({
        userId: "user-route-1",
        userName: "Test User",
    }),
);

const mockIsNtfyConfigured = mock(() => true);
const mockGetNtfyPublicUrl = mock(() => "https://push.example.com");
const mockRegisterNativePush = mock(async (_input: any) => ({
    userId: "user-route-1",
    platform: "android",
    topic: "pizzapi-abc123",
    ntfyUser: null,
    ntfyPass: null,
    suppressChildNotifications: 1,
    createdAt: new Date().toISOString(),
}));
const mockSubscribePush = mock(async (_input: any) => "sub-1");
const mockUnregisterNativePush = mock(async () => true);
const mockUpdateNativeSuppressChildNotifications = mock(async (_userId: string, _platform: string, _suppress: boolean, _deviceId?: string): Promise<number> => 1);

mock.module("../middleware.js", () => ({ requireSession: mockRequireSession }));

mock.module("../push.js", () => ({
    getVapidPublicKey: mock(() => "vapid-key"),
    subscribePush: mockSubscribePush,
    unsubscribePush: mock(async () => true),
    getSubscriptionsForUser: mock(async () => []),
    updateEnabledEvents: mock(async () => 1),
    updateSuppressChildNotifications: mock(async () => 1),
    isNtfyConfigured: mockIsNtfyConfigured,
    getNtfyPublicUrl: mockGetNtfyPublicUrl,
    registerNativePush: mockRegisterNativePush,
    unregisterNativePush: mockUnregisterNativePush,
    updateNativeSuppressChildNotifications: mockUpdateNativeSuppressChildNotifications,
}));

mock.module("../ws/sio-registry.js", () => ({
    getSharedSession: mock(() => null),
    getLocalTuiSocket: mock(() => null),
}));

mock.module("../ws/sio-state/index.js", () => ({
    getPushPendingQuestion: mock(() => null),
    consumePushPendingQuestionIfMatches: mock(() => null),
}));

// Import under test AFTER mocks are registered.
import { handlePushRoute } from "./push.js";

afterAll(() => mock.restore());

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeReq(path: string, method = "GET", body?: unknown): [Request, URL] {
    const url = new URL(`http://localhost${path}`);
    const init: RequestInit = { method };
    if (body !== undefined) {
        init.body = JSON.stringify(body);
        init.headers = { "content-type": "application/json" };
    }
    return [new Request(url, init), url];
}

function unauthorized(): Response {
    return new Response("Unauthorized", { status: 401 });
}

// ── PUT /api/push/child-notifications-native ──────────────────────────────────

describe("PUT /api/push/child-notifications-native", () => {
    beforeEach(() => {
        mockRequireSession.mockReset();
        mockUpdateNativeSuppressChildNotifications.mockReset();
        // Default: authenticated
        mockRequireSession.mockImplementation(async () => ({ userId: "user-route-1", userName: "Test User" }));
        // Default: registration found
        mockUpdateNativeSuppressChildNotifications.mockImplementation(async () => 1);
    });

    it("returns 401 when not authenticated", async () => {
        mockRequireSession.mockImplementation(async () => unauthorized());

        const [req, url] = makeReq("/api/push/child-notifications-native", "PUT", { suppress: true });
        const res = await handlePushRoute(req, url);
        expect(res?.status).toBe(401);
    });

    it("returns 404 when user has no native registration", async () => {
        mockUpdateNativeSuppressChildNotifications.mockImplementation(async () => 0);

        const [req, url] = makeReq("/api/push/child-notifications-native", "PUT", { suppress: true });
        const res = await handlePushRoute(req, url);
        expect(res?.status).toBe(404);
        const json = await res!.json();
        expect(json.error).toMatch(/no native push registration/i);
    });

    it("returns 400 when suppress field is missing", async () => {
        const [req, url] = makeReq("/api/push/child-notifications-native", "PUT", {});
        const res = await handlePushRoute(req, url);
        expect(res?.status).toBe(400);
    });

    it("persists suppress=true and returns ok", async () => {
        const [req, url] = makeReq("/api/push/child-notifications-native", "PUT", { suppress: true });
        const res = await handlePushRoute(req, url);
        expect(res?.status).toBe(200);
        const json = await res!.json();
        expect(json.ok).toBe(true);
        expect(mockUpdateNativeSuppressChildNotifications).toHaveBeenCalledWith("user-route-1", "android", true, undefined);
    });

    it("persists suppress=false and returns ok", async () => {
        const [req, url] = makeReq("/api/push/child-notifications-native", "PUT", { suppress: false });
        const res = await handlePushRoute(req, url);
        expect(res?.status).toBe(200);
        expect(mockUpdateNativeSuppressChildNotifications).toHaveBeenCalledWith("user-route-1", "android", false, undefined);
    });
});

// ── POST /api/push/register-native ───────────────────────────────────────────

describe("POST /api/push/register-native", () => {
    beforeEach(() => {
        mockRequireSession.mockReset();
        mockRegisterNativePush.mockReset();
        mockRequireSession.mockImplementation(async () => ({ userId: "user-route-1", userName: "Test User" }));
    });

    it("response includes suppressChildNotifications boolean (true by default)", async () => {
        mockRegisterNativePush.mockImplementation(async () => ({
            userId: "user-route-1",
            platform: "android",
            topic: "pizzapi-abc123",
            ntfyUser: null,
            ntfyPass: null,
            suppressChildNotifications: 1, // stored as integer
            createdAt: new Date().toISOString(),
        }));

        const [req, url] = makeReq("/api/push/register-native", "POST", { deviceId: "device-route-1" });
        const res = await handlePushRoute(req, url);
        expect(res?.status).toBe(200);
        const json = await res!.json();
        expect(json.ok).toBe(true);
        expect(typeof json.suppressChildNotifications).toBe("boolean");
        expect(json.suppressChildNotifications).toBe(true);
        expect(mockRegisterNativePush).toHaveBeenCalledWith({
            userId: "user-route-1",
            platform: "android",
            deviceId: "device-route-1",
        });
    });

    it("response includes suppressChildNotifications=true when previously set", async () => {
        mockRegisterNativePush.mockImplementation(async () => ({
            userId: "user-route-1",
            platform: "android",
            topic: "pizzapi-abc123",
            ntfyUser: null,
            ntfyPass: null,
            suppressChildNotifications: 1, // stored as integer
            createdAt: new Date().toISOString(),
        }));

        const [req, url] = makeReq("/api/push/register-native", "POST");
        const res = await handlePushRoute(req, url);
        const json = await res!.json();
        expect(json.suppressChildNotifications).toBe(true);
        expect(mockRegisterNativePush).toHaveBeenCalledWith({
            userId: "user-route-1",
            platform: "android",
            deviceId: undefined,
        });
    });

    it("returns 401 without auth", async () => {
        mockRequireSession.mockImplementation(async () => unauthorized());

        const [req, url] = makeReq("/api/push/register-native", "POST");
        const res = await handlePushRoute(req, url);
        expect(res?.status).toBe(401);
    });
});

// ── POST /api/push/subscribe ─────────────────────────────────────────────────
// The endpoint validator is NOT mocked (routes import it from push-endpoint.js).

describe("POST /api/push/subscribe endpoint validation", () => {
    beforeEach(() => {
        mockRequireSession.mockReset();
        mockSubscribePush.mockReset();
        mockRequireSession.mockImplementation(async () => ({ userId: "user-route-1", userName: "Test User" }));
        mockSubscribePush.mockImplementation(async () => "sub-1");
    });

    const keys = { p256dh: "p", auth: "a" };

    it("rejects IPv6-literal endpoints with an explicit error and stores nothing", async () => {
        for (const endpoint of ["https://[2606:4700:4700::1111]/push", "https://[::ffff:8.8.8.8]/push"]) {
            const [req, url] = makeReq("/api/push/subscribe", "POST", { endpoint, keys });
            const res = await handlePushRoute(req, url);
            expect(res?.status).toBe(400);
            const json = await res!.json();
            expect(json.error).toMatch(/IPv6-literal hosts are not supported/);
        }
        expect(mockSubscribePush).not.toHaveBeenCalled();
    });

    it("keeps the SSRF error for private targets and accepts DNS-hostname endpoints", async () => {
        const [badReq, badUrl] = makeReq("/api/push/subscribe", "POST", { endpoint: "https://[::1]/push", keys });
        const bad = await handlePushRoute(badReq, badUrl);
        expect(bad?.status).toBe(400);
        expect((await bad!.json()).error).toMatch(/private\/loopback/);

        const [req, url] = makeReq("/api/push/subscribe", "POST", { endpoint: "https://fcm.googleapis.com/fcm/send/abc", keys });
        const res = await handlePushRoute(req, url);
        expect(res?.status).toBe(200);
        expect(mockSubscribePush).toHaveBeenCalledTimes(1);
    });
});
