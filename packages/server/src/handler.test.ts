import { describe, expect, test, beforeAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTestAuthContext } from "./auth";
import { runAllMigrations } from "./migrations";
import { handleFetch as rawHandleFetch, MAX_BODY_SIZE, MAX_ATTACHMENT_BODY_SIZE, enforceBodySizeLimit, withSecurityHeaders } from "./handler";

const authContext = createTestAuthContext({
    dbPath: join(mkdtempSync(join(tmpdir(), "handler-test-")), "auth.db"),
    baseURL: "http://localhost:7777",
});
const handleFetch = (req: Request) => rawHandleFetch(req, authContext);

beforeAll(async () => {
    await runAllMigrations(authContext);
});

// ── Constants ───────────────────────────────────────────────────────────────

describe("body size constants", () => {
    test("MAX_BODY_SIZE is 1MB", () => {
        expect(MAX_BODY_SIZE).toBe(1 * 1024 * 1024);
    });

    test("MAX_ATTACHMENT_BODY_SIZE is 50MB", () => {
        expect(MAX_ATTACHMENT_BODY_SIZE).toBe(50 * 1024 * 1024);
    });

    test("attachment limit is larger than default limit", () => {
        expect(MAX_ATTACHMENT_BODY_SIZE).toBeGreaterThan(MAX_BODY_SIZE);
    });
});

// ── Body size enforcement via Content-Length ─────────────────────────────────

