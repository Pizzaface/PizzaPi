/**
 * Generic iframe panel for dynamic service panels.
 *
 * Renders the service's self-hosted UI inside an iframe,
 * proxied through the tunnel system at /api/tunnel/{sessionId}/{port}/.
 */

interface IframeServicePanelProps {
    sessionId: string;
    port: number;
}

export function IframeServicePanel({ sessionId, port }: IframeServicePanelProps) {
    return (
        <iframe
            src={`/api/tunnel/${sessionId}/${port}/`}
            className="w-full h-full border-0"
            title={`Service panel — port ${port}`}
            // SECURITY: allow-same-origin is needed because tunnel content is same-origin. TODO: serve tunnel content from a separate origin to enable full sandbox isolation.
            sandbox="allow-scripts allow-forms allow-same-origin allow-popups"
        />
    );
}
