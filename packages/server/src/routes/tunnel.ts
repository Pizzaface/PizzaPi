/**
 * Tunnel HTTP proxy route — /api/tunnel/:sessionId/:port/* and /api/tunnel/runner/:runnerId/:port/*
 *
 * Translates an authenticated viewer's HTTP request into a streamed relay
 * request sent to the runner daemon, then writes the streamed response back as
 * an HTTP response. WebSocket upgrades on this path are handled by tunnel-ws.ts.
 *
 * Two URL schemes:
 *   - Session-based: /api/tunnel/:sessionId/:port/* (legacy, resolves sessionId → runnerId)
 *   - Runner-based:  /api/tunnel/runner/:runnerId/:port/* (preferred, stable across session switches)
 */

import { TUNNEL_SEND_HIGH_WATER_BYTES, type TunnelRelay } from "@pizzapi/tunnel";
import { requireSession } from "../middleware.js";
import { assertTunnelTokenStillValid, createTunnelToken, getAuthTunnelBasePath, tunnelTokenAgeMs, verifyTunnelToken } from "./tunnel-token.js";
import { getTunnelRelay } from "../tunnel-relay.js";
import { getSession } from "../ws/sio-state/index.js";
import { getRunnerData } from "../ws/sio-registry.js";
import { LABEL_MAX_TTL_HOURS, mintTunnelLabel } from "./tunnel-host.js";
import type { RouteHandler } from "./types.js";

const TUNNEL_MAX_BUFFERED_BYTES = 25 * 1024 * 1024; // hard safety cap; larger rewritable responses return 413 instead of buffering
/** Streamed responses: ask the runner to pause once this many bytes wait for the viewer. */
const TUNNEL_STREAM_HIGH_WATER_BYTES = TUNNEL_SEND_HIGH_WATER_BYTES;
/**
 * Above this, buffering the whole body to run the multi-pass HTML/JS/CSS
 * rewrite regexes synchronously would block the shared relay event loop for
 * too long. Bodies that grow past this (or declare a Content-Length past it)
 * fall back to unrewritten passthrough streaming instead — absolute URLs in
 * a response this large go unrewritten, but every other tunnel/session on
 * the relay keeps responding.
 * ponytail: fixed threshold, revisit with a worker-thread offload if large
 * rewritable responses turn out to be common enough to need rewriting too.
 */
const TUNNEL_SYNC_REWRITE_MAX_BYTES = 2 * 1024 * 1024;

/** Pattern: /api/tunnel/auth/:token/:sessionId/:port/<rest> — mobile iframe auth. */
const AUTH_TUNNEL_PATH_RE = /^\/api\/tunnel\/auth\/([^/]+)\/([^/]+)\/(\d+)(\/.*)?$/;

/** Pattern: /api/tunnel/runner/:runnerId/:port/<rest> — must be checked first (more specific). */
const RUNNER_TUNNEL_PATH_RE = /^\/api\/tunnel\/runner\/([^/]+)\/(\d+)(\/.*)?$/;

/** Pattern: /api/tunnel/:sessionId/:port/<rest> */
const TUNNEL_PATH_RE = /^\/api\/tunnel\/([^/]+)\/(\d+)(\/.*)?$/;

/** True for the signed-token tunnel route (/api/tunnel/auth/<token>/…). */
export function isAuthTunnelPath(pathname: string): boolean {
    return AUTH_TUNNEL_PATH_RE.test(pathname);
}

/**
 * CSP applied to every path-based tunnel response (see withSecurityHeaders).
 * `sandbox` without `allow-same-origin` gives the document an opaque origin,
 * so runner-controlled scripts cannot act as the relay origin — even when the
 * URL is opened top-level, outside the UI's sandboxed iframe.
 */
export const PATH_TUNNEL_SANDBOX_CSP = "sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads";

/**
 * Lifetime of signed tunnel URLs the relay mints itself when a browser
 * navigates to a cookie-authenticated tunnel path (see redirectToTokenTunnel).
 * Matches the default absolute lifetime of host-origin tunnel labels so a
 * long-open preview does not lose its subresources after an hour.
 */
export const TUNNEL_NAVIGATION_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Browsers attach no relay cookie to subresource requests from an opaque
 * (sandboxed) document, so a cookie-authenticated path tunnel cannot load its
 * own assets once it is sandboxed. Navigations to those paths are therefore
 * redirected to an equivalent signed-token path that carries its auth in the
 * URL. Non-navigation requests (API clients, curl) are served as before.
 */
function isBrowserNavigation(req: Request): boolean {
    const method = req.method.toUpperCase();
    return (method === "GET" || method === "HEAD") && req.headers.get("sec-fetch-mode") === "navigate";
}

function redirectToTokenTunnel(userId: string, scope: string, port: number, url: URL, proxyPath: string): Response {
    const { token } = createTunnelToken({ userId, sessionId: scope, port, ttlMs: TUNNEL_NAVIGATION_TOKEN_TTL_MS });
    return new Response(null, {
        status: 302,
        headers: {
            Location: `${getAuthTunnelBasePath(token, scope, port)}${buildPathWithQuery(url, proxyPath)}`,
            "Cache-Control": "no-store",
        },
    });
}

/**
 * Sandboxed tunnel documents have an opaque origin, so their own fetch/XHR,
 * module scripts, fonts and EventSource requests back to the token path are
 * cross-origin (`Origin: null`). The token route is authenticated by the URL
 * alone and forwards no relay cookies, so it can safely grant CORS to the
 * opaque origin — including credentialed mode, which apps using
 * `credentials: "include"` / `withCredentials` require.
 */
function isOpaqueOriginRequest(req: Request): boolean {
    return req.headers.get("origin") === "null";
}