describe("handleFetch — body size limits", () => {
    test("POST with Content-Length within 1MB limit passes through (returns non-413)", async () => {
        const req = new Request("http://localhost/api/runners", {
            method: "POST",
            headers: {
                "content-type": "application/json",
                "content-length": String(MAX_BODY_SIZE),
            },
            body: "{}",
        });
        const res = await handleFetch(req);
        expect(res.status).not.toBe(413);
    });

    test("POST with Content-Length exceeding 1MB returns 413", async () => {
        const req = new Request("http://localhost/api/runners", {
            method: "POST",
            headers: {
                "content-type": "application/json",
                "content-length": String(MAX_BODY_SIZE + 1),
            },
            body: "{}",
        });
        const res = await handleFetch(req);
        expect(res.status).toBe(413);
        const data = await res.json() as { error: string };
        expect(data.error).toContain("Payload Too Large");
    });

    test("PUT with Content-Length exceeding 1MB returns 413", async () => {
        const req = new Request("http://localhost/api/settings", {
            method: "PUT",
            headers: {
                "content-type": "application/json",
                "content-length": String(MAX_BODY_SIZE + 100),
            },
            body: "{}",
        });
        const res = await handleFetch(req);
        expect(res.status).toBe(413);
    });

    test("PATCH with Content-Length exceeding 1MB returns 413", async () => {
        const req = new Request("http://localhost/api/sessions/s-123", {
            method: "PATCH",
            headers: {
                "content-type": "application/json",
                "content-length": String(MAX_BODY_SIZE + 100),
            },
            body: "{}",
        });
        const res = await handleFetch(req);
        expect(res.status).toBe(413);
    });

    test("GET with large Content-Length is not rejected (GET has no body)", async () => {
        const req = new Request("http://localhost/api/runners", {
            method: "GET",
            headers: {
                "content-length": String(MAX_BODY_SIZE + 1),
            },
        });
        const res = await handleFetch(req);
        expect(res.status).not.toBe(413);
    });

    test("POST without Content-Length and small body passes through (within size limit)", async () => {
        const req = new Request("http://localhost/health", {
            method: "POST",
            headers: {
                "content-type": "application/json",
            },
            body: "{}",
        });
        const res = await handleFetch(req);
        expect(res.status).not.toBe(413);
    });

    test("POST without Content-Length and oversized body returns 413 (streaming limit)", async () => {
        const oversizedBody = "x".repeat(MAX_BODY_SIZE + 1);
        const req = new Request("http://localhost/api/runners", {
            method: "POST",
            headers: {
                "content-type": "application/json",
            },
            body: oversizedBody,
        });
        const res = await handleFetch(req);
        expect(res.status).toBe(413);
        const data = await res.json() as { error: string };
        expect(data.error).toContain("Payload Too Large");
    });

    test("POST with malformed Content-Length (numeric prefix like '1abc') returns 400", async () => {
        const req = new Request("http://localhost/api/runners", {
            method: "POST",
            headers: {
                "content-type": "application/json",
                "content-length": "1abc",
            },
            body: "{}",
        });
        const res = await handleFetch(req);
        expect(res.status).toBe(400);
        const data = await res.json() as { error: string };
        expect(data.error).toContain("malformed Content-Length");
    });

    test("attachment upload route allows up to 50MB", async () => {
        const req = new Request("http://localhost/api/sessions/abc-123/attachments", {
            method: "POST",
            headers: {
                "content-type": "multipart/form-data; boundary=----",
                "content-length": String(MAX_ATTACHMENT_BODY_SIZE),
            },
            body: "{}",
        });
        const res = await handleFetch(req);
        expect(res.status).not.toBe(413);
    });

    test("attachment upload route rejects body larger than 50MB", async () => {
        const req = new Request("http://localhost/api/sessions/abc-123/attachments", {
            method: "POST",
            headers: {
                "content-type": "multipart/form-data; boundary=----",
                "content-length": String(MAX_ATTACHMENT_BODY_SIZE + 1),
            },
            body: "{}",
        });
        const res = await handleFetch(req);
        expect(res.status).toBe(413);
        const data = await res.json() as { error: string };
        expect(data.error).toContain("Payload Too Large");
    });

    test("attachment upload route rejects body much larger than 1MB but within 50MB (uses higher limit)", async () => {
        const twoMB = 2 * 1024 * 1024;
        const req = new Request("http://localhost/api/sessions/abc-123/attachments", {
            method: "POST",
            headers: {
                "content-type": "multipart/form-data; boundary=----",
                "content-length": String(twoMB),
            },
            body: "{}",
        });
        const res = await handleFetch(req);
        expect(res.status).not.toBe(413);
    });

    test("non-attachment route rejects body of 2MB (over 1MB limit)", async () => {
        const twoMB = 2 * 1024 * 1024;
        const req = new Request("http://localhost/api/runners", {
            method: "POST",
            headers: {
                "content-type": "application/json",
                "content-length": String(twoMB),
            },
            body: "{}",
        });
        const res = await handleFetch(req);
        expect(res.status).toBe(413);
    });

    test("413 error message includes the byte limit", async () => {
        const req = new Request("http://localhost/api/runners", {
            method: "POST",
            headers: {
                "content-type": "application/json",
                "content-length": String(MAX_BODY_SIZE + 1),
            },
            body: "{}",
        });
        const res = await handleFetch(req);
        expect(res.status).toBe(413);
        const data = await res.json() as { error: string };
        expect(data.error).toContain(String(MAX_BODY_SIZE));
    });

    test("auth routes respect the 1MB body size limit", async () => {
        const req = new Request("http://localhost/api/auth/sign-in/email", {
            method: "POST",
            headers: {
                "content-type": "application/json",
                "content-length": String(MAX_BODY_SIZE + 1),
            },
            body: "{}",
        });
        const res = await handleFetch(req);
        expect(res.status).toBe(413);
    });
});

describe("enforceBodySizeLimit — streaming path body reconstruction", () => {
    test("body buffered via streaming path is fully readable by downstream req.text()", async () => {
        const payload = '{"hello":"world"}';
        const encoded = new TextEncoder().encode(payload);
        const streamBody = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(encoded);
                controller.close();
            },
        });

        const req = new Request("http://localhost/api/test", {
            method: "POST",
            body: streamBody,
            // @ts-expect-error Bun supports duplex
            duplex: "half",
        });

        const result = await enforceBodySizeLimit(req, new URL(req.url));
        expect(result).toBeInstanceOf(Request);
        const bufferedReq = result as Request;
        expect(await bufferedReq.text()).toBe(payload);
    });

    test("body buffered via streaming path is parseable as JSON by downstream req.json()", async () => {
        const req = new Request("http://localhost/api/test", {
            method: "POST",
            body: JSON.stringify({ a: 1, b: "two" }),
        });
        const result = await enforceBodySizeLimit(req, new URL(req.url));
        expect(result).toBeInstanceOf(Request);
        const bufferedReq = result as Request;
        expect(await bufferedReq.json()).toEqual({ a: 1, b: "two" });
    });
});

