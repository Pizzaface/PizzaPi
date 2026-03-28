import { describe, expect, test } from "bun:test";
import {
    getTunnelBasePath,
    getRunnerTunnelBasePath,
    rewriteTunnelHtml,
    rewriteInlineModuleScripts,
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

    test("getRunnerTunnelBasePath builds the runner-scoped proxy prefix", () => {
        expect(getRunnerTunnelBasePath("runner-abc", 3000)).toBe("/api/tunnel/runner/runner-abc/3000");
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

    test("rewriteTunnelHtml uses sub-path-aware base href when proxyPath is provided", () => {
        const html = `<!doctype html><html><head></head><body>
<script src="runtime.bundle.js"></script>
</body></html>`;
        // Jellyfin scenario: HTML served from /web/index.html
        const rewritten = rewriteTunnelHtml(html, "session-123", 8096, "/web/index.html");
        // Base should point to the document's directory, not the tunnel root
        expect(rewritten).toContain('<base href="/api/tunnel/session-123/8096/web/">');
        // Interceptor script should still use tunnel root for absolute path rewrites
        expect(rewritten).toContain('var B="/api/tunnel/session-123/8096"');
    });

    test("rewriteTunnelHtml uses directory path for trailing-slash proxyPath", () => {
        const html = `<!doctype html><html><head></head><body>hello</body></html>`;
        const rewritten = rewriteTunnelHtml(html, "s-1", 3000, "/app/dashboard/");
        expect(rewritten).toContain('<base href="/api/tunnel/s-1/3000/app/dashboard/">');
    });

    test("rewriteTunnelHtml defaults to tunnel root when proxyPath is omitted", () => {
        const html = `<!doctype html><html><head></head><body>hello</body></html>`;
        const rewritten = rewriteTunnelHtml(html, "s-1", 3000);
        expect(rewritten).toContain('<base href="/api/tunnel/s-1/3000/">');
    });

    test("rewriteTunnelHtml strips existing <base> tags from original HTML", () => {
        const html = `<!doctype html><html><head><base href="/web/"></head><body>hello</body></html>`;
        const rewritten = rewriteTunnelHtml(html, "s-1", 3000, "/web/index.html");
        // Should only have one <base> — the injected one
        const baseMatches = rewritten.match(/<base\b[^>]*>/gi);
        expect(baseMatches).toHaveLength(1);
        expect(rewritten).toContain('<base href="/api/tunnel/s-1/3000/web/">');
        // Original <base href="/web/"> should be gone
        expect(rewritten).not.toContain('<base href="/web/">');
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

    test("rewriteTunnelHtml rewrites inline module script imports used by Vite dev", () => {
        const html = `<!doctype html><html><head></head><body>
<script type="module">
  import RefreshRuntime from "/@react-refresh";
  import "/src/main.tsx";
</script>
</body></html>`;
        const rewritten = rewriteTunnelHtml(html, "s-1", 5173);
        expect(rewritten).toContain('from "/api/tunnel/s-1/5173/@react-refresh"');
        expect(rewritten).toContain('import "/api/tunnel/s-1/5173/src/main.tsx"');
    });

    test("rewriteTunnelHtml includes WebSocket intercept in the injected script", () => {
        const html = `<!doctype html><html><head></head><body>hello</body></html>`;
        const rewritten = rewriteTunnelHtml(html, "s-1", 3000);
        // The intercept script must patch WebSocket constructor
        expect(rewritten).toContain("WebSocket");
        expect(rewritten).toContain("rwWs");
        // Should handle ws:// and wss:// localhost and same-origin URLs
        expect(rewritten).toContain('host==="127.0.0.1"');
        expect(rewritten).toContain('host==="localhost"');
        expect(rewritten).toContain("location.host");
        // Should copy static properties from native WebSocket
        expect(rewritten).toContain("CONNECTING");
        expect(rewritten).toContain("OPEN");
        expect(rewritten).toContain("CLOSING");
        expect(rewritten).toContain("CLOSED");
    });

    test("rewriteTunnelHtml WebSocket patch upgrades host-only ws:// URLs to wss:// on HTTPS", () => {
        const html = `<!doctype html><html><head></head><body>hello</body></html>`;
        const rewritten = rewriteTunnelHtml(html, "s-1", 3000);
        const scriptMatch = rewritten.match(/<script data-pizzapi-tunnel-intercept>\n([\s\S]*?)<\/script>/);
        expect(scriptMatch).toBeTruthy();
        const scriptBody = scriptMatch![1];

        const capturedUrls: string[] = [];
        const NativeWebSocket = function (this: unknown, url: string) {
            capturedUrls.push(url);
        } as unknown as {
            new (url: string, protocols?: string | string[]): unknown;
            prototype: Record<string, unknown>;
            CONNECTING: number;
            OPEN: number;
            CLOSING: number;
            CLOSED: number;
        };
        NativeWebSocket.prototype = {};
        NativeWebSocket.CONNECTING = 0;
        NativeWebSocket.OPEN = 1;
        NativeWebSocket.CLOSING = 2;
        NativeWebSocket.CLOSED = 3;

        class MockXHR {
            open(_method: string, _url: string): void {}
        }

        const mockWindow = {
            fetch: (_input: RequestInfo | URL, _init?: RequestInit) => Promise.resolve(new Response(null, { status: 200 })),
            WebSocket: NativeWebSocket,
            EventSource: undefined as undefined,
        };

        const mockHistory = {
            pushState: (_state: unknown, _title: string, _url?: string | URL | null) => {},
            replaceState: (_state: unknown, _title: string, _url?: string | URL | null) => {},
        };

        const runScript = new Function("window", "location", "history", "XMLHttpRequest", "Request", scriptBody) as (
            window: typeof mockWindow,
            location: { protocol: string; host: string },
            history: typeof mockHistory,
            XMLHttpRequest: typeof MockXHR,
            RequestCtor: typeof Request,
        ) => void;

        runScript(
            mockWindow,
            { protocol: "https:", host: "jordans-mac-mini.tail65556b.ts.net" },
            mockHistory,
            MockXHR,
            Request,
        );

        new mockWindow.WebSocket("ws://jordans-mac-mini.tail65556b.ts.net");

        expect(capturedUrls).toEqual(["wss://jordans-mac-mini.tail65556b.ts.net/api/tunnel/s-1/3000/"]);
    });

    test("rewriteTunnelHtml fetch/XHR interceptor rewrites same-origin and localhost full URLs", () => {
        const html = `<!doctype html><html><head></head><body>hello</body></html>`;
        const rewritten = rewriteTunnelHtml(html, "s-1", 8096);
        const scriptMatch = rewritten.match(/<script data-pizzapi-tunnel-intercept>\n([\s\S]*?)<\/script>/);
        expect(scriptMatch).toBeTruthy();
        const scriptBody = scriptMatch![1];

        const fetchedUrls: string[] = [];
        const xhrUrls: string[] = [];

        class MockXHR {
            open(_method: string, url: string): void {
                xhrUrls.push(url);
            }
        }

        const mockWindow = {
            fetch: (input: string | Request) => {
                fetchedUrls.push(typeof input === "string" ? input : input.url);
                return Promise.resolve(new Response(null, { status: 200 }));
            },
            WebSocket: function () {} as unknown as typeof WebSocket,
            EventSource: undefined as undefined,
        };
        // Copy static props to avoid errors
        (mockWindow.WebSocket as any).prototype = {};
        (mockWindow.WebSocket as any).CONNECTING = 0;
        (mockWindow.WebSocket as any).OPEN = 1;
        (mockWindow.WebSocket as any).CLOSING = 2;
        (mockWindow.WebSocket as any).CLOSED = 3;

        const mockLocation = { protocol: "https:", host: "pizzapi.example.com" };

        const mockHistory = {
            pushState: (_state: unknown, _title: string, _url?: string | URL | null) => {},
            replaceState: (_state: unknown, _title: string, _url?: string | URL | null) => {},
        };

        const runScript = new Function("window", "location", "history", "XMLHttpRequest", "Request", scriptBody) as (
            window: typeof mockWindow,
            location: typeof mockLocation,
            history: typeof mockHistory,
            XMLHttpRequest: typeof MockXHR,
            RequestCtor: typeof Request,
        ) => void;

        runScript(mockWindow, mockLocation, mockHistory, MockXHR, Request);

        // ── fetch: same-origin full URL ──
        mockWindow.fetch("https://pizzapi.example.com/Users/AuthenticateByName");
        expect(fetchedUrls.at(-1)).toBe(
            "https://pizzapi.example.com/api/tunnel/s-1/8096/Users/AuthenticateByName",
        );

        // ── fetch: same-origin URL already tunnel-prefixed ──
        mockWindow.fetch("https://pizzapi.example.com/api/tunnel/s-1/8096/System/Info");
        expect(fetchedUrls.at(-1)).toBe(
            "https://pizzapi.example.com/api/tunnel/s-1/8096/System/Info",
        );

        // ── fetch: localhost full URL ──
        mockWindow.fetch("http://127.0.0.1:8096/System/Info/Public");
        expect(fetchedUrls.at(-1)).toBe(
            "https://pizzapi.example.com/api/tunnel/s-1/8096/System/Info/Public",
        );

        // ── fetch: localhost (hostname) full URL ──
        mockWindow.fetch("http://localhost:8096/Items");
        expect(fetchedUrls.at(-1)).toBe(
            "https://pizzapi.example.com/api/tunnel/s-1/8096/Items",
        );

        // ── fetch: external URL — should NOT be rewritten ──
        mockWindow.fetch("https://api.external.com/data");
        expect(fetchedUrls.at(-1)).toBe("https://api.external.com/data");

        // ── fetch: root-relative — still works ──
        mockWindow.fetch("/Users/AuthenticateByName");
        expect(fetchedUrls.at(-1)).toBe("/api/tunnel/s-1/8096/Users/AuthenticateByName");

        // ── XHR: same-origin full URL ──
        // The interceptor patches XMLHttpRequest.prototype.open (the MockXHR passed
        // as the XMLHttpRequest parameter), so we instantiate MockXHR directly.
        const xhr = new MockXHR();
        xhr.open("GET", "https://pizzapi.example.com/System/Info");
        expect(xhrUrls.at(-1)).toBe(
            "https://pizzapi.example.com/api/tunnel/s-1/8096/System/Info",
        );

        // ── XHR: root-relative ──
        xhr.open("POST", "/Users/AuthenticateByName");
        expect(xhrUrls.at(-1)).toBe("/api/tunnel/s-1/8096/Users/AuthenticateByName");

        // ── fetch: localhost URL without trailing path ──
        mockWindow.fetch("http://127.0.0.1:8096");
        expect(fetchedUrls.at(-1)).toBe(
            "https://pizzapi.example.com/api/tunnel/s-1/8096/",
        );

        // ── fetch: same-origin URL without trailing path ──
        mockWindow.fetch("https://pizzapi.example.com");
        expect(fetchedUrls.at(-1)).toBe(
            "https://pizzapi.example.com/api/tunnel/s-1/8096/",
        );
    });

    test("rewriteTunnelHtml interceptor patches history/location navigation APIs", () => {
        const html = `<!doctype html><html><head></head><body>hello</body></html>`;
        const rewritten = rewriteTunnelHtml(html, "s-1", 3000);
        const scriptMatch = rewritten.match(/<script data-pizzapi-tunnel-intercept>\n([\s\S]*?)<\/script>/);
        expect(scriptMatch).toBeTruthy();
        const scriptBody = scriptMatch![1];

        const pushUrls: Array<string | URL | null | undefined> = [];
        const replaceUrls: Array<string | URL | null | undefined> = [];
        const assignUrls: Array<string | URL | null | undefined> = [];
        const locationReplaceUrls: Array<string | URL | null | undefined> = [];

        class MockXHR {
            open(_method: string, _url: string): void {}
        }

        const mockWindow = {
            fetch: () => Promise.resolve(new Response(null, { status: 200 })),
            open: (_url: string) => null,
            WebSocket: function () {} as unknown as typeof WebSocket,
            EventSource: undefined as undefined,
        };
        (mockWindow.WebSocket as any).prototype = {};
        (mockWindow.WebSocket as any).CONNECTING = 0;
        (mockWindow.WebSocket as any).OPEN = 1;
        (mockWindow.WebSocket as any).CLOSING = 2;
        (mockWindow.WebSocket as any).CLOSED = 3;

        const mockLocation = {
            protocol: "https:",
            host: "myserver.example.com",
            assign: (url: string | URL) => { assignUrls.push(url); },
            replace: (url: string | URL) => { locationReplaceUrls.push(url); },
        };

        const mockHistory = {
            pushState: (_state: unknown, _title: string, url?: string | URL | null) => { pushUrls.push(url); },
            replaceState: (_state: unknown, _title: string, url?: string | URL | null) => { replaceUrls.push(url); },
        };

        const mockNavigator = { sendBeacon: (_url: string, _data?: unknown) => true };
        const wrappedBody = `var navigator = __nav__;\n${scriptBody}`;
        const runScript = new Function("window", "location", "history", "XMLHttpRequest", "Request", "__nav__", wrappedBody);
        runScript(mockWindow, mockLocation, mockHistory, MockXHR, Request, mockNavigator);

        mockHistory.pushState({}, "", "/gallery/adventuretime");
        expect(pushUrls.at(-1)).toBe("/api/tunnel/s-1/3000/gallery/adventuretime");

        mockHistory.replaceState({}, "", "https://myserver.example.com/gallery/adventuretime");
        expect(replaceUrls.at(-1)).toBe("https://myserver.example.com/api/tunnel/s-1/3000/gallery/adventuretime");

        mockLocation.assign("/quotes");
        expect(assignUrls.at(-1)).toBe("/api/tunnel/s-1/3000/quotes");

        mockLocation.replace("https://myserver.example.com/search");
        expect(locationReplaceUrls.at(-1)).toBe("https://myserver.example.com/api/tunnel/s-1/3000/search");
    });

    test("rewriteTunnelHtml interceptor rewrites dynamic element src/href/action for runtime-created resources", () => {
        const html = `<!doctype html><html><head></head><body>hello</body></html>`;
        const rewritten = rewriteTunnelHtml(html, "s-1", 3000);
        const scriptMatch = rewritten.match(/<script data-pizzapi-tunnel-intercept>\n([\s\S]*?)<\/script>/);
        expect(scriptMatch).toBeTruthy();
        const scriptBody = scriptMatch![1];

        class MockElement {
            attrs: Record<string, string> = {};
            setAttribute(name: string, value: string): void {
                this.attrs[name] = value;
            }
        }
        class MockScriptElement extends MockElement {
            private _src = "";
            get src(): string { return this._src; }
            set src(value: string) { this._src = value; }
        }
        class MockLinkElement extends MockElement {
            private _href = "";
            get href(): string { return this._href; }
            set href(value: string) { this._href = value; }
        }
        class MockIFrameElement extends MockElement {
            private _src = "";
            get src(): string { return this._src; }
            set src(value: string) { this._src = value; }
        }

        class MockXHR {
            open(_method: string, _url: string): void {}
        }

        const mockWindow = {
            fetch: () => Promise.resolve(new Response(null, { status: 200 })),
            open: (_url: string) => null,
            WebSocket: function () {} as unknown as typeof WebSocket,
            EventSource: undefined as undefined,
        };
        (mockWindow.WebSocket as any).prototype = {};
        (mockWindow.WebSocket as any).CONNECTING = 0;
        (mockWindow.WebSocket as any).OPEN = 1;
        (mockWindow.WebSocket as any).CLOSING = 2;
        (mockWindow.WebSocket as any).CLOSED = 3;

        const mockLocation = {
            protocol: "https:",
            host: "myserver.example.com",
            assign: (_url: string | URL) => {},
            replace: (_url: string | URL) => {},
        };
        const mockHistory = {
            pushState: (_state: unknown, _title: string, _url?: string | URL | null) => {},
            replaceState: (_state: unknown, _title: string, _url?: string | URL | null) => {},
        };
        const mockNavigator = { sendBeacon: (_url: string, _data?: unknown) => true };

        const wrappedBody = `var navigator = __nav__;\n${scriptBody}`;
        const runScript = new Function(
            "window",
            "location",
            "history",
            "XMLHttpRequest",
            "Request",
            "__nav__",
            "Element",
            "HTMLScriptElement",
            "HTMLImageElement",
            "HTMLLinkElement",
            "HTMLMediaElement",
            "HTMLSourceElement",
            "HTMLIFrameElement",
            wrappedBody,
        );
        runScript(
            mockWindow,
            mockLocation,
            mockHistory,
            MockXHR,
            Request,
            mockNavigator,
            MockElement,
            MockScriptElement,
            class extends MockElement {},
            MockLinkElement,
            undefined,
            undefined,
            MockIFrameElement,
        );

        const script = new MockScriptElement();
        script.src = "/_next/static/chunks/main.js";
        expect(script.src).toBe("/api/tunnel/s-1/3000/_next/static/chunks/main.js");

        const link = new MockLinkElement();
        link.setAttribute("href", "/styles.css");
        expect(link.attrs.href).toBe("/api/tunnel/s-1/3000/styles.css");

        const iframe = new MockIFrameElement();
        iframe.src = "https://myserver.example.com/embed/demo";
        expect(iframe.src).toBe("https://myserver.example.com/api/tunnel/s-1/3000/embed/demo");
    });

    test("rewriteTunnelHtml interceptor patches sendBeacon and window.open", () => {
        const html = `<!doctype html><html><head></head><body>hello</body></html>`;
        const rewritten = rewriteTunnelHtml(html, "s-1", 3000);
        const scriptMatch = rewritten.match(/<script data-pizzapi-tunnel-intercept>\n([\s\S]*?)<\/script>/);
        expect(scriptMatch).toBeTruthy();
        const scriptBody = scriptMatch![1];

        const beaconUrls: string[] = [];
        const openedUrls: string[] = [];

        class MockXHR {
            open(_method: string, _url: string): void {}
        }

        const mockNavigator = {
            sendBeacon: (url: string, _data?: unknown) => {
                beaconUrls.push(url);
                return true;
            },
        };

        const mockWindow = {
            fetch: () => Promise.resolve(new Response(null, { status: 200 })),
            open: (url: string) => { openedUrls.push(url); return null; },
            WebSocket: function () {} as unknown as typeof WebSocket,
            EventSource: undefined as undefined,
        };
        (mockWindow.WebSocket as any).prototype = {};
        (mockWindow.WebSocket as any).CONNECTING = 0;
        (mockWindow.WebSocket as any).OPEN = 1;
        (mockWindow.WebSocket as any).CLOSING = 2;
        (mockWindow.WebSocket as any).CLOSED = 3;

        const mockLocation = { protocol: "https:", host: "myserver.example.com" };

        // The script reads `navigator` from the outer scope, so we need to
        // inject it. Wrap the script body so `navigator` is a local variable.
        const mockHistory = {
            pushState: (_state: unknown, _title: string, _url?: string | URL | null) => {},
            replaceState: (_state: unknown, _title: string, _url?: string | URL | null) => {},
        };

        const wrappedBody = `var navigator = __nav__;\n${scriptBody}`;
        const runScript = new Function("window", "location", "history", "XMLHttpRequest", "Request", "__nav__", wrappedBody);
        runScript(mockWindow, mockLocation, mockHistory, MockXHR, Request, mockNavigator);

        // ── sendBeacon: root-relative ──
        mockNavigator.sendBeacon("/api/heartbeat", "{}");
        expect(beaconUrls.at(-1)).toBe("/api/tunnel/s-1/3000/api/heartbeat");

        // ── sendBeacon: same-origin full URL ──
        mockNavigator.sendBeacon("https://myserver.example.com/api/heartbeat", "{}");
        expect(beaconUrls.at(-1)).toBe("https://myserver.example.com/api/tunnel/s-1/3000/api/heartbeat");

        // ── window.open: root-relative ──
        mockWindow.open("/help");
        expect(openedUrls.at(-1)).toBe("/api/tunnel/s-1/3000/help");

        // ── window.open: same-origin full URL ──
        mockWindow.open("https://myserver.example.com/settings");
        expect(openedUrls.at(-1)).toBe("https://myserver.example.com/api/tunnel/s-1/3000/settings");

        // ── window.open: external URL — should NOT be rewritten ──
        mockWindow.open("https://docs.example.com/guide");
        expect(openedUrls.at(-1)).toBe("https://docs.example.com/guide");
    });
});

describe("tunnel JS module rewriting", () => {
    test("rewriteInlineModuleScripts rewrites inline module bodies but skips external module scripts", () => {
        const html = `<script type="module">import "/src/main.tsx"</script><script type="module" src="/src/other.ts"></script>`;
        const rewritten = rewriteInlineModuleScripts(html, "s-1", 5173);
        expect(rewritten).toContain('import "/api/tunnel/s-1/5173/src/main.tsx"');
        expect(rewritten).toContain('src="/src/other.ts"');
    });

    test("shouldRewriteTunnelJs matches JavaScript content types", () => {
        expect(shouldRewriteTunnelJs("application/javascript")).toBe(true);
        expect(shouldRewriteTunnelJs("application/javascript; charset=utf-8")).toBe(true);
        expect(shouldRewriteTunnelJs("text/javascript")).toBe(true);
        expect(shouldRewriteTunnelJs("application/typescript")).toBe(true);
        expect(shouldRewriteTunnelJs("text/typescript")).toBe(true);
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
