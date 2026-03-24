import { describe, expect, test } from "bun:test";
import { handleFetch, MAX_BODY_SIZE, MAX_ATTACHMENT_BODY_SIZE, enforceBodySizeLimit, withSecurityHeaders } from "./handler";

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

describe("enforceBodySizeLimit — Content-Length path body buffering", () => {
    test("body with Content-Length survives new Request() re-wrapping", async () => {
        // Regression test: in Bun, wrapping a Request via `new Request(req, { headers })`
        // causes the body stream to hang when the original body is still a stream.
        // enforceBodySizeLimit must buffer the body into an ArrayBuffer even when
        // Content-Length is present, so downstream re-wrapping (e.g. auth handler
        // injecting x-pizzapi-client-ip) doesn't lose the body.
        const payload = '{"email":"test@example.com","password":"Secret123"}';
        const encoded = new TextEncoder().encode(payload);
        const req = new Request("http://localhost/api/auth/sign-in/email", {
            method: "POST",
            headers: {
                "content-type": "application/json",
                "content-length": String(encoded.byteLength),
            },
            body: encoded,
        });

        // Confirm Content-Length IS present (this is the path we're testing).
        expect(req.headers.get("content-length")).not.toBeNull();

        const url = new URL(req.url);
        const result = await enforceBodySizeLimit(req, url);
        expect(result).not.toBeInstanceOf(Response);

        // Simulate what the auth handler does: re-wrap with new headers.
        const rewrapped = new Request(result as Request, {
            headers: new Headers((result as Request).headers),
        });

        // The body must survive the re-wrapping and be readable.
        const text = await rewrapped.text();
        expect(text).toBe(payload);
    });

    test("POST with Content-Length and no body returns request as-is", async () => {
        // Edge case: POST with Content-Length: 0 and no body stream.
        const req = new Request("http://localhost/api/test", {
            method: "POST",
        });
        const url = new URL(req.url);
        const result = await enforceBodySizeLimit(req, url);
        expect(result).not.toBeInstanceOf(Response);
    });
});


describe("withSecurityHeaders", () => {
    test("injects X-Content-Type-Options: nosniff", () => {
        const res = withSecurityHeaders(new Response("ok", { status: 200 }));
        expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    });

    test("injects X-Frame-Options: DENY", () => {
        const res = withSecurityHeaders(new Response("ok", { status: 200 }));
        expect(res.headers.get("X-Frame-Options")).toBe("DENY");
    });

    test("injects X-XSS-Protection: 0", () => {
        const res = withSecurityHeaders(new Response("ok", { status: 200 }));
        expect(res.headers.get("X-XSS-Protection")).toBe("0");
    });

    test("injects Referrer-Policy: strict-origin-when-cross-origin", () => {
        const res = withSecurityHeaders(new Response("ok", { status: 200 }));
        expect(res.headers.get("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
    });

    test("injects Permissions-Policy", () => {
        const res = withSecurityHeaders(new Response("ok", { status: 200 }));
        expect(res.headers.get("Permissions-Policy")).toBe("camera=(), microphone=(), geolocation=()");
    });

    test("injects Content-Security-Policy", () => {
        const res = withSecurityHeaders(new Response("ok", { status: 200 }));
        const csp = res.headers.get("Content-Security-Policy");
        expect(csp).not.toBeNull();
        expect(csp).toContain("default-src 'self'");
        expect(csp).toContain("script-src 'self' 'wasm-unsafe-eval'");
        expect(csp).toContain("connect-src 'self' ws: wss: blob:");
        expect(csp).toContain("object-src 'none'");
    });

    test("preserves existing headers", () => {
        const original = new Response("hello", {
            status: 201,
            headers: { "Content-Type": "application/json" },
        });
        const res = withSecurityHeaders(original);
        expect(res.headers.get("Content-Type")).toBe("application/json");
        expect(res.status).toBe(201);
    });

    test("preserves response body", async () => {
        const res = withSecurityHeaders(new Response("body text", { status: 200 }));
        expect(await res.text()).toBe("body text");
    });

    test("preserves statusText", () => {
        const res = withSecurityHeaders(new Response(null, { status: 404, statusText: "Not Found" }));
        expect(res.status).toBe(404);
        expect(res.statusText).toBe("Not Found");
    });

    test("tunnel responses get SAMEORIGIN and no CSP", () => {
        const tunnelRes = new Response("tunneled html", {
            status: 200,
            headers: { "x-pizzapi-tunnel": "1", "content-type": "text/html" },
        });
        const res = withSecurityHeaders(tunnelRes);
        expect(res.headers.get("X-Frame-Options")).toBe("SAMEORIGIN");
        expect(res.headers.get("Content-Security-Policy")).toBeNull();
        // Internal marker must be stripped
        expect(res.headers.has("x-pizzapi-tunnel")).toBe(false);
    });

    test("non-tunnel responses still get DENY and CSP", () => {
        const res = withSecurityHeaders(new Response("ok", { status: 200 }));
        expect(res.headers.get("X-Frame-Options")).toBe("DENY");
        expect(res.headers.get("Content-Security-Policy")).not.toBeNull();
    });


    test("no duplicate security headers when response is collected via sendFetchResponse-style merging", () => {
        // Regression test for the P0 bug where sendFetchResponse had its own hardcoded
        // security headers AND withSecurityHeaders also set them, producing header arrays.
        // After the fix, sendFetchResponse starts with an empty map and only populates it
        // from the Response headers — so each security header must appear exactly once.
        const response = withSecurityHeaders(new Response("ok", { status: 200 }));

        // Simulate the sendFetchResponse header-collection loop
        const collected: Record<string, string | string[]> = {};
        response.headers.forEach((value, key) => {
            const existing = collected[key];
            if (existing !== undefined) {
                collected[key] = Array.isArray(existing)
                    ? [...existing, value]
                    : [existing, value];
            } else {
                collected[key] = value;
            }
        });

        // Each security header must be a plain string, not an array
        expect(collected["x-content-type-options"]).toBe("nosniff");
        expect(collected["x-frame-options"]).toBe("DENY");
        expect(collected["x-xss-protection"]).toBe("0");
        expect(collected["referrer-policy"]).toBe("strict-origin-when-cross-origin");
        expect(collected["permissions-policy"]).toBe("camera=(), microphone=(), geolocation=()");
        expect(typeof collected["content-security-policy"]).toBe("string");
    });
});