describe("enforceBodySizeLimit — Content-Length path body buffering", () => {
    test("body with Content-Length survives new Request() re-wrapping", async () => {
        const req = new Request("http://localhost/api/test", {
            method: "POST",
            headers: { "content-length": "17", "content-type": "application/json" },
            body: '{"hello":"world"}',
        });
        const result = await enforceBodySizeLimit(req, new URL(req.url));
        expect(result).toBeInstanceOf(Request);
        const bufferedReq = result as Request;
        expect(await bufferedReq.text()).toBe('{"hello":"world"}');
    });

    test("POST with Content-Length and no body returns request as-is", async () => {
        const req = new Request("http://localhost/api/test", {
            method: "POST",
            headers: { "content-length": "0" },
        });
        const result = await enforceBodySizeLimit(req, new URL(req.url));
        expect(result).toBe(req);
    });
});

describe("withSecurityHeaders", () => {
    test("injects X-Content-Type-Options: nosniff", () => {
        const res = withSecurityHeaders(new Response("ok"));
        expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    });

    test("injects X-Frame-Options: DENY", () => {
        const res = withSecurityHeaders(new Response("ok"));
        expect(res.headers.get("x-frame-options")).toBe("DENY");
    });

    test("injects X-XSS-Protection: 0", () => {
        const res = withSecurityHeaders(new Response("ok"));
        expect(res.headers.get("x-xss-protection")).toBe("0");
    });

    test("injects Referrer-Policy: strict-origin-when-cross-origin", () => {
        const res = withSecurityHeaders(new Response("ok"));
        expect(res.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
    });

    test("injects Permissions-Policy", () => {
        const res = withSecurityHeaders(new Response("ok"));
        expect(res.headers.get("permissions-policy")).toContain("camera=()");
    });

    test("injects Content-Security-Policy", () => {
        const res = withSecurityHeaders(new Response("ok"));
        expect(res.headers.get("content-security-policy")).toContain("default-src 'self'");
    });

    test("preserves existing headers", () => {
        const res = withSecurityHeaders(new Response("ok", { headers: { "x-custom": "yes" } }));
        expect(res.headers.get("x-custom")).toBe("yes");
    });

    test("preserves response body", async () => {
        const res = withSecurityHeaders(new Response("hello"));
        expect(await res.text()).toBe("hello");
    });

    test("preserves statusText", () => {
        const res = withSecurityHeaders(new Response("ok", { status: 201, statusText: "Created" }));
        expect(res.statusText).toBe("Created");
    });

    test("tunnel responses get SAMEORIGIN and no CSP", () => {
        const res = withSecurityHeaders(new Response("ok", { headers: { "x-pizzapi-tunnel": "1" } }));
        expect(res.headers.get("x-frame-options")).toBe("SAMEORIGIN");
        expect(res.headers.get("content-security-policy")).toBeNull();
    });

    test("non-tunnel responses still get DENY and CSP", () => {
        const res = withSecurityHeaders(new Response("ok"));
        expect(res.headers.get("x-frame-options")).toBe("DENY");
        expect(res.headers.get("content-security-policy")).not.toBeNull();
    });

    test("no duplicate security headers when response is collected via sendFetchResponse-style merging", () => {
        const res = withSecurityHeaders(new Response("ok"));
        const merged: Record<string, string | string[]> = {};
        res.headers.forEach((value, key) => {
            const existing = merged[key];
            if (existing !== undefined) {
                merged[key] = Array.isArray(existing) ? [...existing, value] : [existing, value];
            } else {
                merged[key] = value;
            }
        });
        expect(Array.isArray(merged["x-frame-options"])).toBe(false);
        expect(Array.isArray(merged["content-security-policy"])).toBe(false);
    });
});
