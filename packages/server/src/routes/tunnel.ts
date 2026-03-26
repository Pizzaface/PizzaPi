/**
 * Tunnel HTTP proxy route — /api/tunnel/:sessionId/:port/*
 *
 * Translates an authenticated viewer's HTTP request into a tunnel_request
 * Socket.IO event sent to the runner daemon, then writes the tunnel_response
 * back as an HTTP response. WebSocket upgrades on this path are handled by
 * tunnel-ws.ts (WS-over-Socket.IO framing).
 *
 * Remaining limitations:
 *   - No streaming HTTP responses (body fully buffered, max 10 MB)
 *   - No SSE support
 *   - No CORS handling beyond header passthrough
 *   - Not suitable for large file downloads (>10 MB)
 */

import { requireSession } from "../middleware.js";
import { getSession } from "../ws/sio-state.js";
import { sendTunnelRequest } from "../ws/namespaces/runner.js";
import type { RouteHandler } from "./types.js";

/** Maximum request body size for tunnel proxying (10 MB). */
const MAX_TUNNEL_BODY_SIZE = 10 * 1024 * 1024;

/** Pattern: /api/tunnel/:sessionId/:port/<rest> */
const TUNNEL_PATH_RE = /^\/api\/tunnel\/([^/]+)\/(\d+)(\/.*)?$/;

function getTunnelBasePath(sessionId: string, port: number): string {
    return `/api/tunnel/${encodeURIComponent(sessionId)}/${port}`;
}

