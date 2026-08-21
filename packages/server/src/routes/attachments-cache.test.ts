/**
 * Regression tests for GET /api/attachments/:id — cache-control headers.
 *
 * Authenticated attachment downloads are per-user and may contain sensitive
 * session data. Responses must instruct browsers and shared caches not to
 * store the payload, otherwise a shared device or upstream proxy can replay
 * the file after the owner logs out or the session expires.
 */

import { mock, describe, test, expect, beforeAll, afterAll } from "bun:test";

// ── Module mocks ─────────────────────────────────────────────────────────────

mock.module("../middleware.js", () => ({
    validateApiKey: async (_req: Request, _key?: string) => ({ userId: "user-1", sessionId: "session-1" }),
    requireSession: async (_req: Request) => ({ userId: "user-1", sessionId: "session-1" }),
}));

mock.module("../ws/sio-registry.js", () => ({
    getSharedSession: async (_id: string) => null,
}));

mock.module("../attachments/store.js", () => ({
    attachmentMaxFileSizeBytes: () => 50 * 1024 * 1024,
    getStoredAttachment: async (_id: string) => ({
        attachmentId: "att-1",
        sessionId: "session-1",
        ownerUserId: "user-1",
        uploaderUserId: "user-1",
        filename: "secret.txt",
        mimeType: "text/plain",
        size: 12,
        filePath: "/dev/null",
    }),
    storeSessionAttachment: async () => ({}),
}));

// ── Dynamic import (after mocks are registered) ─────────────────────────────

type RouteHandler = (req: Request, url: URL) => Promise<Response | undefined>;
let handleAttachmentsRoute: RouteHandler;

beforeAll(async () => {
    const mod = (await import("./attachments.js")) as { handleAttachmentsRoute: RouteHandler };
    handleAttachmentsRoute = mod.handleAttachmentsRoute;
});

afterAll(() => mock.restore());

// ── Tests ────────────────────────────────────────────────────────────────────

describe("GET /api/attachments/:id — cache control", () => {
    test("returns private, no-store cache-control for API-key auth", async () => {
        const req = new Request("http://localhost/api/attachments/att-1", {
            method: "GET",
            headers: { "x-api-key": "key-1" },
        });
        const res = await handleAttachmentsRoute(req, new URL(req.url));
        expect(res).toBeDefined();
        expect(res?.status).toBe(200);
        const cc = res?.headers.get("cache-control");
        expect(cc).toBeTruthy();
        expect(cc).toMatch(/private/i);
        expect(cc).toMatch(/no-store/i);
    });

    test("returns private, no-store cache-control for session cookie auth", async () => {
        const req = new Request("http://localhost/api/attachments/att-1", { method: "GET" });
        const res = await handleAttachmentsRoute(req, new URL(req.url));
        expect(res).toBeDefined();
        expect(res?.status).toBe(200);
        const cc = res?.headers.get("cache-control");
        expect(cc).toMatch(/private/i);
        expect(cc).toMatch(/no-store/i);
    });
});
