/**
 * Tests for HMAC token-based attachment auth:
 *   POST /api/attachments/:id/token  — mint a short-lived token
 *   GET  /api/attachments/:id?token= — download with token
 *
 * Also covers deprecation warning on ?apiKey= path and ownership mismatch.
 *
 * Key wiring: createAttachmentToken / verifyAttachmentToken both call
 * getAuthContext() so every call to handleAttachmentsRoute is wrapped in
 * runWithAuthContext(authCtx, ...) to supply the HMAC secret.
 */

import { mock, describe, test, expect, beforeAll, beforeEach, afterAll } from "bun:test";
import { createTestAuthContext, runWithAuthContext } from "../auth.js";
import { createAttachmentToken, verifyAttachmentToken } from "./attachment-token.js";

// ── Test auth context ─────────────────────────────────────────────────────────
const authCtx = createTestAuthContext({ dbPath: ":memory:" });

// ── Shared state ──────────────────────────────────────────────────────────────
let requireSessionUserId: string | null = "u-1";
const requireSessionCalls: number[] = [];

const storedAttachments: Map<string, {
    attachmentId: string;
    ownerUserId: string;
    filename: string;
    mimeType: string;
    size: number;
    filePath: string;
    expiresAt: string;
}> = new Map();

const warnLogs: string[] = [];

// ── Module mocks (must be BEFORE dynamic import) ──────────────────────────────

mock.module("../middleware.js", () => ({
    validateApiKey: async (_req: Request, _key?: string) => ({ userId: "u-1", userName: "test" }),
    requireSession: async (_req: Request) => {
        requireSessionCalls.push(1);
        if (!requireSessionUserId) return Response.json({ error: "Unauthorized" }, { status: 401 });
        return { userId: requireSessionUserId, userName: "test" };
    },
}));

mock.module("../ws/sio-registry.js", () => ({
    emitToRunner: mock(() => {}),
    getSharedSession: async (_id: string) => null,
}));

mock.module("../attachments/store.js", () => ({
    attachmentMaxFileSizeBytes: () => 50 * 1024 * 1024,
    getStoredAttachment: async (id: string) => storedAttachments.get(id) ?? null,
    storeSessionAttachment: async () => ({}),
}));

mock.module("@pizzapi/tools", () => ({
    createLogger: (_name: string) => ({
        warn: (msg: string) => { warnLogs.push(msg); },
        info: () => {},
        error: () => {},
        debug: () => {},
    }),
}));

// ── Dynamic import (after mocks) ──────────────────────────────────────────────
type RouteHandler = (req: Request, url: URL) => Promise<Response | undefined>;
let handleAttachmentsRoute: RouteHandler;

/** Calls the route handler inside the test auth context (HMAC secret required). */
async function callRoute(req: Request): Promise<Response | undefined> {
    return runWithAuthContext(authCtx, () => handleAttachmentsRoute(req, new URL(req.url)));
}

