import { describe, test, expect } from "bun:test";
import { withSecurityHeaders } from "./handler.js";

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
});
