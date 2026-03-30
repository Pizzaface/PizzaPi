/**
 * Regression tests for GET /api/attachments/:id — ?apiKey= query-parameter auth.
 *
 * These tests verify that the handler routes through validateApiKey (not
 * requireSession) when the caller provides an API key via the ?apiKey= URL
 * query parameter, restoring backward-compat with the documented auth behavior.
 *
 * Module mocking is necessary because validateApiKey / requireSession both call
 * getAuth(), which is not initialized in unit tests.  Mocking lets us track
 * which branch the route handler takes without needing a running DB.
 */

import { mock, describe, test, expect, beforeAll, beforeEach, afterAll } from "bun:test";

const isCI = !!process.env.CI;

// ── Module mocks ─────────────────────────────────────────────────────────────
// These must be registered BEFORE the module under test is imported.

const validateApiKeyCalls: Array<{ key: string | undefined }> = [];
const requireSessionCalls: number[] = [];

mock.module("../middleware.js", () => ({
    validateApiKey: async (_req: Request, key?: string) => {
        validateApiKeyCalls.push({ key });
        return new Response("Invalid or expired API key", { status: 401 });
    },
    requireSession: async (_req: Request) => {
        requireSessionCalls.push(1);
        return Response.json({ error: "Unauthorized" }, { status: 401 });
    },
}));

// Stub out the other dependencies the handler imports.
mock.module("../ws/sio-registry.js", () => ({
    getSharedSession: async (_id: string) => null,
}));

mock.module("../attachments/store.js", () => ({
    attachmentMaxFileSizeBytes: () => 50 * 1024 * 1024,
    getStoredAttachment: async (_id: string) => null,
    storeSessionAttachment: async () => ({}),
}));

// ── Dynamic import (after mocks are registered) ───────────────────────────────

type RouteHandler = (req: Request, url: URL) => Promise<Response | undefined>;
let handleAttachmentsRoute: RouteHandler;

beforeAll(async () => {
    const mod = await import("./attachments.js") as { handleAttachmentsRoute: RouteHandler };
    handleAttachmentsRoute = mod.handleAttachmentsRoute;
});

beforeEach(() => {
    validateApiKeyCalls.length = 0;
    requireSessionCalls.length = 0;
});

afterAll(() => mock.restore());

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("GET /api/attachments/:id — auth path selection", () => {
    // Bun's mock.module registry can leak across test files in CI and poison
    // packages/server/src/attachments/store.test.ts. Keep this regression test
    // running locally, but skip it in CI until module-mock isolation is fixed.
    const routeAuthTest = isCI ? test.skip : test;

    routeAuthTest("without any auth, calls requireSession", async () => {
        const req = new Request("http://localhost/api/attachments/test-id", { method: "GET" });
        const url = new URL(req.url);
        await handleAttachmentsRoute(req, url);
        expect(requireSessionCalls.length).toBe(1);
        expect(validateApiKeyCalls.length).toBe(0);
    });

    routeAuthTest("with x-api-key header, calls validateApiKey (pre-existing behavior)", async () => {
        const req = new Request("http://localhost/api/attachments/test-id", {
            method: "GET",
            headers: { "x-api-key": "test-api-key" },
        });
        const url = new URL(req.url);
        await handleAttachmentsRoute(req, url);
        expect(validateApiKeyCalls.length).toBe(1);
        expect(validateApiKeyCalls[0]?.key).toBe("test-api-key");
        expect(requireSessionCalls.length).toBe(0);
    });

    routeAuthTest("with ?apiKey= query parameter, calls validateApiKey (restored backward-compat)", async () => {
        const req = new Request("http://localhost/api/attachments/test-id?apiKey=my-api-key", {
            method: "GET",
        });
        const url = new URL(req.url);
        await handleAttachmentsRoute(req, url);
        expect(validateApiKeyCalls.length).toBe(1);
        expect(validateApiKeyCalls[0]?.key).toBe("my-api-key");
        expect(requireSessionCalls.length).toBe(0);
    });

    routeAuthTest("x-api-key header takes priority over ?apiKey= query param when both are present", async () => {
        const req = new Request("http://localhost/api/attachments/test-id?apiKey=query-key", {
            method: "GET",
            headers: { "x-api-key": "header-key" },
        });
        const url = new URL(req.url);
        await handleAttachmentsRoute(req, url);
        expect(validateApiKeyCalls.length).toBe(1);
        expect(validateApiKeyCalls[0]?.key).toBe("header-key");
        expect(requireSessionCalls.length).toBe(0);
    });

    routeAuthTest("empty ?apiKey= query param falls back to requireSession (no key provided)", async () => {
        const req = new Request("http://localhost/api/attachments/test-id?apiKey=", {
            method: "GET",
        });
        const url = new URL(req.url);
        await handleAttachmentsRoute(req, url);
        // An empty string param is treated as no key → requireSession is called
        expect(requireSessionCalls.length).toBe(1);
        expect(validateApiKeyCalls.length).toBe(0);
    });
});
