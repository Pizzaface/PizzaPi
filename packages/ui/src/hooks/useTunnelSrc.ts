/**
 * Resolve the iframe base URL for a tunnelled port, on both web and mobile.
 *
 * Web (same-origin): a relative `/api/tunnel/...` path works directly.
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

/**
 * One-shot variant of useTunnelSrc for event handlers (e.g. "open in new tab").
 * Web: returns the same-origin relative path. Mobile: mints a signed tunnel
 * token and returns the absolute relay URL. Mints runner-scoped when only
 * runnerId is given, session-scoped otherwise.
 */
export async function resolveTunnelHref(
    opts: { sessionId?: string; runnerId?: string; port: number },
    signal?: AbortSignal,
): Promise<string> {
    const { sessionId, runnerId, port } = opts;
    const { isMobileBundled, apiKey } = getMobileRuntimeConfig();

    if (!isMobileBundled) {
        return runnerId
            ? `/api/tunnel/runner/${encodeURIComponent(runnerId)}/${port}/`
            : `/api/tunnel/${encodeURIComponent(sessionId ?? "")}/${port}/`;
    }

    const res = await fetch(resolveMobileUrl("/api/tunnel-token"), {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(apiKey ? { "x-api-key": apiKey } : {}) },
        body: JSON.stringify(sessionId ? { sessionId, port } : { runnerId, port }),
        signal,
    });
    if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`HTTP ${res.status}${body ? ` — ${body.slice(0, 200)}` : ""}`);
    }
    const data = (await res.json()) as { url?: string };
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
}): UseTunnelSrcResult {
    const { sessionId, port, runnerId, enabled = true } = opts;
    const { isMobileBundled, apiKey } = getMobileRuntimeConfig();

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

        // Web: relative path is same-origin and works as-is.
        if (!isMobileBundled) {
            const rel = runnerId
                ? `/api/tunnel/runner/${encodeURIComponent(runnerId)}/${port}/`
                : `/api/tunnel/${encodeURIComponent(sessionId)}/${port}/`;
            setBase(rel);
            setLoading(false);
            setError(null);
            return;
        }

        // Mobile: mint a signed token and load the absolute relay URL.
        const controller = new AbortController();
        setBase(null);
        setError(null);
        setLoading(true);
        // Forward runnerId so runner-scoped tunnels mint runner-scoped tokens
        // (resolveTunnelHref prefers runner-scoped when runnerId is set).
        resolveTunnelHref({ sessionId, runnerId, port }, controller.signal)
            .then((href) => {
                setBase(href);
                setLoading(false);
            })
            .catch((err: unknown) => {
                if (controller.signal.aborted) return;
                const message = err instanceof Error ? err.message : String(err);
                setError(message);
                setLoading(false);
                reportError("tunnel", `Could not open port ${port}`, {
                    detail: `${runnerId ? `runner ${runnerId}` : `session ${sessionId}`} · ${message}`,
                });
            });
        return () => controller.abort();
    }, [enabled, isMobileBundled, apiKey, sessionId, port, runnerId]);

    return { base, loading, error };
}
