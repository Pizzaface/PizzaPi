import { useState, useEffect, useCallback } from "react";
import { useServiceChannel } from "@/hooks/useServiceChannel";
import { reportError } from "@/lib/frontend-log";
import { RefreshCw, X } from "lucide-react";

interface SessionProcess {
    pid: number;
    etime: string;
    rssKb: number;
    command: string;
}

interface ProcessPanelProps {
    sessionId: string;
    runnerId?: string;
}

function formatRss(rssKb: number): string {
    if (rssKb >= 1024 * 1024) return `${(rssKb / (1024 * 1024)).toFixed(1)} GB`;
    if (rssKb >= 1024) return `${Math.round(rssKb / 1024)} MB`;
    return `${rssKb} KB`;
}

const POLL_MS = 3000;

export function ProcessPanel({ sessionId }: ProcessPanelProps) {
    const [processes, setProcesses] = useState<SessionProcess[]>([]);
    const [workerPid, setWorkerPid] = useState<number | null>(null);
    const [loaded, setLoaded] = useState(false);

    const { send, available } = useServiceChannel<unknown, unknown>("process", {
        onMessage: (type, payload) => {
            const p = payload as Record<string, unknown>;
            if (type === "process_list_result") {
                setProcesses((p.processes as SessionProcess[]) ?? []);
                setWorkerPid((p.workerPid as number | null) ?? null);
                setLoaded(true);
            } else if (type === "process_error") {
                reportError("process", (p.error as string) || "Process operation failed");
            }
        },
    });

    const refresh = useCallback(() => {
        send("process_list", { sessionId });
    }, [send, sessionId]);

    useEffect(() => {
        if (!available) {
            setProcesses([]);
            setLoaded(false);
            return;
        }
        refresh();
        const interval = setInterval(refresh, POLL_MS);
        return () => clearInterval(interval);
    }, [available, refresh]);

    if (!available) return null;

    return (
        <div className="flex flex-col h-full overflow-hidden">
            <div className="flex items-center gap-1.5 px-3 py-1.5 border-b border-border bg-muted/20 shrink-0">
                <span className="text-xs text-muted-foreground">
                    {processes.length} process{processes.length === 1 ? "" : "es"}
                    {workerPid ? ` · group ${workerPid}` : ""}
                </span>
                <div className="flex-1" />
                <button
                    type="button"
                    onClick={refresh}
                    className="p-1 text-muted-foreground hover:text-foreground rounded"
                    title="Refresh"
                >
                    <RefreshCw size={12} />
                </button>
            </div>

            <div className="flex-1 overflow-y-auto">
                {processes.length === 0 ? (
                    <div className="flex items-center justify-center h-full text-xs text-muted-foreground">
                        {loaded
                            ? workerPid
                                ? "No processes"
                                : "Process tracking unavailable for this session"
                            : "Loading…"}
                    </div>
                ) : (
                    <table className="w-full text-xs">
                        <thead className="sticky top-0 bg-background">
                            <tr className="text-left text-muted-foreground border-b border-border">
                                <th className="px-3 py-1 font-medium">PID</th>
                                <th className="px-2 py-1 font-medium">Uptime</th>
                                <th className="px-2 py-1 font-medium">Mem</th>
                                <th className="px-2 py-1 font-medium">Command</th>
                                <th className="px-2 py-1" />
                            </tr>
                        </thead>
                        <tbody>
                            {processes.map((proc) => (
                                <tr key={proc.pid} className="border-b border-border/50 hover:bg-accent/30">
                                    <td className="px-3 py-1 font-mono">{proc.pid}</td>
                                    <td className="px-2 py-1 font-mono whitespace-nowrap">{proc.etime}</td>
                                    <td className="px-2 py-1 font-mono whitespace-nowrap">{formatRss(proc.rssKb)}</td>
                                    <td className="px-2 py-1 font-mono truncate max-w-0 w-full" title={proc.command}>
                                        {proc.command}
                                        {proc.pid === workerPid && (
                                            <span className="ml-1.5 text-[10px] text-primary/80">worker</span>
                                        )}
                                    </td>
                                    <td className="px-2 py-1">
                                        {proc.pid !== workerPid && (
                                            <button
                                                type="button"
                                                onClick={() => send("process_kill", { sessionId, pid: proc.pid })}
                                                className="text-muted-foreground hover:text-destructive"
                                                title={`Kill ${proc.pid}`}
                                                aria-label={`Kill process ${proc.pid}`}
                                            >
                                                <X size={11} />
                                            </button>
                                        )}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                )}
            </div>
        </div>
    );
}
