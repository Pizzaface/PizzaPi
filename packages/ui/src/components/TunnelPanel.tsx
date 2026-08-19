import { useState, useEffect, useCallback, useRef } from "react";
import { useServiceChannel } from "@/hooks/useServiceChannel";
import { useTunnelSrc } from "@/hooks/useTunnelSrc";
import { reportError } from "@/lib/frontend-log";
import { ExternalLink, Plus, X, RefreshCw, Loader2, PanelRightOpen } from "lucide-react";
import { parsePanelId, makePanelId } from "@/components/service-panels/panel-instance";
import type { ServicePanelProps } from "@/components/service-panels/registry";

interface TunnelInfo {
    port: number;
    name?: string;
    url: string;
    pinned?: boolean;
}

export function TunnelPanel({ sessionId, runnerId, panelId, onSpawnPanel }: ServicePanelProps) {
    // `tunnel#3000` → this panel is a detached single-tunnel view: no tab strip,
    // no expose form, just that one port's preview.
    const detachedPort = (() => {
        const raw = panelId ? parsePanelId(panelId).instance : undefined;
        const n = raw ? parseInt(raw, 10) : NaN;
        return Number.isFinite(n) ? n : null;
    })();

    const [tunnels, setTunnels] = useState<TunnelInfo[]>([]);
    const [portInput, setPortInput] = useState("");
    const [nameInput, setNameInput] = useState("");
    /** Which tunnel port is currently previewed in the iframe (null = none) */
    const [previewPort, setPreviewPort] = useState<number | null>(null);
    /** Detached panel whose tunnel was closed — keep the tab, show a notice. */
    const [detachedGone, setDetachedGone] = useState(false);
    const [iframeLoading, setIframeLoading] = useState(false);
    /** Bumped to force iframe reload */
    const [iframeKey, setIframeKey] = useState(0);
    const iframeRef = useRef<HTMLIFrameElement | null>(null);

    const { send, available } = useServiceChannel<unknown, unknown>("tunnel", {
        onMessage: (type, payload) => {
            const p = payload as Record<string, unknown>;
            if (type === "tunnel_error") {
                reportError("tunnel", (p.error as string) || "Tunnel operation failed");
            } else if (type === "tunnel_list_result") {
                setTunnels(((p.tunnels as TunnelInfo[]) ?? []).filter((t: TunnelInfo) => !t.pinned));
            } else if (type === "tunnel_registered") {
                const info = p as unknown as TunnelInfo;
                if (info.pinned) return;
                setTunnels((prev: TunnelInfo[]) => [...prev.filter((t: TunnelInfo) => t.port !== info.port), info]);
                if (detachedPort === info.port) setDetachedGone(false);
            } else if (type === "tunnel_removed") {
                const port = p.port as number;
                // pinned tunnels are never in state, so this is a no-op for them — safe to run regardless
                setTunnels((prev: TunnelInfo[]) => prev.filter((t: TunnelInfo) => t.port !== port));
                // If the removed tunnel was being previewed, clear it
                if (previewPort === port) setPreviewPort(null);
                if (detachedPort === port) setDetachedGone(true);
            }
        }
    });

    useEffect(() => {
        if (available) {
            send("tunnel_list", {});
        } else {
            // Clear stale state immediately on disconnect so that when the
            // socket reconnects and `available` flips back to true, the panel
            // does not briefly flash the previous (dead) tunnel entries.
            setTunnels([]);
            setPreviewPort(null);
            setDetachedGone(false);
        }
    }, [available, send]);

    // Auto-preview the first tunnel when it appears (detached panels are pinned
    // to their own port and never auto-switch).
    useEffect(() => {
        if (detachedPort === null && tunnels.length > 0 && previewPort === null) {
            setPreviewPort(tunnels[0].port);
        }
    }, [tunnels, previewPort, detachedPort]);

    const handleExpose = useCallback(() => {
        const port = parseInt(portInput, 10);
        if (!port || port < 1 || port > 65535) return;
        send("tunnel_expose", { port, name: nameInput || undefined });
        setPortInput("");
        setNameInput("");
        // Auto-preview the newly exposed port
        setPreviewPort(port);
    }, [portInput, nameInput, send]);

    const handleReload = useCallback(() => {
        setIframeKey(k => k + 1);
    }, []);

    const detached = detachedPort !== null;
    const activePort = detachedPort ?? previewPort;
    const activeTunnel = tunnels.find(t => t.port === activePort);

    // Resolve the iframe URL for the active preview (web = relative, mobile =
    // signed token against the relay). This is the fix for blank iframes in the
    // Capacitor app, where a relative /api/tunnel/... hit the local bundle.
    const { base: previewBase, loading: previewLoading, error: previewError } = useTunnelSrc({
        sessionId,
        port: activePort,
        runnerId,
        enabled: available && activePort !== null,
        // User-app previews get the dedicated tunnel origin when configured —
        // SPAs see a clean location.pathname instead of the proxy prefix.
        preferHostOrigin: true,
    });

    if (!available) return null;

    return (
        <div className="flex flex-col h-full overflow-hidden">
            {/* Toolbar: tunnel list + controls */}
            <div className="flex items-center gap-1.5 px-3 py-1.5 border-b border-border bg-muted/20 shrink-0 flex-wrap">
                {/* Tunnel tabs (hidden in a detached single-port panel) */}
                {detached && (
                    <div className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded border border-primary/40 bg-primary/10 text-primary font-medium">
                        <span className="font-mono">{detachedPort}</span>
                        {activeTunnel?.name && <span className="max-w-32 truncate">{activeTunnel.name}</span>}
                    </div>
                )}

                {!detached && tunnels.map((tunnel: TunnelInfo) => (
                    <div
                        key={tunnel.port}
                        className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded border transition-colors ${
                            previewPort === tunnel.port
                                ? "border-primary/40 bg-primary/10 text-primary font-medium"
                                : "border-border bg-background text-muted-foreground hover:bg-accent"
                        }`}
                    >
                        <button
                            type="button"
                            onClick={() => setPreviewPort(tunnel.port)}
                            className="inline-flex items-center gap-1 min-w-0"
                        >
                            <span className="font-mono">{tunnel.port}</span>
                            {tunnel.name && <span className="max-w-20 truncate">{tunnel.name}</span>}
                        </button>
                        {onSpawnPanel && (
                            <button
                                type="button"
                                onClick={() => onSpawnPanel(makePanelId("tunnel", tunnel.port))}
                                className="ml-0.5 text-muted-foreground hover:text-foreground"
                                title="Open in its own panel"
                                aria-label={`Detach tunnel ${tunnel.port} into its own panel`}
                            >
                                <PanelRightOpen size={10} />
                            </button>
                        )}
                        <button
                            type="button"
                            onClick={() => send("tunnel_unexpose", { port: tunnel.port })}
                            className="ml-0.5 text-muted-foreground hover:text-destructive"
                            title="Close tunnel"
                            aria-label={`Close tunnel ${tunnel.port}`}
                        >
                            <X size={10} />
                        </button>
                    </div>
                ))}

                {/* Actions for active preview */}
                {activePort && (
                    <>
                        <button
                            type="button"
                            onClick={handleReload}
                            className="p-1 text-muted-foreground hover:text-foreground rounded"
                            title="Reload preview"
                        >
                            <RefreshCw size={12} />
                        </button>
                        {previewBase && (
                            <a
                                href={previewBase}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="p-1 text-muted-foreground hover:text-foreground rounded"
                                title="Open in new tab"
                            >
                                <ExternalLink size={12} />
                            </a>
                        )}
                    </>
                )}

                {/* Spacer */}
                <div className="flex-1" />

                {/* Expose new port (the detached view is a single-port preview) */}
                {!detached && <div className="flex items-center gap-1">
                    <input
                        type="number"
                        placeholder="Port"
                        value={portInput}
                        onChange={e => setPortInput(e.target.value)}
                        onKeyDown={e => { if (e.key === "Enter") handleExpose(); }}
                        className="w-16 text-xs rounded border border-border bg-background px-1.5 py-0.5"
                        min={1}
                        max={65535}
                    />
                    <input
                        type="text"
                        placeholder="Name"
                        value={nameInput}
                        onChange={e => setNameInput(e.target.value)}
                        onKeyDown={e => { if (e.key === "Enter") handleExpose(); }}
                        className="w-20 text-xs rounded border border-border bg-background px-1.5 py-0.5"
                    />
                    <button
                        type="button"
                        onClick={handleExpose}
                        disabled={!portInput}
                        className="inline-flex items-center gap-0.5 text-xs px-1.5 py-0.5 rounded bg-primary text-primary-foreground disabled:opacity-50"
                        title="Expose port"
                    >
                        <Plus size={10} />
                    </button>
                </div>}
            </div>

            {/* Preview area */}
            <div className="flex-1 relative bg-background">
                {detached && detachedGone ? (
                    <div className="flex items-center justify-center h-full text-xs text-muted-foreground">
                        Tunnel on port {detachedPort} was closed
                    </div>
                ) : activePort && previewError ? (
                    <div className="flex h-full flex-col items-center justify-center gap-1 p-4 text-center text-xs text-muted-foreground">
                        <div className="text-destructive">Could not open port {activePort}</div>
                        <div className="break-all font-mono opacity-80">{previewError}</div>
                    </div>
                ) : activePort && previewBase ? (
                    <>
                        {(iframeLoading || previewLoading) && (
                            <div className="absolute inset-0 flex items-center justify-center bg-background/80 z-10">
                                <Loader2 className="size-5 animate-spin text-muted-foreground" />
                            </div>
                        )}
                        {/*
                          * allow-same-origin is required for storage/cookie-dependent dashboards
                          * (e.g. service panels that read localStorage). The tunnel URL is served
                          * from our own origin so same-origin grants no extra cross-origin privilege
                          * beyond what a plain fetch would already allow. See also PR #415.
                          */}
                        <iframe
                            key={iframeKey}
                            ref={iframeRef}
                            src={previewBase}
                            className="w-full h-full border-0"
                            title={`Tunnel preview — port ${activePort}`}
                            // SECURITY: allow-same-origin is needed because tunnel content is same-origin. TODO: serve tunnel content from a separate origin to enable full sandbox isolation.
                            sandbox="allow-scripts allow-forms allow-same-origin allow-popups"
                            onLoad={() => setIframeLoading(false)}
                            onLoadStart={() => setIframeLoading(true)}
                        />
                    </>
                ) : activePort && previewLoading ? (
                    <div className="absolute inset-0 flex items-center justify-center">
                        <Loader2 className="size-5 animate-spin text-muted-foreground" />
                    </div>
                ) : tunnels.length === 0 ? (
                    <div className="flex items-center justify-center h-full text-xs text-muted-foreground">
                        No tunnels active — expose a port to preview it here
                    </div>
                ) : null}
            </div>
        </div>
    );
}
