import { useState, useEffect, useCallback } from "react";
import { useServiceChannel } from "@/hooks/useServiceChannel";
import { reportError } from "@/lib/frontend-log";
import { RefreshCw, X, ChevronRight, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

interface SessionProcess {
    pid: number;
    etime: string;
    rssKb: number;
    command: string;
}

/** Background shell record from the worker's bash override (see process-service.ts ShellInfo). */
interface ShellInfo {
    pid: number;
    command: string;
    title: string;
    logPath: string;
    startedAt: number;
    exitCode?: number | null;
    signal?: string | null;
    endedAt?: number;
    running: boolean;
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

function formatRuntime(shell: ShellInfo): string {
    const ms = (shell.endedAt ?? Date.now()) - shell.startedAt;
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s}s`;
    if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
    return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

function shellStatus(shell: ShellInfo): { label: string; className: string } {
    if (shell.running) return { label: "running", className: "bg-primary/15 text-primary" };
    if (shell.endedAt === undefined) return { label: "ended", className: "bg-muted text-muted-foreground" };
    if (shell.signal) return { label: shell.signal, className: "bg-amber-500/15 text-amber-600 dark:text-amber-400" };
    if (shell.exitCode === 0) return { label: "exit 0", className: "bg-muted text-muted-foreground" };
    return { label: `exit ${shell.exitCode}`, className: "bg-destructive/15 text-destructive" };
}

const POLL_MS = 3000;

export function ProcessPanel({ sessionId }: ProcessPanelProps) {
    const [processes, setProcesses] = useState<SessionProcess[]>([]);
    const [shells, setShells] = useState<ShellInfo[]>([]);
    const [workerPid, setWorkerPid] = useState<number | null>(null);
    const [loaded, setLoaded] = useState(false);
    const [expandedPid, setExpandedPid] = useState<number | null>(null);
    const [tails, setTails] = useState<Record<number, string>>({});

    const { send, available } = useServiceChannel<unknown, unknown>("process", {
        onMessage: (type, payload) => {
            const p = payload as Record<string, unknown>;
            if (type === "process_list_result") {
                setProcesses((p.processes as SessionProcess[]) ?? []);
                setShells((p.shells as ShellInfo[]) ?? []);
                setWorkerPid((p.workerPid as number | null) ?? null);
                setLoaded(true);
            } else if (type === "process_tail_result") {
                const pid = p.pid as number;
                setTails((t) => ({ ...t, [pid]: (p.text as string) || "(no output yet)" }));
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
            setShells([]);
            setLoaded(false);
            return;
        }
        refresh();
        const interval = setInterval(refresh, POLL_MS);
        return () => clearInterval(interval);
    }, [available, refresh]);

    // Keep the expanded shell's log tail fresh alongside the list poll.
    useEffect(() => {
        if (!available || expandedPid === null) return;
        send("process_tail", { sessionId, pid: expandedPid });
        const interval = setInterval(() => send("process_tail", { sessionId, pid: expandedPid }), POLL_MS);
        return () => clearInterval(interval);
    }, [available, expandedPid, send, sessionId]);

    if (!available) return null;

    const toggleExpand = (pid: number) => setExpandedPid((cur) => (cur === pid ? null : pid));

    return (
        <div className="flex flex-col h-full overflow-hidden">
            <div className="flex items-center gap-1.5 px-3 py-1.5 border-b border-border bg-muted/20 shrink-0">
                <span className="text-xs text-muted-foreground">
                    {processes.length} process{processes.length === 1 ? "" : "es"}
                    {shells.length > 0 && ` · ${shells.length} shell${shells.length === 1 ? "" : "s"}`}
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
                {shells.length > 0 && (
                    <div className="border-b border-border">
                        <div className="px-3 pt-2 pb-1 text-[10px] uppercase tracking-wide text-muted-foreground">
                            Background shells
                        </div>
                        {shells.map((shell) => {
                            const status = shellStatus(shell);
                            const expanded = expandedPid === shell.pid;
                            return (
                                <div key={shell.pid} className="border-b border-border/50 last:border-b-0">
                                    <div className="flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-accent/30">
                                        <button
                                            type="button"
                                            onClick={() => toggleExpand(shell.pid)}
                                            className="text-muted-foreground hover:text-foreground"
                                            aria-expanded={expanded}
                                            aria-label={expanded ? "Hide output" : "Show output"}
                                        >
                                            {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                                        </button>
                                        <span
                                            className={cn(
                                                "shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium",
                                                status.className,
                                            )}
                                        >
                                            {status.label}
                                        </span>
                                        <span className="min-w-0 flex-1 truncate" title={shell.command}>
                                            <span className="font-medium">{shell.title || shell.command}</span>
                                            {shell.title && (
                                                <span className="ml-1.5 font-mono text-muted-foreground">{shell.command}</span>
                                            )}
                                        </span>
                                        <span className="shrink-0 font-mono text-muted-foreground">{formatRuntime(shell)}</span>
                                        <span className="shrink-0 font-mono text-muted-foreground">pid {shell.pid}</span>
                                        {shell.running && (
                                            <button
                                                type="button"
                                                onClick={() => send("process_kill", { sessionId, pid: shell.pid })}
                                                className="text-muted-foreground hover:text-destructive"
                                                title={`Kill ${shell.pid}`}
                                                aria-label={`Kill shell ${shell.pid}`}
                                            >
                                                <X size={11} />
                                            </button>
                                        )}
                                    </div>
                                    {expanded && (
                                        <pre className="mx-3 mb-2 max-h-48 overflow-y-auto rounded bg-muted/40 p-2 text-[11px] leading-snug whitespace-pre-wrap break-all">
                                            {tails[shell.pid] ?? "Loading…"}
                                        </pre>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                )}

                {processes.length === 0 && shells.length === 0 ? (
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
