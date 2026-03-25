import { useState, useEffect, useCallback } from "react";
import { useServiceChannel } from "@/hooks/useServiceChannel";
import { ExternalLink, Plus, X, Server } from "lucide-react";

interface TunnelInfo {
    port: number;
    name?: string;
    url: string;
}

interface TunnelPanelProps {
    sessionId: string;
}

export function TunnelPanel({ sessionId }: TunnelPanelProps) {
    const [tunnels, setTunnels] = useState<TunnelInfo[]>([]);
    const [portInput, setPortInput] = useState("");
    const [nameInput, setNameInput] = useState("");

    const { send, available } = useServiceChannel<unknown, unknown>("tunnel", {
        onMessage: (type, payload) => {
            const p = payload as Record<string, unknown>;
            if (type === "tunnel_list_result") {
                setTunnels((p.tunnels as TunnelInfo[]) ?? []);
            } else if (type === "tunnel_registered") {
                const info = p as unknown as TunnelInfo;
                setTunnels((prev: TunnelInfo[]) => [...prev.filter((t: TunnelInfo) => t.port !== info.port), info]);
            } else if (type === "tunnel_removed") {
                const port = p.port as number;
                setTunnels((prev: TunnelInfo[]) => prev.filter((t: TunnelInfo) => t.port !== port));
            }
        }
    });

    useEffect(() => {
        if (available) send("tunnel_list", {});
    }, [available, send]);

    const handleExpose = useCallback(() => {
        const port = parseInt(portInput, 10);
        if (!port || port < 1 || port > 65535) return;
        send("tunnel_expose", { port, name: nameInput || undefined });
        setPortInput("");
        setNameInput("");
    }, [portInput, nameInput, send]);

    if (!available) return null;

    const tunnelUrl = (port: number) => `/api/tunnel/${sessionId}/${port}/`;

    return (
        <div className="p-4 space-y-3">
            <div className="flex items-center gap-2 text-sm font-medium">
                <Server size={14} />
                Port Tunnels
            </div>

            {tunnels.length === 0 ? (
                <p className="text-xs text-muted-foreground">No tunnels active</p>
            ) : (
                <div className="space-y-1">
                    {tunnels.map((tunnel: TunnelInfo) => (
                        <div key={tunnel.port} className="flex items-center gap-2 text-sm">
                            <span className="text-muted-foreground font-mono">{tunnel.port}</span>
                            {tunnel.name && <span>{tunnel.name}</span>}
                            <a
                                href={tunnelUrl(tunnel.port)}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="ml-auto flex items-center gap-1 text-xs text-primary hover:underline"
                            >
                                Open <ExternalLink size={10} />
                            </a>
                            <button
                                type="button"
                                onClick={() => send("tunnel_unexpose", { port: tunnel.port })}
                                className="text-muted-foreground hover:text-destructive"
                            >
                                <X size={12} />
                            </button>
                        </div>
                    ))}
                </div>
            )}

            <div className="flex gap-2">
                <input
                    type="number"
                    placeholder="Port"
                    value={portInput}
                    onChange={e => setPortInput(e.target.value)}
                    className="w-20 text-xs rounded border border-border bg-background px-2 py-1"
                    min={1}
                    max={65535}
                />
                <input
                    type="text"
                    placeholder="Name (optional)"
                    value={nameInput}
                    onChange={e => setNameInput(e.target.value)}
                    className="flex-1 text-xs rounded border border-border bg-background px-2 py-1"
                />
                <button
                    type="button"
                    onClick={handleExpose}
                    disabled={!portInput}
                    className="flex items-center gap-1 text-xs px-2 py-1 rounded bg-primary text-primary-foreground disabled:opacity-50"
                >
                    <Plus size={12} /> Expose
                </button>
            </div>
        </div>
    );
}
