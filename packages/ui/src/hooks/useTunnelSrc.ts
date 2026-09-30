/**
 * Resolve the iframe base URL for a tunnelled port, on both web and mobile.
 *
 * Web: with `preferHostOrigin` and a relay that has PIZZAPI_TUNNEL_DOMAIN, the
 * minted dedicated tunnel origin (`hostUrl`) is used — tunneled content is then
 * origin-isolated from the UI (see lib/tunnel-frame.ts). Otherwise a relative
 * same-origin `/api/tunnel/...` path works directly.
 *
 * Mobile (Capacitor): the UI is served from https://localhost, so a relative
 * path would resolve against the local bundle (blank iframe / 404) and an
 * iframe cannot attach the `x-api-key` header. Instead we mint a short-lived
 * signed tunnel token via POST /api/tunnel-token and load the absolute
 * `<relay>/api/tunnel/auth/<token>/...` URL, which carries auth in the path.
 *
 * This was the root cause of "service panels / tunnels are blank in the mobile
 * app": TunnelPanel built a relative src that never reached the relay.
 */
import { useEffect, useState } from "react";
import { getMobileRuntimeConfig, resolveMobileUrl } from "@/lib/mobile-runtime";
import { reportError } from "@/lib/frontend-log";
import {
    cacheHostTunnelUrl,
    getCachedHostTunnelUrl,
    hostTunnelsKnownUnavailable,
    isUsableHostTunnelUrl,
    markHostTunnelsUnavailable,
    tunnelCacheKey,
} from "@/lib/tunnel-frame";

function currentAppUrl(): string {
    try {
        return window.location.href;
    } catch {
        return "";
    }
}

/**
 * One-shot variant of useTunnelSrc for event handlers (e.g. "open in new tab").
 * Web: returns the same-origin relative path. Mobile: mints a signed tunnel
 * token and returns the absolute relay URL. Mints runner-scoped whenever a
 * runnerId is given (stable across session switches), session-scoped otherwise.
 */
export async function resolveTunnelHref(
    opts: { sessionId?: string; runnerId?: string; port: number; preferHostOrigin?: boolean },
    signal?: AbortSignal,
): Promise<string> {
    const { sessionId, runnerId, port, preferHostOrigin = false } = opts;
    const { isMobileBundled, apiKey } = getMobileRuntimeConfig();

    const relativeFallback = runnerId
        ? `/api/tunnel/runner/${encodeURIComponent(runnerId)}/${port}/`
        : `/api/tunnel/${encodeURIComponent(sessionId ?? "")}/${port}/`;

    const mint = async (): Promise<{ url?: string; hostUrl?: string }> => {
        const res = await fetch(resolveMobileUrl("/api/tunnel-token"), {
            method: "POST",
            headers: { "Content-Type": "application/json", ...(apiKey ? { "x-api-key": apiKey } : {}) },
            body: JSON.stringify(runnerId ? { runnerId, port } : { sessionId, port }),
            signal,
        });
        if (!res.ok) {
            const body = await res.text().catch(() => "");
            throw new Error(`HTTP ${res.status}${body ? ` — ${body.slice(0, 200)}` : ""}`);
        }
        return (await res.json()) as { url?: string; hostUrl?: string };
    };

    const cacheKey = tunnelCacheKey({ sessionId, runnerId, port });
    if (preferHostOrigin) {
        const cached = getCachedHostTunnelUrl(cacheKey);
        if (cached) return cached;
    }

    if (!isMobileBundled) {
        // Web: prefer the dedicated tunnel origin (hostUrl) when the relay has
        // PIZZAPI_TUNNEL_DOMAIN configured — tunneled content then runs in its
        // own origin, isolated from the PizzaPi UI (and SPAs get a clean
        // location.pathname). Otherwise use the same-origin path prefix.
        if (preferHostOrigin && !hostTunnelsKnownUnavailable()) {
            try {
                const data = await mint();
                if (data.hostUrl && isUsableHostTunnelUrl(data.hostUrl, { appUrl: currentAppUrl(), mobile: false })) {
                    cacheHostTunnelUrl(cacheKey, data.hostUrl);
                    return data.hostUrl;
                }
                // Not configured on the relay, or unreachable from here
                // (e.g. *.localhost while browsing from another machine).
                markHostTunnelsUnavailable();
            } catch {
                // fall through to relative path
            }
        }
        return relativeFallback;
    }

    const data = await mint();
    // Mobile: use the tunnel origin only when it can plausibly work off-machine
    // — https and not *.localhost (which resolves to the phone itself).
    // Everything else keeps the signed relay URL, which is always reachable.
    if (preferHostOrigin && data.hostUrl && isUsableHostTunnelUrl(data.hostUrl, { appUrl: currentAppUrl(), mobile: true })) {
        cacheHostTunnelUrl(cacheKey, data.hostUrl);
        return data.hostUrl;
    }
    if (!data.url) throw new Error("token response missing url");
    return resolveMobileUrl(data.url);
}