function opaqueOriginPreflight(req: Request): Response {
    const headers = new Headers({
        "Access-Control-Allow-Origin": "null",
        "Access-Control-Allow-Credentials": "true",
        "Access-Control-Allow-Methods": req.headers.get("access-control-request-method") ?? "GET",
        "Access-Control-Max-Age": "600",
        Vary: "Origin",
    });
    const requestedHeaders = req.headers.get("access-control-request-headers");
    if (requestedHeaders) headers.set("Access-Control-Allow-Headers", requestedHeaders);
    return new Response(null, { status: 204, headers });
}

function withOpaqueOriginCors(res: Response): Response {
    const headers = new Headers(res.headers);
    const exposed: string[] = [];
    headers.forEach((_value, key) => {
        if (!key.toLowerCase().startsWith("x-pizzapi-tunnel")) exposed.push(key);
    });
    headers.set("Access-Control-Allow-Origin", "null");
    headers.set("Access-Control-Allow-Credentials", "true");
    if (exposed.length > 0) headers.set("Access-Control-Expose-Headers", exposed.join(", "));
    headers.append("Vary", "Origin");
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

/**
 * decodeURIComponent that returns "" on malformed percent-encoding instead of
 * throwing URIError — callers already 400 on empty path components.
 */
export function safeDecodePathComponent(component: string): string {
    try {
        return decodeURIComponent(component);
    } catch {
        return "";
    }
}

function getTunnelBasePath(sessionId: string, port: number): string {
    return `/api/tunnel/${encodeURIComponent(sessionId)}/${port}`;
}

function getRunnerTunnelBasePath(runnerId: string, port: number): string {
    return `/api/tunnel/runner/${encodeURIComponent(runnerId)}/${port}`;
}

/** Core URL rewriter — all variants delegate here. */
function rewriteUrlByBasePath(value: string, basePath: string): string {
    if (!value) return value;
    if (value.startsWith("//")) return value;
    if (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(value)) {
        try {
            const parsed = new URL(value);
            if ((parsed.protocol === "http:" || parsed.protocol === "https:") && (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost")) {
                return `${basePath}${parsed.pathname}${parsed.search}${parsed.hash}`;
            }
        } catch {
            return value;
        }
        return value;
    }
    if (!value.startsWith("/")) return value;
    return `${basePath}${value}`;
}

function rewriteTunnelUrl(value: string, sessionId: string, port: number): string {
    return rewriteUrlByBasePath(value, getTunnelBasePath(sessionId, port));
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
  // Path tunnels run in a CSP sandbox (opaque origin), where touching
  // localStorage/sessionStorage/document.cookie throws SecurityError. Give
  // apps a per-page in-memory stand-in so they keep working; persistence
  // needs the isolated tunnel origin (PIZZAPI_TUNNEL_DOMAIN).
  function mem(){
    var d=Object.create(null);
    return {
      get length(){return Object.keys(d).length},
      key:function(i){var k=Object.keys(d);return i<k.length?k[i]:null},
      getItem:function(k){k=String(k);return k in d?d[k]:null},
      setItem:function(k,v){d[String(k)]=String(v)},
      removeItem:function(k){delete d[String(k)]},
      clear:function(){d=Object.create(null)}
    };
  }
  ["localStorage","sessionStorage"].forEach(function(n){
    try{void window[n].length}catch(_e){try{Object.defineProperty(window,n,{value:mem(),configurable:true})}catch(_x){}}
  });
  try{void document.cookie}catch(_e){
    var jar=Object.create(null);
    try{Object.defineProperty(document,"cookie",{configurable:true,
      get:function(){return Object.keys(jar).map(function(k){return k+"="+jar[k]}).join("; ")},
      set:function(v){var p=String(v).split(";")[0],i=p.indexOf("=");if(i>0)jar[p.slice(0,i).trim()]=p.slice(i+1).trim()}
    })}catch(_x){}
  }
  function rw(u){
    if(typeof u!=="string")return u;
    if(u.startsWith(B))return u;
    if(u.startsWith("/")){return B+u;}
    // Full URLs — same origin or localhost — must also go through the tunnel.
    // Without this, apps that construct "https://host/path" API calls (e.g.
    // Jellyfin) bypass the tunnel and hit the PizzaPi server directly → 404.
    var m=u.match(/^(https?:)\\/\\/([^\\/]+)(\\/.+)?$/);
    if(m){
      var proto=m[1],host=m[2],path=m[3]||"/";
      if(host===location.host){
        if(path.startsWith(B))return u;
        return proto+"//"+host+B+path;
      }
      if(host.split(":")[0]==="127.0.0.1"||host.split(":")[0]==="localhost"){
        return location.protocol+"//"+location.host+B+path;
      }
    }
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
    var m=u.match(/^wss?:\\/\\/([^\\/]+)(\\/.*)?$/);
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
  // Patch history navigation used by SPA routers (e.g. Next.js router.push).
  if(history&&history.pushState){
    var _ps=history.pushState.bind(history);
    history.pushState=function(state,title,url){return _ps(state,title,typeof url==="string"?rw(url):url)};
  }
  if(history&&history.replaceState){
    var _rs=history.replaceState.bind(history);
    history.replaceState=function(state,title,url){return _rs(state,title,typeof url==="string"?rw(url):url)};
  }
  // Patch direct location navigation. Shadowing instance methods is sufficient
  // for our iframe runtime and keeps the patch self-contained.
  if(location&&location.assign){
    var _la=location.assign.bind(location);
    location.assign=function(url){return _la(typeof url==="string"?rw(url):url)};
  }
  if(location&&location.replace){
    var _lr=location.replace.bind(location);
    location.replace=function(url){return _lr(typeof url==="string"?rw(url):url)};
  }
  // Patch navigator.sendBeacon
  if(navigator.sendBeacon){
    var _b=navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon=function(url,data){return _b(rw(url),data)};
  }
  // Patch window.open
  var _wo=window.open;
  window.open=function(url,target,features){return _wo.call(this,typeof url==="string"?rw(url):url,target,features)};
  // Patch dynamic resources created at runtime (e.g. Next.js webpack chunk loader
  // sets script.src = "/_next/static/chunks/..." directly, bypassing fetch/XHR).
  if(typeof Element!=="undefined"){
    var _sa=Element.prototype.setAttribute;
    Element.prototype.setAttribute=function(name,value){
      var ln=String(name).toLowerCase();
      if((ln==="src"||ln==="href"||ln==="action")&&typeof value==="string") value=rw(value);
      return _sa.call(this,name,value);
    };
    function iprop(P,n){
      if(!P) return;
      var d=Object.getOwnPropertyDescriptor(P,n);
      if(!d||!d.set) return;
      Object.defineProperty(P,n,{get:d.get,set:function(v){d.set.call(this,typeof v==="string"?rw(v):v)},configurable:true,enumerable:true});
    }
    if(typeof HTMLScriptElement!=="undefined") iprop(HTMLScriptElement.prototype,"src");
    if(typeof HTMLImageElement!=="undefined") iprop(HTMLImageElement.prototype,"src");
    if(typeof HTMLLinkElement!=="undefined") iprop(HTMLLinkElement.prototype,"href");
    if(typeof HTMLMediaElement!=="undefined") iprop(HTMLMediaElement.prototype,"src");
    if(typeof HTMLSourceElement!=="undefined") iprop(HTMLSourceElement.prototype,"src");
    if(typeof HTMLIFrameElement!=="undefined") iprop(HTMLIFrameElement.prototype,"src");
    if(typeof HTMLFormElement!=="undefined") iprop(HTMLFormElement.prototype,"action");
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

function rewriteInlineModuleScriptsByBasePath(html: string, basePath: string): string {
    return html.replace(/<script\b([^>]*)type=["']module["']([^>]*)>([\s\S]*?)<\/script>/gi, (match, before, after, scriptBody) => {
        if (/\bsrc\s*=/i.test(before) || /\bsrc\s*=/i.test(after)) return match;
        return `<script${before}type="module"${after}>${rewriteJsModuleByBasePath(scriptBody, basePath)}</script>`;
    });
}

function rewriteInlineModuleScripts(html: string, sessionId: string, port: number): string {
    return rewriteInlineModuleScriptsByBasePath(html, getTunnelBasePath(sessionId, port));
}

function rewriteHtmlByBasePath(html: string, basePath: string, proxyPath?: string): string {
    // Compute the base href from the actual document path so relative URLs
    // in apps served from sub-paths (e.g. Jellyfin at /web/) resolve correctly.
    // The interceptor script still uses the tunnel root for root-relative rewrites.
    const docDir = proxyPath
        ? proxyPath.endsWith("/")
            ? proxyPath
            : proxyPath.substring(0, proxyPath.lastIndexOf("/") + 1) || "/"
        : "/";
    const baseHref = `${basePath}${docDir}`;

    // Strip any existing <base> tags from the original HTML — the injected one
    // must be the only <base> so it takes effect per the HTML spec (first wins).
    const cleaned = html.replace(/<base\b[^>]*>/gi, "");

    const rewritten = rewriteInlineModuleScriptsByBasePath(
        cleaned
            .replace(/(<(?:img|script|iframe|audio|video|source|track|embed|input)\b[^>]*\bsrc=["'])(\/[^"']*)(["'])/gi, (_m, start, path, end) => `${start}${rewriteUrlByBasePath(path, basePath)}${end}`)
            .replace(/(<(?:a|link|area)\b[^>]*\bhref=["'])(\/[^"']*)(["'])/gi, (_m, start, path, end) => `${start}${rewriteUrlByBasePath(path, basePath)}${end}`)
            .replace(/(<(?:form)\b[^>]*\baction=["'])(\/[^"']*)(["'])/gi, (_m, start, path, end) => `${start}${rewriteUrlByBasePath(path, basePath)}${end}`)
            .replace(/(<meta\b[^>]*\bcontent=["'][^"']*?url=)(\/[^"']*)(["'])/gi, (_m, start, path, end) => `${start}${rewriteUrlByBasePath(path, basePath)}${end}`)
            .replace(/(\burl\(["']?)(\/[^)"']*)(["']?\))/gi, (_m, start, path, end) => `${start}${rewriteUrlByBasePath(path, basePath)}${end}`),
        basePath,
    );

    const injection = `<base href="${baseHref}">${buildTunnelInterceptScript(basePath)}`;

    if (/<head\b[^>]*>/i.test(rewritten)) {
        return rewritten.replace(/<head\b[^>]*>/i, (match) => `${match}${injection}`);
    }

    return `${injection}${rewritten}`;
}

function rewriteTunnelHtml(html: string, sessionId: string, port: number, proxyPath?: string): string {
    return rewriteHtmlByBasePath(html, getTunnelBasePath(sessionId, port), proxyPath);
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
function rewriteJsModuleByBasePath(js: string, basePath: string): string {
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

function rewriteTunnelJsModule(js: string, sessionId: string, port: number): string {
    return rewriteJsModuleByBasePath(js, getTunnelBasePath(sessionId, port));
}

/**
 * Rewrite absolute paths in CSS — @import and url() references.
 */
function rewriteCssByBasePath(css: string, basePath: string): string {
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

function rewriteTunnelCss(css: string, sessionId: string, port: number): string {
    return rewriteCssByBasePath(css, getTunnelBasePath(sessionId, port));
}

function shouldBufferTunnelResponse(contentType: string | null): boolean {
    return shouldRewriteTunnelHtml(contentType)
        || shouldRewriteTunnelJs(contentType)
        || shouldRewriteTunnelCss(contentType);
}

/**
 * Response headers that mutate browser state for the WHOLE origin (cookies,
 * site data, service-worker scope, HSTS, alt services, reporting policies,
 * credentialed CORS). Path-based tunnels are served from the relay origin, so
 * a runner-local service must never be able to emit these: they would set,
 * shadow, or clear PizzaPi's own cookies/storage or persist policy for the
 * relay. Local apps that need cookies must use the isolated tunnel origin
 * (PIZZAPI_TUNNEL_DOMAIN), where they are scoped to the app's own host.
 */
export const PATH_TUNNEL_ORIGIN_STATE_HEADERS: readonly string[] = [
    "set-cookie",
    "set-cookie2",
    "clear-site-data",
    "service-worker-allowed",
    "strict-transport-security",
    "alt-svc",
    "nel",
    "report-to",
    "reporting-endpoints",
    "access-control-allow-credentials",
];

/** Internal relay markers — an upstream service must never be able to supply them. */
function stripInternalTunnelMarkers(responseHeaders: Headers): void {
    const internal: string[] = [];
    responseHeaders.forEach((_value, key) => {
        if (key.toLowerCase().startsWith("x-pizzapi-tunnel")) internal.push(key);
    });
    for (const key of internal) responseHeaders.delete(key);
}

function applyResponseHeadersByBasePath(responseHeaders: Headers, basePath: string, allowCrossOriginFrame = false): void {
    // Upstream-supplied copies of our internal markers (e.g. a forged
    // x-pizzapi-tunnel-frame: cross-origin to drop X-Frame-Options) are removed
    // before the relay sets its own.
    stripInternalTunnelMarkers(responseHeaders);
    const location = responseHeaders.get("location");
    if (location) {
        responseHeaders.set("location", rewriteUrlByBasePath(location, basePath));
    }
    if (basePath !== "") {
        // Path-based tunnel: the response is served on the relay origin.
        for (const header of PATH_TUNNEL_ORIGIN_STATE_HEADERS) responseHeaders.delete(header);
    } else {
        // Host-based tunnel: force cookies host-only. A malicious local app
        // could otherwise Set-Cookie with Domain=.<tunnel domain> (poisoning
        // sibling tunnels) or a parent registrable domain shared with the
        // relay (cookie tossing / session fixation).
        const setCookies = responseHeaders.getSetCookie?.() ?? [];
        if (setCookies.length > 0) {
            responseHeaders.delete("set-cookie");
            for (const cookie of setCookies) {
                responseHeaders.append("set-cookie", cookie.replace(/;\s*domain=[^;]*/gi, ""));
            }
        }
    }
    // "host" = isolated tunnel origin; "path" = served on the relay origin
    // (withSecurityHeaders sandboxes everything that is not "host").
    responseHeaders.set("x-pizzapi-tunnel", basePath === "" ? "host" : "path");
    if (allowCrossOriginFrame) responseHeaders.set("x-pizzapi-tunnel-frame", "cross-origin");
}

function rewriteBufferedResponseByBasePath(
    responseBody: Buffer,
    responseHeaders: Headers,
    basePath: string,
    proxyPath: string,
): Buffer {
    const contentType = responseHeaders.get("content-type");

    if (shouldRewriteTunnelHtml(contentType)) {
        responseHeaders.delete("content-length");
        responseHeaders.delete("content-encoding");
        return Buffer.from(rewriteHtmlByBasePath(responseBody.toString("utf8"), basePath, proxyPath), "utf8");
    }

    if (shouldRewriteTunnelJs(contentType)) {
        responseHeaders.delete("content-length");
        responseHeaders.delete("content-encoding");
        return Buffer.from(rewriteJsModuleByBasePath(responseBody.toString("utf8"), basePath), "utf8");
    }

    if (shouldRewriteTunnelCss(contentType)) {
        responseHeaders.delete("content-length");
        responseHeaders.delete("content-encoding");
        return Buffer.from(rewriteCssByBasePath(responseBody.toString("utf8"), basePath), "utf8");
    }

    return responseBody;
}

function tunnelErrorResponse(message: string): Response {
    if (message.includes("not connected") || message.includes("disconnected")) {
        return Response.json({ error: "Runner not available" }, { status: 503 });
    }

    if (message.includes("timed out")) {
        return Response.json({ error: "Tunnel request timed out" }, { status: 504 });
    }

    if (message.includes("Too many concurrent")) {
        return Response.json({ error: `Tunnel error: ${message}` }, { status: 503, headers: { "Retry-After": "1" } });
    }

    if (message.includes("body too large") || message.includes("too large")) {
        return Response.json({ error: `Tunnel error: ${message}` }, { status: 413 });
    }

    return Response.json({ error: `Tunnel error: ${message}` }, { status: 502 });
}

function bufferToBodyInit(buffer: Buffer): BodyInit {
    return buffer as unknown as BodyInit;
}

async function streamRequestBodyToRelay(
    req: Request,
    relay: TunnelRelay,
    runnerId: string,
    requestId: string,
    signal: AbortSignal,
): Promise<void> {
    if (!req.body || req.method === "GET" || req.method === "HEAD") {
        if (!signal.aborted) relay.sendRequestDataEnd(runnerId, requestId);
        return;
    }

    const reader = req.body.getReader();
    let cancelled = false;
    const cancelReader = (): void => {
        if (cancelled) return;
        cancelled = true;
        void reader.cancel(signal.reason).catch(() => {});
    };
    signal.addEventListener("abort", cancelReader, { once: true });
    let bodyRejected = false;
    try {
        while (!signal.aborted) {
            // Backpressure: do not pull more of the viewer's body until the
            // runner socket has drained and the runner has not paused us.
            await relay.waitForRequestCapacity(runnerId, requestId, signal);
            if (signal.aborted) break;
            const { done, value } = await reader.read();
            if (done || signal.aborted) break;
            if (!value || value.byteLength === 0) continue;
            if (!relay.sendRequestData(runnerId, requestId, Buffer.from(value))) {
                // Over the body limit (the relay already failed the request)
                // or the runner is gone — stop reading the viewer's body.
                bodyRejected = true;
                cancelReader();
                break;
            }
        }
    } finally {
        signal.removeEventListener("abort", cancelReader);
        if (signal.aborted) cancelReader();
        reader.releaseLock();
    }

    if (!signal.aborted && !bodyRejected) relay.sendRequestDataEnd(runnerId, requestId);
}

/** 413 when a declared Content-Length already exceeds the tunnel request-body limit. */
function rejectOversizedTunnelBody(req: Request, relay: TunnelRelay): Response | null {
    const limit = relay.limits.maxRequestBodyBytes;
    if (limit <= 0) return null;
    const declared = req.headers.get("content-length");
    if (declared === null || !/^\d+$/.test(declared)) return null;
    if (Number(declared) <= limit) return null;
    return tunnelErrorResponse("Request body too large");
}

function proxyTunnelRequestViaRelay(
    req: Request,
    relay: TunnelRelay,
    runnerId: string,
    requestId: string,
    basePath: string,
    port: number,
    proxyPath: string,
    pathWithQuery: string,
    forwardHeaders: Record<string, string>,
    allowCrossOriginFrame = false,
    tunnelHost?: string,
    /** Set for capability-authenticated routes (token/label) — see TunnelRequestStartMessage. */
    capabilityAgeMs?: number,
): Promise<Response> {
    const oversized = rejectOversizedTunnelBody(req, relay);
    if (oversized) return Promise.resolve(oversized);
    const maxStreamBufferedBytes = relay.limits.maxBufferedBytes;
    return new Promise<Response>((resolve) => {
        const bodyAbortController = new AbortController();
        let relayCancel: (() => void) | undefined;
        let relayCancelRequested = false;
        let relayCancelled = false;
        let clientAbortListenerAttached = true;

        const cancelRelay = (): void => {
            relayCancelRequested = true;
            if (!relayCancel || relayCancelled) return;
            relayCancelled = true;
            relayCancel();
        };
        const removeClientAbortListener = (): void => {
            if (!clientAbortListenerAttached) return;
            clientAbortListenerAttached = false;
            req.signal.removeEventListener("abort", cancelRequest);
        };
        const finishRequestBody = (): void => {
            removeClientAbortListener();
            bodyAbortController.abort();
        };
        const cancelRequest = (): void => {
            finishRequestBody();
            cancelRelay();
        };
        req.signal.addEventListener("abort", cancelRequest, { once: true });
        let responseStarted = false;
        let resolved = false;
        let statusCode = 502;
        let responseHeaders = new Headers();
        let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;
        let streamClosed = false;
        let shouldBuffer = false;
        let responsePaused = false;
        let bufferedBytes = 0;
        const bodyChunks: Buffer[] = [];

        const closeStream = (): void => {
            if (streamClosed) return;
            streamClosed = true;
            try {
                streamController?.close();
            } catch {
                // The client may already have disconnected or the stream may
                // have been closed by a racing response-end/error callback.
            }
        };

        const errorStream = (err: unknown): void => {
            if (streamClosed) return;
            streamClosed = true;
            try {
                streamController?.error(err instanceof Error ? err : new Error(String(err)));
            } catch {
                // Stream may already be closed or the client disconnected.
            }
        };

        const resolveOnce = (response: Response): void => {
            if (resolved) return;
            resolved = true;
            resolve(response);
        };

        const markRewriteSkippedForSize = (): void => {
            responseHeaders.set("x-pizzapi-rewrite", "skipped-size");
        };

        /**
         * Resolve with a streamed, unrewritten passthrough response. Used both
         * for responses that never needed rewriting and for ones that bailed
         * out of buffering because the body grew past TUNNEL_SYNC_REWRITE_MAX_BYTES
         * — `prefix` replays whatever was already buffered before the bail-out.
         */
        const beginUnrewrittenStream = (prefix: Buffer[]): void => {
            applyResponseHeadersByBasePath(responseHeaders, basePath, allowCrossOriginFrame);
            const stream = new ReadableStream<Uint8Array>({
                start(controller) {
                    streamController = controller;
                    for (const chunk of prefix) {
                        try {
                            controller.enqueue(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
                        } catch {
                            streamClosed = true;
                            return;
                        }
                    }
                },
                pull() {
                    // The viewer drained below the high-water mark.
                    if (!responsePaused) return;
                    responsePaused = false;
                    relay.resumeResponse(runnerId, requestId);
                },
                cancel() {
                    streamClosed = true;
                    cancelRequest();
                },
            }, {
                highWaterMark: TUNNEL_STREAM_HIGH_WATER_BYTES,
                size: (chunk) => chunk?.byteLength ?? 0,
            });

            resolveOnce(new Response(stream, {
                status: statusCode,
                headers: responseHeaders,
            }));
        };

        const { cancel } = relay.proxyHttpRequest(
            runnerId,
            {
                id: requestId,
                port,
                method: req.method.toUpperCase(),
                url: pathWithQuery,
                headers: forwardHeaders,
                // Host-based tunnels forward the app's own credentials end-to-end.
                preserveAuth: basePath === "" || undefined,
                host: tunnelHost,
                capabilityAgeMs,
            },
            {
                onResponseStart: (code, _statusMessage, headers) => {
                    responseStarted = true;
                    statusCode = code;
                    responseHeaders = new Headers();
                    for (const [key, value] of Object.entries(headers)) {
                        try {
                            if (Array.isArray(value)) {
                                // Multi-value headers (Set-Cookie) must be appended
                                // individually — joining them corrupts cookie values.
                                for (const v of value) responseHeaders.append(key, v);
                            } else {
                                responseHeaders.set(key, value);
                            }
                        } catch {
                            // Skip invalid header values rejected by the Headers API.
                        }
                    }

                    // basePath "" → host-based passthrough: the app owns the whole
                    // origin, so no HTML/JS/CSS rewriting (and no buffering) is needed.
                    shouldBuffer = basePath !== "" && shouldBufferTunnelResponse(responseHeaders.get("content-type"));
                    const contentLength = responseHeaders.get("content-length");
                    if (shouldBuffer && contentLength) {
                        const length = Number.parseInt(contentLength, 10);
                        if (Number.isFinite(length) && length > TUNNEL_MAX_BUFFERED_BYTES) {
                            cancelRequest();
                            resolveOnce(tunnelErrorResponse("Response body too large"));
                            return;
                        }
                        // Known up front to be too large to rewrite synchronously:
                        // skip buffering entirely, stream it through unrewritten.
                        if (Number.isFinite(length) && length > TUNNEL_SYNC_REWRITE_MAX_BYTES) {
                            shouldBuffer = false;
                            markRewriteSkippedForSize();
                        }
                    }
                    if (shouldBuffer) return;

                    beginUnrewrittenStream([]);
                },
                onResponseData: (chunk) => {
                    if (shouldBuffer) {
                        if (bufferedBytes + chunk.length > TUNNEL_MAX_BUFFERED_BYTES) {
                            cancelRequest();
                            resolveOnce(tunnelErrorResponse("Response body too large"));
                            return;
                        }
                        bufferedBytes += chunk.length;
                        bodyChunks.push(chunk);
                        if (bufferedBytes > TUNNEL_SYNC_REWRITE_MAX_BYTES) {
                            // Content-Length was absent or unknown up front (chunked
                            // transfer) and the body just grew past the sync-rewrite
                            // budget: stop buffering for rewrite and flush what's
                            // already queued through an unrewritten stream instead of
                            // running the regex rewrite on a multi-MB string later.
                            shouldBuffer = false;
                            markRewriteSkippedForSize();
                            beginUnrewrittenStream(bodyChunks.splice(0, bodyChunks.length));
                        }
                        return;
                    }

                    if (streamClosed || !streamController) return;
                    try {
                        streamController.enqueue(
                            new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength),
                        );
                    } catch {
                        streamClosed = true;
                        return;
                    }
                    const desired = streamController.desiredSize ?? 0;
                    const queuedBytes = TUNNEL_STREAM_HIGH_WATER_BYTES - desired;
                    if (maxStreamBufferedBytes > 0 && queuedBytes > maxStreamBufferedBytes) {
                        // Slow viewer and a producer that ignored pause (or an
                        // older runner): terminate instead of queueing without bound.
                        cancelRequest();
                        errorStream(new Error("Tunnel response buffer limit exceeded"));
                        return;
                    }
                    if (desired <= 0 && !responsePaused) {
                        responsePaused = true;
                        relay.pauseResponse(runnerId, requestId);
                    }
                },
                onResponseEnd: () => {
                    finishRequestBody();
                    if (shouldBuffer) {
                        if (!responseStarted) {
                            resolveOnce(tunnelErrorResponse("Tunnel response missing headers"));
                            return;
                        }

                        const responseBody = rewriteBufferedResponseByBasePath(
                            Buffer.concat(bodyChunks),
                            responseHeaders,
                            basePath,
                            proxyPath,
                        );
                        applyResponseHeadersByBasePath(responseHeaders, basePath, allowCrossOriginFrame);
                        resolveOnce(new Response(bufferToBodyInit(responseBody), {
                            status: statusCode,
                            headers: responseHeaders,
                        }));
                        return;
                    }

                    closeStream();
                },
                onError: (error) => {
                    cancelRequest();
                    if (!responseStarted || shouldBuffer) {
                        resolveOnce(tunnelErrorResponse(error));
                        return;
                    }

                    // The response headers are already sent — error the
                    // ReadableStream so the browser observes a failed/truncated
                    // response rather than a clean end-of-body.
                    errorStream(error);
                },
            },
        );
        relayCancel = cancel;
        if (relayCancelRequested) cancelRelay();
        if (req.signal.aborted) cancelRequest();

        void streamRequestBodyToRelay(req, relay, runnerId, requestId, bodyAbortController.signal).catch((error) => {
            cancelRequest();
            const message = error instanceof Error ? error.message : String(error);

            if (!responseStarted) {
                resolveOnce(Response.json({ error: `Failed to read tunnel request body: ${message}` }, { status: 400 }));
                return;
            }

            if (shouldBuffer) {
                resolveOnce(Response.json({ error: `Tunnel request body error: ${message}` }, { status: 502 }));
                return;
            }

            closeStream();
        });
    });
}

async function handleTunnelTokenMint(req: Request): Promise<Response> {
    if (req.method.toUpperCase() !== "POST") {
        return new Response("Method not allowed", { status: 405, headers: { Allow: "POST" } });
    }

    const identity = await requireSession(req);
    if (identity instanceof Response) return identity;

    let body: unknown;
    try {
        body = await req.json();
    } catch {
        return Response.json({ error: "Invalid JSON" }, { status: 400 });
    }

    const data = body as { sessionId?: unknown; runnerId?: unknown; port?: unknown; ttlHours?: unknown };
    const sessionId = typeof data.sessionId === "string" ? data.sessionId : "";
    const runnerId = typeof data.runnerId === "string" ? data.runnerId : "";
    const port = typeof data.port === "number" ? data.port : Number(data.port);
    const ttlHours = data.ttlHours === undefined ? undefined : Number(data.ttlHours);
    if (ttlHours !== undefined && (!Number.isFinite(ttlHours) || ttlHours < 1 || ttlHours > LABEL_MAX_TTL_HOURS)) {
        return Response.json({ error: `Invalid ttlHours (1–${LABEL_MAX_TTL_HOURS})` }, { status: 400 });
    }
    if (!sessionId && !runnerId) return Response.json({ error: "Missing session or runner ID" }, { status: 400 });
    // ttlHours applies to the signed path token too, so a caller that cannot
    // carry a cookie (phone browser, mobile webview) can hold a durable link.
    const ttlMs = ttlHours === undefined ? undefined : ttlHours * 3600 * 1000;
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        return Response.json({ error: "Invalid port" }, { status: 400 });
    }

    if (!sessionId) {
        // ponytail: runner-scoped tokens reuse the sessionId slot with a "runner:"
        // sentinel — session IDs are UUIDs, so no collision is possible.
        const runnerData = await getRunnerData(runnerId);
        if (!runnerData) return Response.json({ error: "Runner not found" }, { status: 404 });
        if (!runnerData.userId || runnerData.userId !== identity.userId) {
            return Response.json({ error: "Forbidden" }, { status: 403 });
        }
        const scoped = `runner:${runnerId}`;
        const { token, expiresAt } = createTunnelToken({ userId: identity.userId, sessionId: scoped, port, ttlMs });
        const hostTunnel = await mintTunnelLabel({ userId: identity.userId, scope: scoped, port }, ttlHours);
        return Response.json({ token, expiresAt, url: `${getAuthTunnelBasePath(token, scoped, port)}/`, ...(hostTunnel ? { hostUrl: hostTunnel.url } : {}) });
    }

    const sessionData = await getSession(sessionId);
    if (!sessionData) return Response.json({ error: "Session not found" }, { status: 404 });
    if (!sessionData.userId || sessionData.userId !== identity.userId) {
        return Response.json({ error: "Forbidden" }, { status: 403 });
    }
    if (!sessionData.runnerId) return Response.json({ error: "Session has no runner" }, { status: 503 });

    const { token, expiresAt } = createTunnelToken({ userId: identity.userId, sessionId, port, ttlMs });
    const hostTunnel = await mintTunnelLabel({ userId: identity.userId, scope: sessionId, port }, ttlHours);
    return Response.json({ token, expiresAt, url: `${getAuthTunnelBasePath(token, sessionId, port)}/`, ...(hostTunnel ? { hostUrl: hostTunnel.url } : {}) });
}

async function handleAuthTunnel(req: Request, url: URL, match: RegExpMatchArray): Promise<Response> {
    const method = req.method.toUpperCase();
    if (!["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"].includes(method)) {
        return new Response("Method not allowed", {
            status: 405,
            headers: { Allow: "GET, POST, PUT, DELETE, PATCH, HEAD, OPTIONS" },
        });
    }

    let token: string;
    let sessionId: string;
    try {
        token = decodeURIComponent(match[1]);
        sessionId = decodeURIComponent(match[2]);
    } catch {
        return Response.json({ error: "Bad tunnel token path" }, { status: 400 });
    }
    const port = parseInt(match[3], 10);
    const proxyPath = match[4] ?? "/";

    const payload = verifyTunnelToken(token);
    if (!payload || payload.sessionId !== sessionId || payload.port !== port) {
        return Response.json({ error: "Invalid or expired tunnel token" }, { status: 401 });
    }
    // Authoritative revocation check: even within the token's TTL, reject if the
    // referenced session has ended or the runner/session owner no longer matches.
    // getActiveRelaySessionUserId queries endedAt IS NULL, catching ended sessions
    // that getSession()'s Redis hash may still cache below.
    try {
        await assertTunnelTokenStillValid(payload);
    } catch {
        return Response.json({ error: "Tunnel token revoked" }, { status: 401 });
    }

    if (!sessionId) return Response.json({ error: "Missing session ID" }, { status: 400 });
    if (!Number.isFinite(port) || port < 1 || port > 65535) {
        return Response.json({ error: "Invalid port" }, { status: 400 });
    }

    let runnerId: string | null;
    if (sessionId.startsWith("runner:")) {
        // Runner-scoped token (see handleTunnelTokenMint).
        const rid = sessionId.slice("runner:".length);
        const runnerData = await getRunnerData(rid);
        if (!runnerData) return Response.json({ error: "Runner not found" }, { status: 404 });
        if (!runnerData.userId || runnerData.userId !== payload.userId) {
            return Response.json({ error: "Forbidden" }, { status: 403 });
        }
        runnerId = rid;
    } else {
        const sessionData = await getSession(sessionId);
        if (!sessionData) return Response.json({ error: "Session not found" }, { status: 404 });
        if (!sessionData.userId || sessionData.userId !== payload.userId) {
            return Response.json({ error: "Forbidden" }, { status: 403 });
        }
        runnerId = sessionData.runnerId;
    }
    if (!runnerId) return Response.json({ error: "Session has no runner" }, { status: 503 });

    const relay = getTunnelRelay();
    if (!relay?.hasRunner(runnerId)) {
        return tunnelErrorResponse(`Runner ${runnerId} not connected`);
    }

    const opaqueOrigin = isOpaqueOriginRequest(req);
    if (opaqueOrigin && method === "OPTIONS" && req.headers.has("access-control-request-method")) {
        return opaqueOriginPreflight(req);
    }

    const requestId = crypto.randomUUID();
    const res = await proxyTunnelRequestViaRelay(
        req,
        relay,
        runnerId,
        requestId,
        getAuthTunnelBasePath(token, sessionId, port),
        port,
        proxyPath,
        buildPathWithQuery(url, proxyPath),
        buildForwardHeaders(req),
        true,
        undefined,
        tunnelTokenAgeMs(payload),
    );
    return opaqueOrigin ? withOpaqueOriginCors(res) : res;
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
    if (url.pathname === "/api/tunnel-token") return handleTunnelTokenMint(req);

    const authMatch = url.pathname.match(AUTH_TUNNEL_PATH_RE);
    if (authMatch) return handleAuthTunnel(req, url, authMatch);

    // Try runner-based path first (more specific prefix avoids false matches).
    const runnerMatch = url.pathname.match(RUNNER_TUNNEL_PATH_RE);
    if (runnerMatch) return handleRunnerTunnel(req, url, runnerMatch);

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
    const sessionId = safeDecodePathComponent(match[1]);
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
        qs.delete("tunnelToken");
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

    if (isBrowserNavigation(req)) return redirectToTokenTunnel(identity.userId, sessionId, port, url, proxyPath);

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
        // Strip accept-encoding so the local service returns uncompressed
        // responses.  The tunnel serialises body chunks as JSON strings, so
        // upstream compression saves nothing.  The HTML/JS/CSS rewriter needs
        // plaintext — compressed bytes interpreted as UTF-8 produce garbled output.
        "accept-encoding",
    ]);

    // Auth headers/URLs must not be forwarded to the runner/local service.
    // The tunnel handler validates them before proxying; localhost services do not need them.
    const STRIP_AUTH = new Set(["cookie", "authorization", "x-api-key", "referer"]);

    const forwardHeaders: Record<string, string> = {};
    req.headers.forEach((v, k) => {
        const lk = k.toLowerCase();
        if (!HOP_BY_HOP.has(lk) && !STRIP_AUTH.has(lk)) forwardHeaders[k] = v;
    });

    // ── Build requestId and proxy the request ────────────────────────────────
    const requestId = crypto.randomUUID();

    const relay = getTunnelRelay();
    if (!relay?.hasRunner(runnerId)) {
        return tunnelErrorResponse(`Runner ${runnerId} not connected`);
    }

    return proxyTunnelRequestViaRelay(
        req,
        relay,
        runnerId,
        requestId,
        getTunnelBasePath(sessionId, port),
        port,
        proxyPath,
        pathWithQuery,
        forwardHeaders,
    );
};

// ── Hop-by-hop and auth header sets (shared between session and runner handlers) ──
const HOP_BY_HOP_HEADERS = new Set([
    "connection", "keep-alive", "transfer-encoding", "te", "trailer",
    "upgrade", "proxy-authorization", "proxy-authenticate",
    "host",        // Rewrite host to 127.0.0.1:{port} in the runner
    "accept-encoding",  // Strip so local service returns uncompressed
]);

const STRIP_AUTH_HEADERS = new Set(["cookie", "authorization", "x-api-key", "referer"]);

function buildForwardHeaders(req: Request, keepCredentials = false): Record<string, string> {
    const forwardHeaders: Record<string, string> = {};
    req.headers.forEach((v, k) => {
        const lk = k.toLowerCase();
        if (HOP_BY_HOP_HEADERS.has(lk)) return;
        // Path-based tunnels share the relay origin — cookies/authorization may
        // be relay credentials and must not reach the local app. Host-based
        // tunnels have a dedicated origin: those headers belong to the app.
        if (!keepCredentials && STRIP_AUTH_HEADERS.has(lk)) return;
        forwardHeaders[k] = v;
    });
    return forwardHeaders;
}

function buildPathWithQuery(url: URL, proxyPath: string): string {
    if (url.search) {
        const qs = new URLSearchParams(url.search.slice(1));
        qs.delete("apiKey");
        qs.delete("tunnelToken");
        const qsStr = qs.toString();
        return qsStr ? `${proxyPath}?${qsStr}` : proxyPath;
    }
    return proxyPath;
}

/**
 * Runner-based tunnel route handler.
 *
 * URL: /api/tunnel/runner/:runnerId/:port/*
 *
 * Resolves the runner directly (no session lookup needed). This makes tunnel
 * URLs stable across session switches — the URL survives session restarts as
 * long as the runner daemon is alive.
 */
async function handleRunnerTunnel(req: Request, url: URL, match: RegExpMatchArray): Promise<Response> {
    const method = req.method.toUpperCase();
    if (!["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"].includes(method)) {
        return new Response("Method not allowed", {
            status: 405,
            headers: { Allow: "GET, POST, PUT, DELETE, PATCH, HEAD, OPTIONS" },
        });
    }

    const identity = await requireSession(req);
    if (identity instanceof Response) return identity;

    const runnerId = safeDecodePathComponent(match[1]);
    const port = parseInt(match[2], 10);
    const proxyPath = match[3] ?? "/";

    if (!runnerId) return Response.json({ error: "Missing runner ID" }, { status: 400 });
    if (!Number.isFinite(port) || port < 1 || port > 65535) {
        return Response.json({ error: "Invalid port" }, { status: 400 });
    }

    const pathWithQuery = buildPathWithQuery(url, proxyPath);

    // Verify runner ownership — tunnels expose localhost.
    const runnerData = await getRunnerData(runnerId);
    if (!runnerData) return Response.json({ error: "Runner not found" }, { status: 404 });
    if (!runnerData.userId || runnerData.userId !== identity.userId) {
        return Response.json({ error: "Forbidden" }, { status: 403 });
    }

    if (isBrowserNavigation(req)) return redirectToTokenTunnel(identity.userId, `runner:${runnerId}`, port, url, proxyPath);

    const relay = getTunnelRelay();
    if (!relay?.hasRunner(runnerId)) {
        return tunnelErrorResponse(`Runner ${runnerId} not connected`);
    }

    const requestId = crypto.randomUUID();

    return proxyTunnelRequestViaRelay(
        req,
        relay,
        runnerId,
        requestId,
        getRunnerTunnelBasePath(runnerId, port),
        port,
        proxyPath,
        pathWithQuery,
        buildForwardHeaders(req),
    );
}

export {
    getTunnelBasePath,
    getRunnerTunnelBasePath,
    buildForwardHeaders,
    tunnelErrorResponse,
    rewriteTunnelUrl,
    rewriteTunnelHtml,
    rewriteInlineModuleScripts,
    shouldRewriteTunnelHtml,
    shouldRewriteTunnelJs,
    shouldRewriteTunnelCss,
    rewriteTunnelJsModule,
    rewriteTunnelCss,
    proxyTunnelRequestViaRelay,
};
