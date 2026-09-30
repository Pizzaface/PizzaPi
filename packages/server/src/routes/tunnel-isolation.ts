/**
 * Isolation hardening for PATH-PREFIX tunnels (`/api/tunnel/...`).
 *
 * Path-prefix tunnels serve the tunneled app from the relay's own origin, so
 * the web UI must frame them with `allow-same-origin` (cookie auth + module
 * scripts need it) — which means tunneled content runs same-origin with the
 * PizzaPi UI. The real fix is PIZZAPI_TUNNEL_DOMAIN (a dedicated origin per
 * tunnel, see tunnel-host.ts). This module tightens what can be tightened
 * without breaking the path-prefix mode:
 *
 *  1. Fetch-Metadata gate — cookie-authenticated path tunnels are only ever
 *     loaded by the PizzaPi UI itself (same-origin). A cross-site entry
 *     (a host-tunnel page navigating its frame / opening a popup onto
 *     `https://relay/api/tunnel/...`) would land attacker-influenced content
 *     in the relay origin, so it is refused.
 *  2. Response header scoping — a tunneled app must not be able to plant
 *     relay-wide state through response headers: Set-Cookie is pinned to the
 *     tunnel's own path (no Domain, no `__Host-`, no relay auth-cookie names),
 *     and `Service-Worker-Allowed` / `Clear-Site-Data` are dropped (a
 *     root-scoped service worker would persist and intercept the whole UI).
 *
 * None of this makes same-origin tunnel content safe to run — same-origin
 * script can still act as the user. It only narrows cross-site entry and
 * header-borne persistence. Host-based tunnels are unaffected.
 */

/** Relay auth cookie name prefixes (better-auth default prefix). */
const RELAY_AUTH_COOKIE_PREFIXES = ["better-auth.", "__secure-better-auth.", "__host-better-auth."];

/** Response headers a path-prefix tunneled app may never set on the relay origin. */
const RELAY_SCOPED_RESPONSE_HEADERS = ["service-worker-allowed", "clear-site-data"];

function originOf(value: string | null): string | null {
    if (!value) return null;
    try {
        const origin = new URL(value).origin;
        return origin === "null" ? null : origin;
    } catch {
        return null;
    }
}

/**
 * Reject browser requests that enter a cookie-authenticated path tunnel from
 * another site. Returns a 403 Response to reject, or null to continue.
 *
 * - No Cookie header → nothing ambient to ride (API key / scripts) — allow.
 * - `Sec-Fetch-Site: cross-site` → reject.
 * - `Sec-Fetch-Site: same-site` → allow only when Origin/Referer names a
 *   trusted relay origin (e.g. a UI served on a sibling port/subdomain);
 *   `*.localhost` host tunnels are same-site with `localhost`, so this is
 *   what stops them in local dev.
 * - `same-origin`, `none` (typed URL / bookmark) or absent (older browsers,
 *   non-browser clients) → allow.
 */
export function rejectCrossSiteTunnelRequest(
    req: Request,
    trustedOrigins: string[] | (() => string[]),
): Response | null {
    if (!req.headers.get("cookie")) return null;
    const site = req.headers.get("sec-fetch-site")?.toLowerCase();
    if (!site || site === "same-origin" || site === "none") return null;

    if (site === "same-site") {
        const initiator = originOf(req.headers.get("origin")) ?? originOf(req.headers.get("referer"));
        const trusted = typeof trustedOrigins === "function" ? trustedOrigins() : trustedOrigins;
        if (initiator && trusted.includes(initiator)) return null;
    }

    return Response.json(
        {
            error: "Cross-site access to a same-origin tunnel is blocked. "
                + "Open the tunnel from the PizzaPi UI, or configure PIZZAPI_TUNNEL_DOMAIN for isolated tunnel origins.",
        },
        { status: 403 },
    );
}

/**
 * Rewrite one Set-Cookie value from a path-prefix tunneled app so it can only
 * ever apply to that tunnel's path on the relay origin. Returns null when the
 * cookie must be dropped entirely.
 */
export function scopePathTunnelSetCookie(cookie: string, basePath: string): string | null {
    const parts = cookie.split(";");
    const nameValue = parts[0] ?? "";
    const eq = nameValue.indexOf("=");
    const name = (eq >= 0 ? nameValue.slice(0, eq) : nameValue).trim();
    if (!name) return null;

    const lowerName = name.toLowerCase();
    // __Host- cookies require Path=/ — they can't be scoped, and would
    // otherwise be relay-wide.
    if (lowerName.startsWith("__host-")) return null;
    // Never let a tunneled app shadow / fixate the relay's own session cookie.
    if (RELAY_AUTH_COOKIE_PREFIXES.some((p) => lowerName.startsWith(p))) return null;

    const attrs = parts
        .slice(1)
        .map((a) => a.trim())
        .filter((a) => {
            if (!a) return false;
            const key = a.split("=")[0]!.trim().toLowerCase();
            return key !== "domain" && key !== "path";
        });
    // RFC 6265 path-match: "/api/tunnel/s/3000" matches ".../3000" and
    // ".../3000/x" but not ".../30001" — no trailing slash needed.
    const path = basePath.replace(/\/+$/, "") || "/";
    return [nameValue.trim(), ...attrs, `Path=${path}`].join("; ");
}

/**
 * Apply path-prefix isolation rules to a tunneled response's headers in place.
 * Only call for path-prefix tunnels (non-empty basePath).
 */
export function hardenPathTunnelResponseHeaders(headers: Headers, basePath: string): void {
    for (const name of RELAY_SCOPED_RESPONSE_HEADERS) headers.delete(name);

    const setCookies = headers.getSetCookie?.() ?? [];
    if (setCookies.length === 0) return;
    headers.delete("set-cookie");
    for (const cookie of setCookies) {
        const scoped = scopePathTunnelSetCookie(cookie, basePath);
        if (scoped) headers.append("set-cookie", scoped);
    }
}