export interface UseTunnelSrcResult {
    /** Base iframe URL (no query/fragment), or null while loading / on error / when disabled. */
    base: string | null;
    loading: boolean;
    error: string | null;
}

export function useTunnelSrc(opts: {
    sessionId: string;
    port: number | null;
    runnerId?: string;
    /** Set false to skip resolution (e.g. no active preview). */
    enabled?: boolean;
    /** Prefer the dedicated, isolated tunnel origin (PIZZAPI_TUNNEL_DOMAIN) when the relay offers one. */
    preferHostOrigin?: boolean;
}): UseTunnelSrcResult {
    const { sessionId, port, runnerId, enabled = true, preferHostOrigin = false } = opts;
    const { isMobileBundled, apiKey } = getMobileRuntimeConfig();
    // Runner-scoped URLs do not depend on the active/service session. Keeping
    // the session out of the effect identity prevents a same-URL iframe reload
    // when a runner-pinned panel travels to another session.
    const routingSessionId = runnerId ? undefined : sessionId;

    const [base, setBase] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (!enabled || port == null) {
            setBase(null);
            setLoading(false);
            setError(null);
            return;
        }

        // Web, dedicated tunnel origin already minted for this port: reuse it
        // synchronously (stable origin across remounts).
        const cachedHost = preferHostOrigin
            ? getCachedHostTunnelUrl(tunnelCacheKey({ sessionId: routingSessionId, runnerId, port }))
            : null;
        if (!isMobileBundled && cachedHost) {
            setBase(cachedHost);
            setLoading(false);
            setError(null);
            return;
        }

        // Web without a usable host origin: relative path, synchronously.
        if (!isMobileBundled && (!preferHostOrigin || hostTunnelsKnownUnavailable())) {
            setBase(runnerId
                ? `/api/tunnel/runner/${encodeURIComponent(runnerId)}/${port}/`
                : `/api/tunnel/${encodeURIComponent(routingSessionId ?? "")}/${port}/`);
            setLoading(false);
            setError(null);
            return;
        }

        const controller = new AbortController();
        setBase(null);
        setError(null);
        setLoading(true);
        // Forward runnerId so runner-scoped tunnels mint runner-scoped tokens
        // (resolveTunnelHref prefers runner-scoped when runnerId is set).
        resolveTunnelHref({ sessionId: routingSessionId, runnerId, port, preferHostOrigin }, controller.signal)
            .then((href) => {
                setBase(href);
                setLoading(false);
            })
            .catch((err: unknown) => {
                if (controller.signal.aborted) return;
                const message = err instanceof Error ? err.message : String(err);
                if (!isMobileBundled) {
                    // Web never hard-fails — resolveTunnelHref already falls back
                    // internally, so an error here is unexpected; use the fallback.
                    setBase(runnerId
                        ? `/api/tunnel/runner/${encodeURIComponent(runnerId)}/${port}/`
                        : `/api/tunnel/${encodeURIComponent(routingSessionId ?? "")}/${port}/`);
                    setLoading(false);
                    return;
                }
                setError(message);
                setLoading(false);
                reportError("tunnel", `Could not open port ${port}`, {
                    detail: `${runnerId ? `runner ${runnerId}` : `session ${sessionId}`} · ${message}`,
                });
            });
        return () => controller.abort();
    }, [enabled, isMobileBundled, apiKey, routingSessionId, port, runnerId, preferHostOrigin]);

    return { base, loading, error };
}
