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
}

export function IframeServicePanel({ sessionId, port, query, fragment }: IframeServicePanelProps) {
    const src = useMemo(() => {
        let url = `/api/tunnel/${sessionId}/${port}/`;
        if (query) url += `?${query}`;
        if (fragment) url += `#${fragment}`;
        return url;
    }, [sessionId, port, query, fragment]);

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
