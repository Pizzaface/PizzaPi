/**
 * Generic iframe panel for dynamic service panels.
 *
 * Renders the service's self-hosted UI inside an iframe,
 * proxied through the tunnel system at /api/tunnel/{sessionId}/{port}/.
 *
 * Query and fragment parameters from `pizzapi://panel/...` deep links
 * are forwarded to the iframe URL so the panel can read them via
 * `location.search` and `location.hash`.
 */
import { useMemo } from "react";

interface IframeServicePanelProps {
    sessionId: string;
    port: number;
    /** Query string (without leading "?") forwarded from a deep link. */
    query?: string;
    /** Hash fragment (without leading "#") forwarded from a deep link. */
    fragment?: string;
    /** Resolved panelParams from service requires — appended as query params. */
    panelParams?: Record<string, string>;
}

export function IframeServicePanel({ sessionId, port, query, fragment, panelParams }: IframeServicePanelProps) {
    const src = useMemo(() => {
        let url = `/api/tunnel/${sessionId}/${port}/`;
        const params = new URLSearchParams();
        // Daemon-resolved panelParams first (HOME, USER, etc.)
        if (panelParams) {
            for (const [key, value] of Object.entries(panelParams)) {
                params.set(key, value);
            }
        }
        // Always include sessionId — UI has it, takes precedence over daemon-resolved
        params.set("sessionId", sessionId);
        // Then existing query params from deep link (takes precedence)
        if (query) {
            const existing = new URLSearchParams(query);
            for (const [key, value] of existing) {
                params.set(key, value);
            }
        }
        const qs = params.toString();
        if (qs) url += `?${qs}`;
        if (fragment) url += `#${fragment}`;
        return url;
    }, [sessionId, port, query, fragment, panelParams]);

    return (
        <iframe
            src={src}
            className="w-full h-full border-0"
            title={`Service panel — port ${port}`}
            // SECURITY: allow-same-origin is needed because tunnel content is same-origin. TODO: serve tunnel content from a separate origin to enable full sandbox isolation.
            sandbox="allow-scripts allow-forms allow-same-origin allow-popups"
        />
    );
}