beforeAll(async () => {
    const mod = await import("./attachments.js") as { handleAttachmentsRoute: RouteHandler };
    handleAttachmentsRoute = mod.handleAttachmentsRoute;

    storedAttachments.set("att-1", {
        attachmentId: "att-1",
        ownerUserId: "u-1",
        filename: "test.png",
        mimeType: "image/png",
        size: 100,
        filePath: "/dev/null",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
});

beforeEach(() => {
    requireSessionCalls.length = 0;
    warnLogs.length = 0;
    requireSessionUserId = "u-1";
});

afterAll(() => mock.restore());

// ── Helpers ───────────────────────────────────────────────────────────────────

function mintToken(userId: string, attachmentId: string, nowMs = Date.now()): string {
    return runWithAuthContext(authCtx, () => createAttachmentToken({ userId, attachmentId }, nowMs).token);
}

// ── Token mint: POST /api/attachments/:id/token ───────────────────────────────

describe("POST /api/attachments/:id/token", () => {
    test("returns 401 when session is not authenticated", async () => {
        requireSessionUserId = null;
        const res = await callRoute(new Request("http://localhost/api/attachments/att-1/token", { method: "POST" }));
        expect(res?.status).toBe(401);
        expect(requireSessionCalls.length).toBe(1);
    });

    test("returns 404 when attachment does not exist", async () => {
        const res = await callRoute(new Request("http://localhost/api/attachments/no-such/token", { method: "POST" }));
        expect(res?.status).toBe(404);
    });

    test("returns 403 when requester doesn't own the attachment", async () => {
        requireSessionUserId = "u-other";
        const res = await callRoute(new Request("http://localhost/api/attachments/att-1/token", { method: "POST" }));
        expect(res?.status).toBe(403);
    });

    test("returns token + expiresAt JSON for the owner", async () => {
        const res = await callRoute(new Request("http://localhost/api/attachments/att-1/token", { method: "POST" }));
        expect(res?.status).toBe(200);
        const body = await res!.json() as { token: string; expiresAt: string };
        expect(typeof body.token).toBe("string");
        // Two base64url segments joined by "."
        expect(body.token.split(".")).toHaveLength(2);
        expect(typeof body.expiresAt).toBe("string");
        // expiresAt should be in the future
        expect(new Date(body.expiresAt).getTime()).toBeGreaterThan(Date.now());
        // Token should be valid
        const payload = runWithAuthContext(authCtx, () => verifyAttachmentToken(body.token));
        expect(payload?.userId).toBe("u-1");
        expect(payload?.attachmentId).toBe("att-1");
    });
});

// ── Token download: GET /api/attachments/:id?token= ──────────────────────────

describe("GET /api/attachments/:id?token=", () => {
    test("returns 401 for a syntactically invalid token", async () => {
        const res = await callRoute(new Request("http://localhost/api/attachments/att-1?token=bad"));
        expect(res?.status).toBe(401);
        expect(requireSessionCalls.length).toBe(0);
    });

    test("returns 401 for an expired token", async () => {
        const token = mintToken("u-1", "att-1", 1); // minted at epoch+1ms → expired
        const res = await callRoute(new Request(`http://localhost/api/attachments/att-1?token=${encodeURIComponent(token)}`));
        expect(res?.status).toBe(401);
    });

    test("returns 403 when token attachment ID mismatches URL", async () => {
        // Token scoped to att-1 but URL has att-2
        storedAttachments.set("att-2", { ...storedAttachments.get("att-1")!, attachmentId: "att-2" });
        const token = mintToken("u-1", "att-1");
        const res = await callRoute(new Request(`http://localhost/api/attachments/att-2?token=${encodeURIComponent(token)}`));
        expect(res?.status).toBe(403);
        storedAttachments.delete("att-2");
    });

    test("returns 403 on ownership mismatch (token owner ≠ attachment owner)", async () => {
        const token = mintToken("u-evil", "att-1");
        const res = await callRoute(new Request(`http://localhost/api/attachments/att-1?token=${encodeURIComponent(token)}`));
        expect(res?.status).toBe(403);
    });

    test("serves attachment (200) for a valid token", async () => {
        const token = mintToken("u-1", "att-1");
        const res = await callRoute(new Request(`http://localhost/api/attachments/att-1?token=${encodeURIComponent(token)}`));
        expect(res?.status).toBe(200);
        expect(res?.headers.get("x-attachment-id")).toBe("att-1");
    });
});

// ── Deprecation warning on ?apiKey= ──────────────────────────────────────────

describe("GET /api/attachments/:id?apiKey= (deprecated)", () => {
    test("logs a deprecation warning when ?apiKey= is used", async () => {
        await callRoute(new Request("http://localhost/api/attachments/att-1?apiKey=my-key"));
        expect(warnLogs.some((m) => m.includes("deprecated") || m.includes("apiKey"))).toBe(true);
    });

    test("does not log a deprecation warning for x-api-key header", async () => {
        await callRoute(new Request("http://localhost/api/attachments/att-1", {
            headers: { "x-api-key": "my-key" },
        }));
        expect(warnLogs.some((m) => m.includes("deprecated"))).toBe(false);
    });

    test("still serves attachment when ?apiKey= used (backward compat)", async () => {
        const res = await callRoute(new Request("http://localhost/api/attachments/att-1?apiKey=my-key"));
        expect(res?.status).not.toBe(401);
        expect(res?.status).not.toBe(403);
    });
});
