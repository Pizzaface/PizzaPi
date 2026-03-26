import { describe, expect, test } from "bun:test";
import {
    getTunnelBasePath,
    rewriteTunnelHtml,
    rewriteTunnelUrl,
    shouldRewriteTunnelHtml,
    shouldRewriteTunnelJs,
    shouldRewriteTunnelCss,
    rewriteTunnelJsModule,
    rewriteTunnelCss,
} from "./tunnel";

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

describe("tunnel JS module rewriting", () => {
    test("shouldRewriteTunnelJs matches JavaScript content types", () => {
        expect(shouldRewriteTunnelJs("application/javascript")).toBe(true);
        expect(shouldRewriteTunnelJs("application/javascript; charset=utf-8")).toBe(true);
        expect(shouldRewriteTunnelJs("text/javascript")).toBe(true);
        expect(shouldRewriteTunnelJs("text/html")).toBe(false);
        expect(shouldRewriteTunnelJs("text/css")).toBe(false);
        expect(shouldRewriteTunnelJs(null)).toBe(false);
    });

    test("rewriteTunnelJsModule rewrites static import paths", () => {
        const js = `import React from "/node_modules/.vite/deps/react.js";
import { useState } from "/node_modules/.vite/deps/react.js";`;
        const rewritten = rewriteTunnelJsModule(js, "s-1", 3000);
        expect(rewritten).toContain('from "/api/tunnel/s-1/3000/node_modules/.vite/deps/react.js"');
        expect(rewritten).not.toContain('from "/node_modules/');
    });

    test("rewriteTunnelJsModule rewrites bare import (side-effect only)", () => {
        const js = `import "/src/index.css";`;
        const rewritten = rewriteTunnelJsModule(js, "s-1", 3000);
        expect(rewritten).toBe(`import "/api/tunnel/s-1/3000/src/index.css";`);
    });

    test("rewriteTunnelJsModule rewrites export-from", () => {
        const js = `export { useState } from "/node_modules/.vite/deps/react.js";`;
        const rewritten = rewriteTunnelJsModule(js, "s-1", 3000);
        expect(rewritten).toContain('from "/api/tunnel/s-1/3000/node_modules/.vite/deps/react.js"');
    });

    test("rewriteTunnelJsModule rewrites dynamic imports", () => {
        const js = `const mod = await import("/src/lazy-component.tsx");`;
        const rewritten = rewriteTunnelJsModule(js, "s-1", 3000);
        expect(rewritten).toContain('import("/api/tunnel/s-1/3000/src/lazy-component.tsx")');
    });

    test("rewriteTunnelJsModule rewrites new URL() with import.meta.url", () => {
        const js = `const url = new URL("/src/assets/logo.png", import.meta.url);`;
        const rewritten = rewriteTunnelJsModule(js, "s-1", 3000);
        expect(rewritten).toContain('new URL("/api/tunnel/s-1/3000/src/assets/logo.png"');
    });

    test("rewriteTunnelJsModule leaves relative paths alone", () => {
        const js = `import foo from "./utils.js";
import bar from "../lib/bar.js";`;
        const rewritten = rewriteTunnelJsModule(js, "s-1", 3000);
        expect(rewritten).toBe(js);
    });

    test("rewriteTunnelJsModule leaves external URLs alone", () => {
        const js = `import("https://cdn.example.com/lib.js");`;
        const rewritten = rewriteTunnelJsModule(js, "s-1", 3000);
        expect(rewritten).toBe(js);
    });

    test("rewriteTunnelJsModule leaves protocol-relative URLs alone", () => {
        const js = `import "//cdn.example.com/lib.js";`;
        const rewritten = rewriteTunnelJsModule(js, "s-1", 3000);
        // Protocol-relative starts with // — the regex checks /(?!/), so should not match
        expect(rewritten).toBe(js);
    });

    test("rewriteTunnelJsModule does not double-rewrite", () => {
        const js = `import React from "/api/tunnel/s-1/3000/node_modules/.vite/deps/react.js";`;
        const rewritten = rewriteTunnelJsModule(js, "s-1", 3000);
        expect(rewritten).toBe(js);
    });

    test("rewriteTunnelJsModule handles single-quoted imports", () => {
        const js = `import React from '/node_modules/.vite/deps/react.js';`;
        const rewritten = rewriteTunnelJsModule(js, "s-1", 3000);
        expect(rewritten).toContain("from '/api/tunnel/s-1/3000/node_modules/.vite/deps/react.js'");
    });
});

describe("tunnel CSS rewriting", () => {
    test("shouldRewriteTunnelCss matches CSS content types", () => {
        expect(shouldRewriteTunnelCss("text/css")).toBe(true);
        expect(shouldRewriteTunnelCss("text/css; charset=utf-8")).toBe(true);
        expect(shouldRewriteTunnelCss("text/html")).toBe(false);
        expect(shouldRewriteTunnelCss(null)).toBe(false);
    });

    test("rewriteTunnelCss rewrites @import paths", () => {
        const css = `@import "/src/styles/reset.css";`;
        const rewritten = rewriteTunnelCss(css, "s-1", 3000);
        expect(rewritten).toBe(`@import "/api/tunnel/s-1/3000/src/styles/reset.css";`);
    });

    test("rewriteTunnelCss rewrites url() paths", () => {
        const css = `body { background: url(/assets/bg.png); }`;
        const rewritten = rewriteTunnelCss(css, "s-1", 3000);
        expect(rewritten).toContain("url(/api/tunnel/s-1/3000/assets/bg.png)");
    });

    test("rewriteTunnelCss rewrites quoted url() paths", () => {
        const css = `body { background: url("/assets/bg.png"); }`;
        const rewritten = rewriteTunnelCss(css, "s-1", 3000);
        expect(rewritten).toContain('url("/api/tunnel/s-1/3000/assets/bg.png")');
    });

    test("rewriteTunnelCss does not double-rewrite", () => {
        const css = `@import "/api/tunnel/s-1/3000/src/styles/reset.css";`;
        const rewritten = rewriteTunnelCss(css, "s-1", 3000);
        expect(rewritten).toBe(css);
    });
});