function rewriteTunnelUrl(value: string, sessionId: string, port: number): string {
    if (!value) return value;
    if (value.startsWith("//")) return value;
    if (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(value)) {
        try {
            const parsed = new URL(value);
            if ((parsed.protocol === "http:" || parsed.protocol === "https:") && (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost")) {
                return `${getTunnelBasePath(sessionId, port)}${parsed.pathname}${parsed.search}${parsed.hash}`;
            }
        } catch {
            return value;
        }
        return value;
    }
    if (!value.startsWith("/")) return value;
    return `${getTunnelBasePath(sessionId, port)}${value}`;
}

/**
 * Build an inline <script> that monkey-patches fetch and XMLHttpRequest
 * so absolute root-path requests (e.g. `/api/auth`, `/socket.io/`) are
 * rewritten through the tunnel proxy prefix. Without this, the tunneled
 * app's runtime JS calls bypass the `<base>` tag (which only affects
 * relative URLs in HTML attributes) and hit the host origin directly.
 */
function buildTunnelInterceptScript(basePath: string): string {
    // The script is injected synchronously before any app code runs.
    // It must be self-contained — no external imports.
    return `<script data-pizzapi-tunnel-intercept>
(function(){
  var B="${basePath}";
  function rw(u){
    if(typeof u!=="string")return u;
    if(u.startsWith(B))return u;
    if(u.startsWith("/"))return B+u;
    return u;
  }
  function rwInput(input,init){
    if(typeof input==="string") return [rw(input),init];
    if(input instanceof Request){
      var nu=rw(input.url);
      if(nu!==input.url) return [new Request(nu,input),init];
    }
    return [input,init];
  }
  // Rewrite ws:// and wss:// URLs pointing at localhost or same-origin through the tunnel
  function rwWs(u){
    if(typeof u!=="string")return u;
    // Absolute ws(s)://<host>/<path> URLs
    var m=u.match(/^wss?:\\/\\/([^\\/]+)(\\/.*)$/);
    if(m){
      var host=m[1];
      var path=m[2]||"/";
      if(host==="127.0.0.1"||host==="localhost"||host===location.host){
        var proto=location.protocol==="https:"?"wss:":"ws:";
        if(path.startsWith(B)) return proto+"//"+location.host+path;
        return proto+"//"+location.host+B+path;
      }
    }
    // Root-relative paths (e.g. "/__vite_hmr") — rewrite through tunnel
    if(u.startsWith("/")){
      var proto2=location.protocol==="https:"?"wss:":"ws:";
      if(u.startsWith(B)) return proto2+"//"+location.host+u;
      return proto2+"//"+location.host+B+u;
    }
    return u;
  }
  // Patch fetch
  var _f=window.fetch;
  window.fetch=function(input,init){
    var a=rwInput(input,init);
    return _f.call(this,a[0],a[1]);
  };
  // Patch XMLHttpRequest.open
  var _o=XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open=function(method,url){
    arguments[1]=rw(url);
    return _o.apply(this,arguments);
  };
  // Patch EventSource
  if(window.EventSource){
    var _E=window.EventSource;
    window.EventSource=function(url,cfg){return new _E(rw(url),cfg)};
    window.EventSource.prototype=_E.prototype;
  }
  // Patch WebSocket
  var _W=window.WebSocket;
  window.WebSocket=function(url,protocols){
    return new _W(rwWs(url),protocols);
  };
  window.WebSocket.prototype=_W.prototype;
  window.WebSocket.CONNECTING=_W.CONNECTING;
  window.WebSocket.OPEN=_W.OPEN;
  window.WebSocket.CLOSING=_W.CLOSING;
  window.WebSocket.CLOSED=_W.CLOSED;
})();
</script>`;
}

function rewriteInlineModuleScripts(html: string, sessionId: string, port: number): string {
    return html.replace(/<script\b([^>]*)type=["']module["']([^>]*)>([\s\S]*?)<\/script>/gi, (match, before, after, scriptBody) => {
        // Skip external module scripts; their src attribute is already rewritten separately.
        if (/\bsrc\s*=/i.test(before) || /\bsrc\s*=/i.test(after)) return match;
        return `<script${before}type="module"${after}>${rewriteTunnelJsModule(scriptBody, sessionId, port)}</script>`;
    });
}

function rewriteTunnelHtml(html: string, sessionId: string, port: number): string {
    const basePath = getTunnelBasePath(sessionId, port);
    const rewritten = rewriteInlineModuleScripts(
        html
            .replace(/(<(?:img|script|iframe|audio|video|source|track|embed|input)\b[^>]*\bsrc=["'])(\/[^"']*)(["'])/gi, (_m, start, path, end) => `${start}${rewriteTunnelUrl(path, sessionId, port)}${end}`)
            .replace(/(<(?:a|link|area)\b[^>]*\bhref=["'])(\/[^"']*)(["'])/gi, (_m, start, path, end) => `${start}${rewriteTunnelUrl(path, sessionId, port)}${end}`)
            .replace(/(<(?:form)\b[^>]*\baction=["'])(\/[^"']*)(["'])/gi, (_m, start, path, end) => `${start}${rewriteTunnelUrl(path, sessionId, port)}${end}`)
            .replace(/(<meta\b[^>]*\bcontent=["'][^"']*?url=)(\/[^"']*)(["'])/gi, (_m, start, path, end) => `${start}${rewriteTunnelUrl(path, sessionId, port)}${end}`)
            .replace(/(\burl\(["']?)(\/[^)"']*)(["']?\))/gi, (_m, start, path, end) => `${start}${rewriteTunnelUrl(path, sessionId, port)}${end}`),
        sessionId,
        port,
    );

    const injection = `<base href="${basePath}/">${buildTunnelInterceptScript(basePath)}`;

    if (/<head\b[^>]*>/i.test(rewritten)) {
        return rewritten.replace(/<head\b[^>]*>/i, (match) => `${match}${injection}`);
    }

    return `${injection}${rewritten}`;
}

function shouldRewriteTunnelHtml(contentType: string | null): boolean {
    return !!contentType && /text\/html|application\/xhtml\+xml/i.test(contentType);
}

/**
 * Check if the response is a JavaScript/TypeScript module that may contain
 * absolute import paths needing tunnel-prefix rewriting.
 */
function shouldRewriteTunnelJs(contentType: string | null): boolean {
    if (!contentType) return false;
    return /application\/(?:javascript|ecmascript|x-javascript|typescript)|text\/(?:javascript|ecmascript|x-javascript|typescript)/i.test(contentType);
}

/**
 * Check if the response is CSS that may contain absolute @import or url() paths.
 */
function shouldRewriteTunnelCss(contentType: string | null): boolean {
    if (!contentType) return false;
    return /text\/css/i.test(contentType);
}

/**
 * Rewrite absolute paths in ES module source code so imports resolve through
 * the tunnel proxy prefix instead of hitting the host origin directly.
 *
 * Handles:
 *   - Static imports:  `import x from "/path"`, `import "/path"`
 *   - Re-exports:      `export { x } from "/path"`
 *   - Dynamic imports: `import("/path")`
 *   - `new URL("/path", import.meta.url)`
 *
 * Only rewrites root-relative paths (`/...`). Leaves relative paths, bare
 * specifiers, and full URLs (http://, //) untouched.
 */
function rewriteTunnelJsModule(js: string, sessionId: string, port: number): string {
    const basePath = getTunnelBasePath(sessionId, port);

    // Already-rewritten paths start with basePath — skip them.
    // The regex matches: (from/import)( whitespace "or' )( /path )( "or' )
    // We capture the absolute path and prefix it.
    return js
        // Static import/export ... from "/path"
        // Matches: from "/...", from '/...'
        .replace(/((?:from|import)\s*)(["'])(\/(?!\/)[^"']*)(["'])/g, (match, prefix, q1, path, q2) => {
            if (path.startsWith(basePath)) return match; // already rewritten
            return `${prefix}${q1}${basePath}${path}${q2}`;
        })
        // Dynamic import("/path") — import( "/..." ) or import( '/...' )
        .replace(/(import\s*\(\s*)(["'])(\/(?!\/)[^"']*)(["'])/g, (match, prefix, q1, path, q2) => {
            if (path.startsWith(basePath)) return match;
            return `${prefix}${q1}${basePath}${path}${q2}`;
        })
        // new URL("/path", import.meta.url)
        .replace(/(new\s+URL\s*\(\s*)(["'])(\/(?!\/)[^"']*)(["'])/g, (match, prefix, q1, path, q2) => {
            if (path.startsWith(basePath)) return match;
            return `${prefix}${q1}${basePath}${path}${q2}`;
        });
}

/**
 * Rewrite absolute paths in CSS — @import and url() references.
 */
function rewriteTunnelCss(css: string, sessionId: string, port: number): string {
    const basePath = getTunnelBasePath(sessionId, port);

    return css
        // @import "/path" or @import '/path' or @import url("/path")
        .replace(/(@import\s+)(["'])(\/(?!\/)[^"']*)(["'])/g, (match, prefix, q1, path, q2) => {
            if (path.startsWith(basePath)) return match;
            return `${prefix}${q1}${basePath}${path}${q2}`;
        })
        // url(/path), url("/path"), url('/path')
        .replace(/(url\s*\(\s*)(["']?)(\/(?!\/)[^)"']*)(["']?\s*\))/g, (match, prefix, q1, path, q2) => {
            if (path.startsWith(basePath)) return match;
            return `${prefix}${q1}${basePath}${path}${q2}`;
        });
}

/**
 * Tunnel route handler.
 *
 * Auth: the caller must be authenticated (session cookie or API key) AND must
 * either own the session or the session must be accessible (viewable) by them.
 * For now we require session ownership (userId match) since tunnels expose the
 * runner's localhost — they should not be openly accessible to all viewers.
 */
export const handleTunnelRoute: RouteHandler = async (req, url) => {
    const match = url.pathname.match(TUNNEL_PATH_RE);
    if (!match) return undefined;

    const method = req.method.toUpperCase();
    if (!["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"].includes(method)) {
        return new Response("Method not allowed", {
            status: 405,
            headers: { Allow: "GET, POST, PUT, DELETE, PATCH, HEAD, OPTIONS" },
        });
    }

    // ── Authenticate caller ──────────────────────────────────────────────────
    const identity = await requireSession(req);
    if (identity instanceof Response) return identity;

    // ── Parse path segments ──────────────────────────────────────────────────
    const sessionId = decodeURIComponent(match[1]);
    const port = parseInt(match[2], 10);
    const proxyPath = match[3] ?? "/";

    if (!sessionId) {
        return Response.json({ error: "Missing session ID" }, { status: 400 });
    }

    if (!Number.isFinite(port) || port < 1 || port > 65535) {
        return Response.json({ error: "Invalid port" }, { status: 400 });
    }

    // Reconstruct proxy path with query string, stripping auth query params (apiKey)
    // so they are not forwarded to the local service — SSRF auth-leakage vector.
    let pathWithQuery: string;
    if (url.search) {
        const qs = new URLSearchParams(url.search.slice(1));
        qs.delete("apiKey");
        const qsStr = qs.toString();
        pathWithQuery = qsStr ? `${proxyPath}?${qsStr}` : proxyPath;
    } else {
        pathWithQuery = proxyPath;
    }

    // ── Look up session and verify ownership ─────────────────────────────────
    const sessionData = await getSession(sessionId);
    if (!sessionData) {
        return Response.json({ error: "Session not found" }, { status: 404 });
    }

    // Only the session owner may access the tunnel — it exposes localhost.
    // Fail-closed: reject if userId is missing (no confirmed owner) OR mismatched.
    if (!sessionData.userId || sessionData.userId !== identity.userId) {
        return Response.json({ error: "Forbidden" }, { status: 403 });
    }

    const runnerId = sessionData.runnerId;
    if (!runnerId) {
        return Response.json({ error: "Session has no runner" }, { status: 503 });
    }

    // ── Read and enforce body size limit ─────────────────────────────────────
    let bodyBase64: string | undefined;
    if (req.body && method !== "GET" && method !== "HEAD") {
        const bodyBuffer = await req.arrayBuffer();
        if (bodyBuffer.byteLength > MAX_TUNNEL_BODY_SIZE) {
            return Response.json(
                { error: `Request body exceeds ${MAX_TUNNEL_BODY_SIZE / 1024 / 1024} MB limit` },
                { status: 413 },
            );
        }
        if (bodyBuffer.byteLength > 0) {
            bodyBase64 = Buffer.from(bodyBuffer).toString("base64");
        }
    }

    // ── Forward headers (strip hop-by-hop and host) ───────────────────────────
    const HOP_BY_HOP = new Set([
        "connection",
        "keep-alive",
        "transfer-encoding",
        "te",
        "trailer",
        "upgrade",
        "proxy-authorization",
        "proxy-authenticate",
        // Rewrite host to 127.0.0.1:{port} in the runner
        "host",
    ]);

    // Auth headers that must not be forwarded to the runner/local service.
    // x-api-key is used to authenticate against the PizzaPi server — it must
    // never reach the tunneled localhost service (SSRF auth-leakage vector).
    const STRIP_AUTH = new Set(["cookie", "authorization", "x-api-key"]);

    const forwardHeaders: Record<string, string> = {};
    req.headers.forEach((v, k) => {
        const lk = k.toLowerCase();
        if (!HOP_BY_HOP.has(lk) && !STRIP_AUTH.has(lk)) forwardHeaders[k] = v;
    });

    // ── Build requestId and emit tunnel_request ───────────────────────────────
    const requestId = `${sessionId}-${port}-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    let tunnelResponse;
    try {
        tunnelResponse = await sendTunnelRequest(runnerId, {
            requestId,
            port,
            method,
            path: pathWithQuery,
            headers: forwardHeaders,
            body: bodyBase64,
        });
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("not connected") || msg.includes("disconnected")) {
            return Response.json({ error: "Runner not available" }, { status: 503 });
        }
        if (msg.includes("timed out")) {
            return Response.json({ error: "Tunnel request timed out" }, { status: 504 });
        }
        return Response.json({ error: `Tunnel error: ${msg}` }, { status: 502 });
    }

    // ── Write response back to viewer ─────────────────────────────────────────
    let responseBody = Buffer.from(tunnelResponse.body, "base64");

    const responseHeaders = new Headers();
    for (const [k, v] of Object.entries(tunnelResponse.headers)) {
        try {
            responseHeaders.set(k, v);
        } catch {
            // Skip headers that are invalid in the Headers API
        }
    }

    const location = responseHeaders.get("location");
    if (location) {
        responseHeaders.set("location", rewriteTunnelUrl(location, sessionId, port));
    }

    const contentType = responseHeaders.get("content-type");
    if (shouldRewriteTunnelHtml(contentType)) {
        const html = responseBody.toString("utf8");
        responseBody = Buffer.from(rewriteTunnelHtml(html, sessionId, port), "utf8");
        responseHeaders.delete("content-length");
        responseHeaders.delete("content-encoding");
    } else if (shouldRewriteTunnelJs(contentType)) {
        const js = responseBody.toString("utf8");
        responseBody = Buffer.from(rewriteTunnelJsModule(js, sessionId, port), "utf8");
        responseHeaders.delete("content-length");
        responseHeaders.delete("content-encoding");
    } else if (shouldRewriteTunnelCss(contentType)) {
        const css = responseBody.toString("utf8");
        responseBody = Buffer.from(rewriteTunnelCss(css, sessionId, port), "utf8");
        responseHeaders.delete("content-length");
        responseHeaders.delete("content-encoding");
    }

    // Mark as tunnel response so withSecurityHeaders applies relaxed policy.
    responseHeaders.set("x-pizzapi-tunnel", "1");

    return new Response(responseBody, {
        status: tunnelResponse.status,
        headers: responseHeaders,
    });
};

export {
    getTunnelBasePath,
    rewriteTunnelUrl,
    rewriteTunnelHtml,
    rewriteInlineModuleScripts,
    shouldRewriteTunnelHtml,
    shouldRewriteTunnelJs,
    shouldRewriteTunnelCss,
    rewriteTunnelJsModule,
    rewriteTunnelCss,
};
