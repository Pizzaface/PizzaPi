import { describe, expect, test } from "bun:test";
import { getTunnelBasePath, rewriteTunnelHtml, rewriteTunnelUrl, shouldRewriteTunnelHtml } from "./tunnel";

describe("tunnel route URL rewriting", () => {
    test("getTunnelBasePath builds the session-scoped proxy prefix", () => {
        expect(getTunnelBasePath("session-123", 60434)).toBe("/api/tunnel/session-123/60434");
    });

    test("rewriteTunnelUrl prefixes root-relative paths", () => {
        expect(rewriteTunnelUrl("/assets/app.js", "session-123", 60434)).toBe(
            "/api/tunnel/session-123/60434/assets/app.js",
        );
    });

    test("rewriteTunnelUrl rewrites localhost absolute URLs", () => {
        expect(rewriteTunnelUrl("http://127.0.0.1:60434/login?x=1#hash", "session-123", 60434)).toBe(
            "/api/tunnel/session-123/60434/login?x=1#hash",
        );
        expect(rewriteTunnelUrl("https://localhost:60434/app", "session-123", 60434)).toBe(
            "/api/tunnel/session-123/60434/app",
        );
    });

    test("rewriteTunnelUrl leaves non-local absolute URLs and relative URLs alone", () => {
        expect(rewriteTunnelUrl("https://example.com/app", "session-123", 60434)).toBe("https://example.com/app");
        expect(rewriteTunnelUrl("assets/app.js", "session-123", 60434)).toBe("assets/app.js");
        expect(rewriteTunnelUrl("//cdn.example.com/app.js", "session-123", 60434)).toBe("//cdn.example.com/app.js");
    });
});

describe("tunnel route HTML rewriting", () => {
    test("shouldRewriteTunnelHtml matches HTML content types", () => {
        expect(shouldRewriteTunnelHtml("text/html; charset=utf-8")).toBe(true);
        expect(shouldRewriteTunnelHtml("application/xhtml+xml")).toBe(true);
        expect(shouldRewriteTunnelHtml("text/css")).toBe(false);
        expect(shouldRewriteTunnelHtml(null)).toBe(false);
    });

    test("rewriteTunnelHtml rewrites common root-relative HTML references and injects a base tag", () => {
        const html = `<!doctype html>
<html>
  <head>
    <link rel="stylesheet" href="/assets/app.css">
    <meta http-equiv="refresh" content="0;url=/login">
  </head>
  <body style="background-image:url('/bg.png')">
    <a href="/dashboard">Dashboard</a>
    <form action="/submit"></form>
    <script src="/assets/app.js"></script>
    <img src="/logo.png">
  </body>
</html>`;

        const rewritten = rewriteTunnelHtml(html, "session-123", 60434);
        expect(rewritten).toContain('<base href="/api/tunnel/session-123/60434/">');
        expect(rewritten).toContain('href="/api/tunnel/session-123/60434/assets/app.css"');
        expect(rewritten).toContain('content="0;url=/api/tunnel/session-123/60434/login"');
        expect(rewritten).toContain('href="/api/tunnel/session-123/60434/dashboard"');
        expect(rewritten).toContain('action="/api/tunnel/session-123/60434/submit"');
        expect(rewritten).toContain('src="/api/tunnel/session-123/60434/assets/app.js"');
        expect(rewritten).toContain('src="/api/tunnel/session-123/60434/logo.png"');
        expect(rewritten).toContain("url('/api/tunnel/session-123/60434/bg.png')");
    });

    test("rewriteTunnelHtml injects fetch/XHR interceptor script", () => {
        const html = `<!doctype html><html><head></head><body>hello</body></html>`;
        const rewritten = rewriteTunnelHtml(html, "s-1", 3000);
        expect(rewritten).toContain('data-pizzapi-tunnel-intercept');
        expect(rewritten).toContain('/api/tunnel/s-1/3000');
        // Interceptor must appear before any app scripts
        const interceptIdx = rewritten.indexOf('data-pizzapi-tunnel-intercept');
        const bodyIdx = rewritten.indexOf('<body>');
        expect(interceptIdx).toBeLessThan(bodyIdx);
    });

    test("rewriteTunnelHtml includes WebSocket intercept in the injected script", () => {
        const html = `<!doctype html><html><head></head><body>hello</body></html>`;
        const rewritten = rewriteTunnelHtml(html, "s-1", 3000);
        // The intercept script must patch WebSocket constructor
        expect(rewritten).toContain("WebSocket");
        expect(rewritten).toContain("rwWs");
        // Should handle ws:// and wss:// localhost URLs
        expect(rewritten).toContain("127\\.0\\.0\\.1");
        expect(rewritten).toContain("localhost");
        // Should copy static properties from native WebSocket
        expect(rewritten).toContain("CONNECTING");
        expect(rewritten).toContain("OPEN");
        expect(rewritten).toContain("CLOSING");
        expect(rewritten).toContain("CLOSED");
    });
});
