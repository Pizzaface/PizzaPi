/**
 * Generic iframe panel for dynamic service panels.
 *
 * Renders the service's self-hosted UI inside an iframe,
 * proxied through the tunnel system at /api/tunnel/{sessionId}/{port}/.
 *
 * Query and fragment parameters from `pizzapi://panel/...` deep links
 * are forwarded to the iframe URL so the panel can read them via
 * `location.search` and `location.hash`.
 *
 * URL resolution (web vs mobile) lives in useTunnelSrc — on mobile it mints a
 * signed token so the absolute relay URL loads inside the Capacitor webview.
 */
import { useEffect, useMemo, useState } from "react";
import { useTunnelSrc } from "@/hooks/useTunnelSrc";
import { reportError } from "@/lib/frontend-log";

interface IframeServicePanelProps {
    sessionId: string;
    port: number;
    /** Query string (without leading "?") forwarded from a deep link. */
    query?: string;
    /** Hash fragment (without leading "#") forwarded from a deep link. */
    fragment?: string;
    /** Resolved panelParams from service requires — appended as query params. */
    panelParams?: Record<string, string>;
    /** Session working directory — injected as projectDir query param. */
    cwd?: string;
}

export function IframeServicePanel({ sessionId, port, query, fragment, panelParams, cwd }: IframeServicePanelProps) {
    const { base, loading, error } = useTunnelSrc({ sessionId, port });
    // Heuristic: HTTP failures inside an iframe don't fire onError, so flag a
    // panel that never fires onLoad within a grace window as likely-broken.
    const [loadTimedOut, setLoadTimedOut] = useState(false);

    const src = useMemo(() => {
        if (!base) return null;
        let url = base;
        const params = new URLSearchParams();
        if (panelParams) {
            for (const [key, value] of Object.entries(panelParams)) params.set(key, value);
        }
        params.set("sessionId", sessionId);
        if (cwd) params.set("projectDir", cwd);
        if (query) {
            const existing = new URLSearchParams(query);
            for (const [key, value] of existing) params.set(key, value);
        }
        const qs = params.toString();
        if (qs) url = `${base}${base.includes("?") ? "&" : "?"}${qs}`;
        if (fragment) url += `#${fragment}`;
        return url;
    }, [base, sessionId, port, query, fragment, panelParams, cwd]);

    useEffect(() => {
        setLoadTimedOut(false);
        if (!src) return;
        const t = setTimeout(() => setLoadTimedOut(true), 12_000);
        return () => clearTimeout(t);
    }, [src]);

    if (error) {
        return (
            <div className="flex h-full flex-col items-center justify-center gap-1 p-4 text-center text-xs text-muted-foreground">
                <div className="text-destructive">Could not open panel (port {port})</div>
                <div className="break-all font-mono opacity-80">{error}</div>
            </div>
        );
    }

    if (!src) {
        return <div className="flex h-full items-center justify-center text-xs text-muted-foreground">Opening panel…</div>;
    }

    return (
        <div className="relative h-full w-full">
            <iframe
                src={src}
                className="h-full w-full border-0"
                title={`Service panel — port ${port}`}
                // SECURITY: allow-same-origin is needed because tunnel content is same-origin. TODO: serve tunnel content from a separate origin to enable full sandbox isolation.
                sandbox="allow-scripts allow-forms allow-same-origin allow-popups"
                onLoad={() => setLoadTimedOut(false)}
                onError={() => reportError("tunnel", `Panel failed to load (port ${port})`, { detail: src, toast: false })}
            />
            {loadTimedOut && (
                <div className="absolute inset-x-0 bottom-0 flex items-center justify-between gap-2 bg-destructive/10 px-3 py-1.5 text-[11px] text-muted-foreground">
                    <span>Panel is taking a while — the service on port {port} may not be running.</span>
                    <a href={src} target="_blank" rel="noopener noreferrer" className="shrink-0 underline">Open directly</a>
                </div>
            )}
        </div>
    );
}
