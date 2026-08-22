/**
 * Regression tests for GET /api/attachments/:id — Cache-Control header.
 *
 * Authenticated attachment responses must not be cached by browsers or
 * shared proxies, because the content is private to the session/user.
 * This file verifies that both session-auth and API-key-auth downloads
 * include Cache-Control: private, no-store while preserving the existing
 * security headers.
 */

import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { mock, describe, test, expect, beforeAll, afterAll } from "bun:test";

// ── Module mocks ─────────────────────────────────────────────────────────────
// These must be registered BEFORE the module under test is imported.

const testUserId = "user-cache-test";
const testAttachmentId = "att-cache-test";

mock.module("../middleware.js", () => ({
    validateApiKey: async (_req: Request, key?: string) => {
        if (key === "valid-api-key") {
            return { userId: testUserId };
        }
        return new Response("Invalid or expired API key", { status: 401 });
    },
    requireSession: async (_req: Request) => {
        return { userId: testUserId };
    },
}));

mock.module("../ws/sio-registry.js", () => ({
    emitToRunner: mock(() => {}),
    getSharedSession: async (_id: string) => null,
}));

let tempFilePath: string;

mock.module("../attachments/store.js", () => ({
    attachmentMaxFileSizeBytes: () => 50 * 1024 * 1024,
    getStoredAttachment: async (id: string) => {
        if (id === "att-other-owner") {
            return {
                attachmentId: "att-other-owner",
                sessionId: "session-cache-test",
                ownerUserId: "user-other",
                uploaderUserId: "user-other",
                filename: "other.png",
                mimeType: "image/png",
                size: 12,
                createdAt: new Date().toISOString(),
                expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
                expiresAtMs: Date.now() + 60 * 60 * 1000,
                filePath: tempFilePath,
            };
        }
        if (id !== testAttachmentId) return null;
        return {
            attachmentId: testAttachmentId,
            sessionId: "session-cache-test",
            ownerUserId: testUserId,
            uploaderUserId: testUserId,
            filename: "cache-test.png",
            mimeType: "image/png",
            size: 12,
            createdAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
            expiresAtMs: Date.now() + 60 * 60 * 1000,
            filePath: tempFilePath,
        };
    },
    storeSessionAttachment: async () => ({}),
}));

// ── Dynamic import (after mocks are registered) ───────────────────────────────

type RouteHandler = (req: Request, url: URL) => Promise<Response | undefined>;
let handleAttachmentsRoute: RouteHandler;

beforeAll(async () => {
    const tmpDir = mkdtempSync(path.join(tmpdir(), "pizzapi-attachments-cache-"));
    tempFilePath = path.join(tmpDir, "test.png");
    writeFileSync(tempFilePath, "hello world!");

    const mod = (await import("./attachments.js")) as { handleAttachmentsRoute: RouteHandler };
    handleAttachmentsRoute = mod.handleAttachmentsRoute;
});

afterAll(() => {
    mock.restore();
    if (tempFilePath) {
        rmSync(path.dirname(tempFilePath), { recursive: true, force: true });
    }
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("GET /api/attachments/:id — cache-control", () => {
    test("session-auth response sets private, no-store cache-control", async () => {
        const req = new Request(`http://localhost/api/attachments/${testAttachmentId}`, {
            method: "GET",
        });
        const res = await handleAttachmentsRoute(req, new URL(req.url));
        expect(res).not.toBeUndefined();
        expect(res!.status).toBe(200);
        expect(res!.headers.get("cache-control")).toBe("private, no-store");
        // Existing security/type headers must be preserved.
        expect(res!.headers.get("content-type")).toBe("image/png");
        expect(res!.headers.get("x-content-type-options")).toBe("nosniff");
    });

    test("api-key-auth response sets private, no-store cache-control", async () => {
        const req = new Request(`http://localhost/api/attachments/${testAttachmentId}`, {
            method: "GET",
            headers: { "x-api-key": "valid-api-key" },
        });
        const res = await handleAttachmentsRoute(req, new URL(req.url));
        expect(res).not.toBeUndefined();
        expect(res!.status).toBe(200);
        expect(res!.headers.get("cache-control")).toBe("private, no-store");
        expect(res!.headers.get("content-type")).toBe("image/png");
        expect(res!.headers.get("x-content-type-options")).toBe("nosniff");
    });

    test("?apiKey= query-param auth sets private, no-store cache-control", async () => {
        const req = new Request(
            `http://localhost/api/attachments/${testAttachmentId}?apiKey=valid-api-key`,
            { method: "GET" },
        );
        const res = await handleAttachmentsRoute(req, new URL(req.url));
        expect(res).not.toBeUndefined();
        expect(res!.status).toBe(200);
        expect(res!.headers.get("cache-control")).toBe("private, no-store");
    });

    test("404 response sets private, no-store cache-control", async () => {
        const req = new Request("http://localhost/api/attachments/att-missing", { method: "GET" });
        const res = await handleAttachmentsRoute(req, new URL(req.url));
        expect(res).not.toBeUndefined();
        expect(res!.status).toBe(404);
        expect(res!.headers.get("cache-control")).toBe("private, no-store");
    });

    test("403 response sets private, no-store cache-control", async () => {
        const req = new Request("http://localhost/api/attachments/att-other-owner", { method: "GET" });
        const res = await handleAttachmentsRoute(req, new URL(req.url));
        expect(res).not.toBeUndefined();
        expect(res!.status).toBe(403);
        expect(res!.headers.get("cache-control")).toBe("private, no-store");
    });
});
