import { useState, useEffect, useCallback, useRef } from "react";
import { useServiceChannel } from "@/hooks/useServiceChannel";
import { ExternalLink, Plus, X, RefreshCw, Loader2 } from "lucide-react";

interface TunnelInfo {
    port: number;
    name?: string;
    url: string;
    pinned?: boolean;
}

interface TunnelPanelProps {
    sessionId: string;
}

export function TunnelPanel({ sessionId }: TunnelPanelProps) {
    const [tunnels, setTunnels] = useState<TunnelInfo[]>([]);
    const [portInput, setPortInput] = useState("");
    const [nameInput, setNameInput] = useState("");
    /** Which tunnel port is currently previewed in the iframe (null = none) */
    const [previewPort, setPreviewPort] = useState<number | null>(null);
    const [iframeLoading, setIframeLoading] = useState(false);
    /** Bumped to force iframe reload */
    const [iframeKey, setIframeKey] = useState(0);
    const iframeRef = useRef<HTMLIFrameElement | null>(null);

    const { send, available } = useServiceChannel<unknown, unknown>("tunnel", {
        onMessage: (type, payload) => {
            const p = payload as Record<string, unknown>;
            if (type === "tunnel_list_result") {
                setTunnels(((p.tunnels as TunnelInfo[]) ?? []).filter((t: TunnelInfo) => !t.pinned));
            } else if (type === "tunnel_registered") {
                const info = p as unknown as TunnelInfo;
                if (info.pinned) return;
                setTunnels((prev: TunnelInfo[]) => [...prev.filter((t: TunnelInfo) => t.port !== info.port), info]);
            } else if (type === "tunnel_removed") {
                const port = p.port as number;
                // pinned tunnels are never in state, so this is a no-op for them — safe to run regardless
                setTunnels((prev: TunnelInfo[]) => prev.filter((t: TunnelInfo) => t.port !== port));
                // If the removed tunnel was being previewed, clear it
                if (previewPort === port) setPreviewPort(null);
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
        }
    }, [available, send]);

    // Auto-preview the first tunnel when it appears
    useEffect(() => {
        if (tunnels.length > 0 && previewPort === null) {
            setPreviewPort(tunnels[0].port);
        }
    }, [tunnels, previewPort]);

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

    if (!available) return null;

    const tunnelUrl = (port: number) => `/api/tunnel/${sessionId}/${port}/`;

    return (
        <div className="flex flex-col h-full">
            {/* Toolbar: tunnel list + controls */}
            <div className="flex items-center gap-1.5 px-3 py-1.5 border-b border-border bg-muted/20 shrink-0 flex-wrap">
                {/* Tunnel tabs */}
                {tunnels.map((tunnel: TunnelInfo) => (
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
                {previewPort && (
                    <>
                        <button
                            type="button"
                            onClick={handleReload}
                            className="p-1 text-muted-foreground hover:text-foreground rounded"
                            title="Reload preview"
                        >
                            <RefreshCw size={12} />
                        </button>
                        <a
                            href={tunnelUrl(previewPort)}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="p-1 text-muted-foreground hover:text-foreground rounded"
                            title="Open in new tab"
                        >
                            <ExternalLink size={12} />
                        </a>
                    </>
                )}

                {/* Spacer */}
                <div className="flex-1" />

                {/* Expose new port */}
                <div className="flex items-center gap-1">
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
                </div>
            </div>

            {/* Preview area */}
            <div className="flex-1 relative bg-background">
                {previewPort ? (
                    <>
                        {iframeLoading && (
                            <div className="absolute inset-0 flex items-center justify-center bg-background/80 z-10">
                                <Loader2 className="size-5 animate-spin text-muted-foreground" />
                            </div>
                        )}
                        <iframe
                            key={iframeKey}
                            ref={iframeRef}
                            src={tunnelUrl(previewPort)}
                            className="w-full h-full border-0"
                            title={`Tunnel preview — port ${previewPort}`}
                            sandbox="allow-scripts allow-forms allow-same-origin allow-popups"
                            onLoad={() => setIframeLoading(false)}
                            onLoadStart={() => setIframeLoading(true)}
                        />
                    </>
                ) : tunnels.length === 0 ? (
                    <div className="flex items-center justify-center h-full text-xs text-muted-foreground">
                        No tunnels active — expose a port to preview it here
                    </div>
                ) : null}
            </div>
        </div>
    );
}
