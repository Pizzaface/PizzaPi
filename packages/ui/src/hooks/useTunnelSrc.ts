/**
 * Resolve the URL for a tunnelled port (service panel or app preview), on both
 * web and mobile, with origin isolation as a hard requirement.
 *
 * Tunnelled content is runner-controlled. It must never execute as the
 * PizzaPi relay origin, where it could drive the signed-in UI and its API. So
 * every resolution mints via POST /api/tunnel-token and returns one of:
 *
 *   - `isolated: true`  — the dedicated tunnel origin (`hostUrl`, from
 *     PIZZAPI_TUNNEL_DOMAIN). A separate origin, so the iframe may keep
 *     `allow-same-origin` (persistent storage/cookies for the app).
 *   - `isolated: false` — the signed `/api/tunnel/auth/<token>/…` path on the
 *     relay. The relay serves it with a CSP `sandbox` (opaque origin) and the
 *     iframe must NOT add `allow-same-origin`. Auth rides in the path, so the
 *     sandboxed document's cookie-less subresource requests still work.
 *
 * There is deliberately no fallback to the cookie-authenticated relative
 * `/api/tunnel/...` path: if minting fails the caller shows an error.
 *
 * Mobile (Capacitor) additionally needs the absolute relay URL because the UI
 * is served from https://localhost.
 */
import { useEffect, useState } from "react";
import { getMobileRuntimeConfig, resolveMobileUrl } from "@/lib/mobile-runtime";
import { reportError } from "@/lib/frontend-log";

/**
 * Lifetime requested for embedded/opened tunnel URLs. Path tokens otherwise
 * default to 1 h, after which a long-open panel's XHR/asset requests would
 * start failing. Matches the relay's default absolute label lifetime.
 */
export const TUNNEL_EMBED_TTL_HOURS = 24;

/** iframe sandbox for an isolated tunnel origin (separate site — same-origin is safe). */
export const ISOLATED_TUNNEL_IFRAME_SANDBOX = "allow-scripts allow-forms allow-same-origin allow-popups";
/** iframe sandbox for relay-origin path tunnels: scripts without same-origin privileges. */
export const RELAY_PATH_TUNNEL_IFRAME_SANDBOX = "allow-scripts allow-forms allow-popups";

export function tunnelIframeSandbox(isolated: boolean): string {
    return isolated ? ISOLATED_TUNNEL_IFRAME_SANDBOX : RELAY_PATH_TUNNEL_IFRAME_SANDBOX;
}

export interface ResolvedTunnelTarget {
    href: string;
    /** True only for the dedicated tunnel origin (never the relay origin). */
    isolated: boolean;
}

/**
 * Mint and resolve a tunnel URL. Mints runner-scoped whenever a runnerId is
 * given (stable across session switches), session-scoped otherwise.
 */
export async function resolveTunnelTarget(
    opts: { sessionId?: string; runnerId?: string; port: number },
    signal?: AbortSignal,
): Promise<ResolvedTunnelTarget> {
    const { sessionId, runnerId, port } = opts;
    const { isMobileBundled, apiKey } = getMobileRuntimeConfig();

    const res = await fetch(resolveMobileUrl("/api/tunnel-token"), {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(apiKey ? { "x-api-key": apiKey } : {}) },
        body: JSON.stringify({ ...(runnerId ? { runnerId } : { sessionId }), port, ttlHours: TUNNEL_EMBED_TTL_HOURS }),
        signal,
    });
    if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`HTTP ${res.status}${body ? ` — ${body.slice(0, 200)}` : ""}`);
    }
    const data = (await res.json()) as { url?: unknown; hostUrl?: unknown };

    if (typeof data.hostUrl === "string" && isReachableHostUrl(data.hostUrl, isMobileBundled)) {
        return { href: data.hostUrl, isolated: true };
    }
    if (typeof data.url !== "string" || !data.url.startsWith("/api/tunnel/auth/")) {
        throw new Error("token response missing a signed tunnel url");
    }
    return { href: resolveMobileUrl(data.url), isolated: false };
}

/** One-shot href for event handlers (e.g. "open in new tab"). */
export async function resolveTunnelHref(
    opts: { sessionId?: string; runnerId?: string; port: number },
    signal?: AbortSignal,
): Promise<string> {
    return (await resolveTunnelTarget(opts, signal)).href;
}

/**
 * "Open in new tab" for a tunnel URL that still has to be minted. Call it
 * synchronously from the click handler.
 *
 * Browsers only allow popups during user activation, which an awaited network
 * request can outlive, so opening only after the mint would get the tab
 * blocked. Instead a blank placeholder tab is opened immediately (with its
 * opener severed) and navigated once the signed URL arrives, or closed if
 * minting fails. Without a placeholder (popup blocked, or the bundled mobile
 * app, whose webview hands new windows to the system browser) the minted URL
 * is opened directly as before.
 */
