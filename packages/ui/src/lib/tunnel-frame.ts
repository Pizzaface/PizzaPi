/**
 * Pure helpers for framing tunneled content (TunnelPanel previews and
 * IframeServicePanel service panels).
 *
 * Isolation model
 * ───────────────
 * The iframe `sandbox` keeps `allow-same-origin` in both modes — tunneled dev
 * servers need it (Vite module scripts are CORS fetches that fail from an
 * opaque `null` origin; apps use cookies/localStorage). What that token
 * *means* depends on where the frame is loaded from:
 *
 *  - Dedicated tunnel origin (relay has PIZZAPI_TUNNEL_DOMAIN, frame src is
 *    `https://<label>.<domain>/`): `allow-same-origin` grants the tunnel its
 *    OWN origin. It cannot touch the PizzaPi UI's DOM, localStorage or
 *    cookies — the browser's same-origin policy isolates it. → isolated.
 *  - Path-prefix fallback (`/api/tunnel/...` on the relay origin): the frame
 *    is same-origin with the UI, so tunneled script can act as the user.
 *    → NOT isolated; the UI surfaces a warning.
 */

/** Sandbox tokens for every tunnel iframe (see module doc for why same-origin stays). */
export const TUNNEL_IFRAME_SANDBOX = "allow-scripts allow-forms allow-same-origin allow-popups";

export interface TunnelFrameInfo {
    sandbox: string;
    /** True when the frame is served from an origin other than the PizzaPi UI's. */
    isolated: boolean;
}

/** Origin of `src` resolved against `appOrigin`, or null when unparseable / non-http(s). */
function resolvedOrigin(src: string, appOrigin: string): string | null {
    try {
        const u = new URL(src, appOrigin);
        if (u.protocol !== "http:" && u.protocol !== "https:") return null;
        return u.origin;
    } catch {
        return null;
    }
}

/** Describe how a tunnel iframe with this src must be sandboxed and whether it is isolated. */
export function describeTunnelFrame(src: string, appOrigin: string): TunnelFrameInfo {
    const origin = resolvedOrigin(src, appOrigin);
    return { sandbox: TUNNEL_IFRAME_SANDBOX, isolated: origin !== null && origin !== appOrigin };
}

function isLocalhostName(hostname: string): boolean {
    return hostname === "localhost" || hostname.endsWith(".localhost");
}

/**
 * Whether a dedicated-origin tunnel URL (`hostUrl` from /api/tunnel-token) can
 * actually load from where the UI is running. Falls back to the path-prefix
 * URL otherwise, so misconfigured/unreachable tunnel domains never blank a panel.
 *
 * - Mobile (Capacitor): must be https and not *.localhost (that resolves to the
 *   phone itself).
 * - Web: *.localhost only works when the UI itself is on localhost (same
 *   machine), and an https UI cannot frame an http tunnel (mixed content).
 */
export function isUsableHostTunnelUrl(hostUrl: string, ctx: { appUrl: string; mobile: boolean }): boolean {
    let u: URL;
    try {
        u = new URL(hostUrl);
    } catch {
        return false;
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    if (ctx.mobile) return u.protocol === "https:" && !isLocalhostName(u.hostname);

    let app: URL;
    try {
        app = new URL(ctx.appUrl);
    } catch {
        return true;
    }
    if (isLocalhostName(u.hostname) && !isLocalhostName(app.hostname)) return false;
    if (app.protocol === "https:" && u.protocol === "http:") return false;
    return true;
}

// ── Host-origin URL cache ─────────────────────────────────────────────────────
//
// Every /api/tunnel-token call mints a fresh opaque label, i.e. a NEW origin.
// Re-using the minted URL for the life of the page keeps a panel's origin (and
// so its localStorage/cookies) stable across remounts and avoids a round-trip
// per mount. Once the relay reports that host tunnels are unavailable (no
// hostUrl in a successful mint), panels skip the probe for a while and load
// the synchronous path-prefix URL directly.

/** Well under the relay's 6h idle / 24h absolute label lifetime. */
export const HOST_URL_CACHE_TTL_MS = 30 * 60 * 1000;
/** How long "relay has no PIZZAPI_TUNNEL_DOMAIN" is remembered. */
export const HOST_UNAVAILABLE_TTL_MS = 5 * 60 * 1000;

const hostUrlCache = new Map<string, { url: string; expiresAt: number }>();
let hostUnavailableUntil = 0;

export function tunnelCacheKey(opts: { sessionId?: string; runnerId?: string; port: number }): string {
    return opts.runnerId ? `runner:${opts.runnerId}:${opts.port}` : `session:${opts.sessionId ?? ""}:${opts.port}`;
}

export function getCachedHostTunnelUrl(key: string, now = Date.now()): string | null {
    const hit = hostUrlCache.get(key);
    if (!hit) return null;
    if (hit.expiresAt <= now) {
        hostUrlCache.delete(key);
        return null;
    }
    return hit.url;
}

export function cacheHostTunnelUrl(key: string, url: string, now = Date.now()): void {
    hostUrlCache.set(key, { url, expiresAt: now + HOST_URL_CACHE_TTL_MS });
    hostUnavailableUntil = 0;
}

export function markHostTunnelsUnavailable(now = Date.now()): void {
    hostUnavailableUntil = now + HOST_UNAVAILABLE_TTL_MS;
}

export function hostTunnelsKnownUnavailable(now = Date.now()): boolean {
    return now < hostUnavailableUntil;
}

/** Test hook. */
export function _resetHostTunnelCache(): void {
    hostUrlCache.clear();
    hostUnavailableUntil = 0;
}
