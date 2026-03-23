import { describe, expect, test } from "bun:test";
import { handleFetch, MAX_BODY_SIZE, MAX_ATTACHMENT_BODY_SIZE, enforceBodySizeLimit } from "./handler";

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
                "content-length": String(MAX_BODY_SIZE), // exactly at the limit
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
        // Small body well under the limit — streaming byte-counter should allow it
        const req = new Request("http://localhost/health", {
            method: "POST",
            headers: {
                "content-type": "application/json",
                // Deliberately omit Content-Length to trigger the streaming path
            },
            body: "{}",
        });
        const res = await handleFetch(req);
        expect(res.status).not.toBe(413);
    });

    test("POST without Content-Length and oversized body returns 413 (streaming limit)", async () => {
        // Exceeds MAX_BODY_SIZE without a Content-Length header — exercises the
        // streaming byte-counter that closes the missing-header bypass.
        const oversizedBody = "x".repeat(MAX_BODY_SIZE + 1);
        const req = new Request("http://localhost/api/runners", {
            method: "POST",
            headers: {
                "content-type": "application/json",
                // Deliberately omit Content-Length
            },
            body: oversizedBody,
        });
        const res = await handleFetch(req);
        expect(res.status).toBe(413);
        const data = await res.json() as { error: string };
        expect(data.error).toContain("Payload Too Large");
    });

    test("POST with malformed Content-Length (numeric prefix like '1abc') returns 400", async () => {
        // parseInt("1abc", 10) === 1 but the strict digits-only check should reject it
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
                "content-length": String(MAX_ATTACHMENT_BODY_SIZE), // exactly at limit
            },
            body: "{}",
        });
        const res = await handleFetch(req);
        // Should not be 413 (will likely be 401 or similar since not authenticated)
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
        // A body of 2MB should pass for attachment routes (but fail for regular routes)
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
        // 2MB is within the 50MB attachment limit — should not be 413
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

// ── Body reconstruction — streaming path ─────────────────────────────────────

describe("enforceBodySizeLimit — streaming path body reconstruction", () => {
    test("body buffered via streaming path is fully readable by downstream req.text()", async () => {
        // Use a ReadableStream body so the Request has no Content-Length header,
        // guaranteeing the streaming byte-counter path is exercised.
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
            headers: { "content-type": "application/json" },
            body: streamBody,
        });

        // Confirm the streaming path is taken (no Content-Length present).
        expect(req.headers.get("content-length")).toBeNull();

        const url = new URL(req.url);
        const result = await enforceBodySizeLimit(req, url);

        // Must return a Request (not a 413/4xx Response).
        expect(result).not.toBeInstanceOf(Response);

        // The reconstructed Request body must be fully readable by downstream
        // consumers (req.json() / req.text() etc.) — this is the regression the
        // original /health test could not catch.
        const text = await (result as Request).text();
        expect(text).toBe(payload);
    });

    test("body buffered via streaming path is parseable as JSON by downstream req.json()", async () => {
        const payload = { key: "value", num: 42 };
        const encoded = new TextEncoder().encode(JSON.stringify(payload));
        const streamBody = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(encoded);
                controller.close();
            },
        });

        const req = new Request("http://localhost/api/test", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: streamBody,
        });

        expect(req.headers.get("content-length")).toBeNull();

        const url = new URL(req.url);
        const result = await enforceBodySizeLimit(req, url);
        expect(result).not.toBeInstanceOf(Response);

        const parsed = await (result as Request).json() as typeof payload;
        expect(parsed).toEqual(payload);
    });
});