export function openTunnelInNewTab(
    opts: { sessionId?: string; runnerId?: string; port: number },
    onError: (err: unknown) => void,
): void {
    let placeholder: Window | null = null;
    if (!getMobileRuntimeConfig().isMobileBundled) {
        try {
            placeholder = window.open("about:blank", "_blank");
        } catch {
            placeholder = null;
        }
        if (placeholder) {
            try {
                placeholder.opener = null;
            } catch {
                /* best effort */
            }
        }
    }
    void resolveTunnelHref(opts).then(
        (url) => {
            if (!placeholder) {
                window.open(url, "_blank", "noopener,noreferrer");
                return;
            }
            // The viewer closed the placeholder while waiting: respect that.
            if (placeholder.closed) return;
            placeholder.location.replace(url);
        },
        (err: unknown) => {
            try {
                placeholder?.close();
            } catch {
                /* already gone */
            }
            onError(err);
        },
    );
}

/**
 * Whether this viewer can plausibly load the tunnel origin. Mobile: https and
 * not *.localhost (which resolves to the phone itself). Web: no mixed content,
 * and a *.localhost tunnel domain only when the UI itself is on localhost
 * (a LAN/tailnet viewer would resolve it to their own machine).
 */
export function isReachableHostUrl(hostUrl: string, isMobileBundled: boolean): boolean {
    let u: URL;
    try {
        u = new URL(hostUrl);
    } catch {
        return false;
    }
    if (u.protocol !== "https:" && u.protocol !== "http:") return false;
    const isLocalhost = (h: string) => h === "localhost" || h.endsWith(".localhost");
    if (isMobileBundled) return u.protocol === "https:" && !isLocalhost(u.hostname);
    const page = typeof window !== "undefined" ? window.location : undefined;
    if (!page) return true;
    if (page.protocol === "https:" && u.protocol !== "https:") return false;
    if (isLocalhost(u.hostname) && !isLocalhost(page.hostname) && page.hostname !== "127.0.0.1") return false;
    return true;
}

export interface UseTunnelSrcResult {
    /** Base iframe URL (no query/fragment), or null while loading / on error / when disabled. */
    base: string | null;
    /** Whether `base` is the isolated tunnel origin (controls the iframe sandbox). */
    isolated: boolean;
    loading: boolean;
    error: string | null;
}

export function useTunnelSrc(opts: {
    sessionId: string;
    port: number | null;
    runnerId?: string;
    /** Set false to skip resolution (e.g. no active preview). */
    enabled?: boolean;
    /**
     * Change to mint a fresh URL for the same target. A minted URL is bound to
     * the port's exposure that was current when it was minted and expires
     * (TUNNEL_EMBED_TTL_HOURS), so Reload, and a re-exposure of the previewed
     * port, must remint rather than reload the old URL.
     */
    refreshKey?: number;
}): UseTunnelSrcResult {
    const { sessionId, port, runnerId, enabled = true, refreshKey = 0 } = opts;
    const { apiKey } = getMobileRuntimeConfig();
    // Runner-scoped URLs do not depend on the active/service session. Keeping
    // the session out of the effect identity prevents a same-URL iframe reload
    // when a runner-pinned panel travels to another session.
    const routingSessionId = runnerId ? undefined : sessionId;

    const [target, setTarget] = useState<ResolvedTunnelTarget | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (!enabled || port == null) {
            setTarget(null);
            setLoading(false);
            setError(null);
            return;
        }

        const controller = new AbortController();
        setTarget(null);
        setError(null);
        setLoading(true);
        resolveTunnelTarget({ sessionId: routingSessionId, runnerId, port }, controller.signal)
            .then((resolved) => {
                if (controller.signal.aborted) return;
                setTarget(resolved);
                setLoading(false);
            })
            .catch((err: unknown) => {
                if (controller.signal.aborted) return;
                // Fail closed: never fall back to a relay-origin cookie path.
                const message = err instanceof Error ? err.message : String(err);
                setError(message);
                setLoading(false);
                reportError("tunnel", `Could not open port ${port}`, {
                    detail: `${runnerId ? `runner ${runnerId}` : `session ${sessionId}`} · ${message}`,
                });
            });
        return () => controller.abort();
    }, [enabled, apiKey, routingSessionId, port, runnerId, refreshKey]);

    return { base: target?.href ?? null, isolated: target?.isolated ?? false, loading, error };
}
