import * as React from "react";
import { Button } from "@/components/ui/button";
import { RefreshCw, HardDrive, Hash, Loader2, Server, ChevronDown, Plus, FolderOpen, Terminal, Clock, Power } from "lucide-react";
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { formatPathTail } from "@/lib/path";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SkillsManager, type SkillInfo } from "@/components/SkillsManager";
import { Skeleton } from "@/components/ui/skeleton";

interface RunnerInfo {
    runnerId: string;
    name: string | null;
    roots: string[];
    sessionCount: number;
    skills: SkillInfo[];
}

interface LiveSession {
    sessionId: string;
    shareUrl: string;
    cwd: string;
    startedAt: string;
    sessionName: string | null;
    isActive: boolean;
    lastHeartbeatAt: string | null;
    runnerId: string | null;
    runnerName: string | null;
}

export interface RunnerManagerProps {
    onOpenSession?: (sessionId: string) => void;
}

export function RunnerManager({ onOpenSession }: RunnerManagerProps) {
    const [runners, setRunners] = React.useState<RunnerInfo[]>([]);
    const [sessions, setSessions] = React.useState<LiveSession[]>([]);
    const [loading, setLoading] = React.useState(true);
    const [restarting, setRestarting] = React.useState<Set<string>>(new Set());
    const [stopping, setStopping] = React.useState<Set<string>>(new Set());

    // New session dialog
    const [spawnRunnerId, setSpawnRunnerId] = React.useState<string | null>(null);
    const [spawnCwd, setSpawnCwd] = React.useState("");
    const [spawning, setSpawning] = React.useState(false);
    const [spawnError, setSpawnError] = React.useState<string | null>(null);
    const [recentFolders, setRecentFolders] = React.useState<string[]>([]);
    const [recentFoldersLoading, setRecentFoldersLoading] = React.useState(false);

    const fetchData = React.useCallback(async () => {
        try {
            const [runnersRes, sessionsRes] = await Promise.all([
                fetch("/api/runners", { credentials: "include" }),
                fetch("/api/sessions", { credentials: "include" }),
            ]);
            if (runnersRes.ok) {
                const data = await runnersRes.json();
                const raw: any[] = data.runners || [];
                setRunners(raw.map((r) => ({
                    runnerId: r.runnerId,
                    name: r.name,
                    roots: r.roots ?? [],
                    sessionCount: r.sessionCount ?? 0,
                    skills: Array.isArray(r.skills) ? r.skills : [],
                })));
            }
            if (sessionsRes.ok) {
                const data = await sessionsRes.json();
                setSessions(data.sessions || []);
            }
        } catch (error) {
            console.error("Failed to fetch runners/sessions:", error);
        } finally {
            setLoading(false);
        }
    }, []);

    React.useEffect(() => {
        fetchData();
        const interval = setInterval(fetchData, 10000);
        return () => clearInterval(interval);
    }, [fetchData]);

    // Fetch recent folders when a runner is selected in the spawn dialog
    React.useEffect(() => {
        if (!spawnRunnerId) {
            setRecentFolders([]);
            return;
        }
        let cancelled = false;
        setRecentFoldersLoading(true);
        fetch(`/api/runners/${encodeURIComponent(spawnRunnerId)}/recent-folders`, { credentials: "include" })
            .then((res) => (res.ok ? res.json() : Promise.reject()))
            .then((data) => {
                if (cancelled) return;
                setRecentFolders(Array.isArray(data?.folders) ? data.folders : []);
            })
            .catch(() => { if (!cancelled) setRecentFolders([]); })
            .finally(() => { if (!cancelled) setRecentFoldersLoading(false); });
        return () => { cancelled = true; };
    }, [spawnRunnerId]);

    const handleRestart = async (runnerId: string) => {
        setRestarting((prev) => new Set(prev).add(runnerId));
        try {
            const res = await fetch("/api/runners/restart", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ runnerId }),
                credentials: "include",
            });
            if (!res.ok) {
                const data = await res.json();
                alert(`Failed to restart runner: ${data.error || "Unknown error"}`);
            }
        } catch (error) {
            console.error("Failed to restart runner:", error);
        } finally {
            setTimeout(() => {
                setRestarting((prev) => {
                    const next = new Set(prev);
                    next.delete(runnerId);
                    return next;
                });
                fetchData();
            }, 2000);
        }
    };

    const handleStop = async (runnerId: string) => {
        if (!confirm("Stop this runner? It will shut down completely and won't restart automatically.")) return;
        setStopping((prev) => new Set(prev).add(runnerId));
        try {
            const res = await fetch("/api/runners/stop", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ runnerId }),
                credentials: "include",
            });
            if (!res.ok) {
                const data = await res.json();
                alert(`Failed to stop runner: ${data.error || "Unknown error"}`);
            }
        } catch (error) {
            console.error("Failed to stop runner:", error);
        } finally {
            setTimeout(() => {
                setStopping((prev) => {
                    const next = new Set(prev);
                    next.delete(runnerId);
                    return next;
                });
                fetchData();
            }, 3000);
        }
    };

    const handleOpenNewSession = (runnerId: string) => {
        setSpawnRunnerId(runnerId);
        setSpawnCwd("");
        setSpawnError(null);
    };

    const handleSpawn = async () => {
        if (!spawnRunnerId || spawning) return;
        setSpawning(true);
        setSpawnError(null);

        try {
            const res = await fetch("/api/runners/spawn", {
                method: "POST",
                credentials: "include",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                    runnerId: spawnRunnerId,
                    ...(spawnCwd.trim() ? { cwd: spawnCwd.trim() } : {}),
                }),
            });
            const body = await res.json().catch(() => null) as any;
            if (!res.ok) {
                setSpawnError(body?.error || `Spawn failed (HTTP ${res.status})`);
                return;
            }

            const sessionId = body?.sessionId;
            if (!sessionId) {
                setSpawnError("Spawn failed: missing sessionId in response");
                return;
            }

            setSpawnRunnerId(null);

            // Poll until session appears then open it
            if (onOpenSession) {
                const deadline = Date.now() + 30_000;
                const poll = async (): Promise<void> => {
                    if (Date.now() > deadline) return;
                    try {
                        const r = await fetch("/api/sessions", { credentials: "include" });
                        if (r.ok) {
                            const d = await r.json().catch(() => null) as any;
                            const live = Array.isArray(d?.sessions) && d.sessions.some((s: any) => s?.sessionId === sessionId);
                            if (live) {
                                onOpenSession(sessionId);
                                return;
                            }
                        }
                    } catch {}
                    await new Promise((r) => setTimeout(r, 1000));
                    return poll();
                };
                void poll();
            }

            fetchData();
        } finally {
            setSpawning(false);
        }
    };

    if (loading && runners.length === 0) {
        return (
            <div className="flex flex-col gap-6 p-6 max-w-4xl mx-auto w-full animate-in fade-in duration-700">
                <div className="flex items-start justify-between">
                    <div className="space-y-2">
                        <Skeleton className="h-8 w-32 rounded-md" />
                        <Skeleton className="h-4 w-64 rounded-md" />
                    </div>
                    <Skeleton className="h-8 w-24 rounded-md" />
                </div>
                <div className="flex flex-col gap-4">
                    {[1, 2].map((i) => (
                        <div key={i} className="rounded-xl border border-border/40 bg-card p-4 space-y-4">
                            <div className="flex items-start justify-between gap-3">
                                <div className="flex items-center gap-3">
                                    <Skeleton className="h-2 w-2 rounded-full" />
                                    <div className="space-y-1.5">
                                        <Skeleton className="h-4 w-32 rounded-md" />
                                        <Skeleton className="h-3 w-48 rounded-md" />
                                    </div>
                                </div>
                                <div className="flex gap-1.5">
                                    <Skeleton className="h-7 w-24 rounded-md" />
                                    <Skeleton className="h-7 w-20 rounded-md" />
                                </div>
                            </div>
                            <div className="border-t border-border/40" />
                            <div className="flex gap-6">
                                <Skeleton className="h-4 w-24 rounded-md" />
                                <Skeleton className="h-4 w-24 rounded-md" />
                            </div>
                        </div>
                    ))}
                </div>
            </div>
        );
    }

    return (
        <>
            <div className="flex flex-col gap-6 p-4 sm:p-6 max-w-4xl mx-auto w-full">
                {/* Header */}
                <div className="flex items-start justify-between">
                    <div className="space-y-0.5">
                        <h2 className="text-2xl font-semibold tracking-tight">Runners</h2>
                        <p className="text-sm text-muted-foreground">Manage your remote execution environments.</p>
                    </div>
                    <Button
                        variant="ghost"
                        size="sm"
                        onClick={fetchData}
                        disabled={loading}
                        className="text-muted-foreground hover:text-foreground h-8 px-2.5"
                    >
                        <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
                        <span className="ml-1.5 text-xs">Refresh</span>
                    </Button>
                </div>

                {/* Empty state */}
                {runners.length === 0 ? (
                    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border/60 py-10 px-4 sm:py-16 sm:px-8 gap-4 text-center bg-muted/20">
                        <div className="rounded-full bg-muted p-3">
                            <Server className="h-6 w-6 text-muted-foreground" />
                        </div>
                        <div className="space-y-1">
                            <p className="text-sm font-medium">No active runners</p>
                            <p className="text-xs text-muted-foreground max-w-xs">
                                Connect a runner by running{" "}
                                <code className="font-mono bg-muted px-1 py-0.5 rounded text-[11px]">pizzapi runner</code>{" "}
                                on your machine.
                            </p>
                        </div>
                    </div>
                ) : (
                    <div className="flex flex-col gap-3">
                        {runners.map((runner) => {
                            const runnerSessions = sessions.filter((s) => s.runnerId === runner.runnerId);
                            return (
                                <RunnerCard
                                    key={runner.runnerId}
                                    runner={runner}
                                    sessions={runnerSessions}
                                    isRestarting={restarting.has(runner.runnerId)}
                                    isStopping={stopping.has(runner.runnerId)}
                                    onRestart={() => handleRestart(runner.runnerId)}
                                    onStop={() => handleStop(runner.runnerId)}
                                    onNewSession={() => handleOpenNewSession(runner.runnerId)}
                                    onOpenSession={onOpenSession}
                                    onSkillsChange={(runnerId, updatedSkills) => {
                                        setRunners((prev) => prev.map((r) =>
                                            r.runnerId === runnerId ? { ...r, skills: updatedSkills } : r
                                        ));
                                    }}
                                />
                            );
                        })}
                    </div>
                )}
            </div>

            {/* New session dialog */}
            <Dialog open={spawnRunnerId !== null} onOpenChange={(open) => { if (!open) setSpawnRunnerId(null); }}>
                <DialogContent className="sm:max-w-md">
                    <DialogHeader>
                        <DialogTitle>New Session</DialogTitle>
                        <DialogDescription>
                            Start a new agent session on{" "}
                            <span className="font-medium text-foreground">
                                {runners.find((r) => r.runnerId === spawnRunnerId)?.name || spawnRunnerId?.slice(0, 12) + "…"}
                            </span>
                        </DialogDescription>
                    </DialogHeader>

                    <div className="flex flex-col gap-4 py-2">
                        <div className="flex flex-col gap-1.5">
                            <Label htmlFor="spawn-cwd" className="text-sm">Working directory <span className="text-muted-foreground font-normal">(optional)</span></Label>
                            <Input
                                id="spawn-cwd"
                                placeholder="/home/user/project"
                                value={spawnCwd}
                                onChange={(e) => setSpawnCwd(e.target.value)}
                                onKeyDown={(e) => { if (e.key === "Enter") handleSpawn(); }}
                                className="font-mono text-sm"
                            />
                        </div>

                        {/* Recent folders */}
                        {(recentFoldersLoading || recentFolders.length > 0) && (
                            <div className="flex flex-col gap-1.5">
                                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Recent folders</p>
                                {recentFoldersLoading ? (
                                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                                        <Loader2 className="h-3 w-3 animate-spin" />
                                        Loading…
                                    </div>
                                ) : (
                                    <div className="flex flex-col gap-1">
                                        {recentFolders.map((folder) => (
                                            <button
                                                key={folder}
                                                type="button"
                                                onClick={() => setSpawnCwd(folder)}
                                                className={cn(
                                                    "flex items-center gap-2 text-left px-2.5 py-1.5 rounded-md text-xs font-mono transition-colors",
                                                    spawnCwd === folder
                                                        ? "bg-accent text-accent-foreground"
                                                        : "text-muted-foreground hover:bg-muted hover:text-foreground"
                                                )}
                                            >
                                                <FolderOpen className="h-3.5 w-3.5 flex-shrink-0 opacity-60" />
                                                <span className="truncate">{folder}</span>
                                            </button>
                                        ))}
                                    </div>
                                )}
                            </div>
                        )}

                        {spawnError && (
                            <p className="text-xs text-destructive bg-destructive/10 px-3 py-2 rounded-md">{spawnError}</p>
                        )}
                    </div>

                    <DialogFooter>
                        <Button variant="ghost" onClick={() => setSpawnRunnerId(null)} disabled={spawning}>
                            Cancel
                        </Button>
                        <Button onClick={handleSpawn} disabled={spawning}>
                            {spawning ? (
                                <>
                                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                                    Starting…
                                </>
                            ) : (
                                <>
                                    <Plus className="mr-2 h-4 w-4" />
                                    Start Session
                                </>
                            )}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </>
    );
}

interface RunnerCardProps {
    runner: RunnerInfo;
    sessions: LiveSession[];
    isRestarting: boolean;
    isStopping: boolean;
    onRestart: () => void;
    onStop: () => void;
    onNewSession: () => void;
    onOpenSession?: (sessionId: string) => void;
    onSkillsChange?: (runnerId: string, skills: SkillInfo[]) => void;
}

function formatTime(iso: string): string {
    return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function RunnerCard({ runner, sessions, isRestarting, isStopping, onRestart, onStop, onNewSession, onOpenSession, onSkillsChange }: RunnerCardProps) {
    const [sessionsOpen, setSessionsOpen] = React.useState(true);

    return (
        <div className="group relative rounded-xl border border-border/60 bg-card hover:border-border transition-all duration-200 overflow-hidden">
            {/* Subtle top accent line */}
            <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-green-500/40 to-transparent" />

            <div className="p-3 sm:p-4">
                {/* Top row: name + status + actions */}
                <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-3 min-w-0">
                        {/* Online indicator dot */}
                        <div className="relative flex-shrink-0">
                            <div className="h-2.5 w-2.5 rounded-full bg-green-500 shadow-sm" />
                            <div className="absolute inset-0 h-2.5 w-2.5 rounded-full bg-green-500 animate-ping opacity-40" />
                        </div>
                        <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2">
                                <p className="font-semibold text-sm leading-none truncate">
                                    {runner.name || "Unnamed Runner"}
                                </p>
                            </div>
                            <p className="font-mono text-[10px] text-muted-foreground/60 mt-1 truncate">
                                {runner.runnerId}
                            </p>
                        </div>
                    </div>

                    <div className="flex items-center gap-1.5 flex-shrink-0">
                        <Button
                            variant="outline"
                            size="sm"
                            className="h-8 w-8 sm:w-auto px-0 sm:px-3 text-xs border-border/60 hover:border-border hover:bg-accent/50 transition-all shadow-sm"
                            onClick={onNewSession}
                            title="New Session"
                        >
                            <Plus className="h-4 w-4 sm:h-3.5 sm:w-3.5 sm:mr-1.5" />
                            <span className="hidden sm:inline">New Session</span>
                        </Button>
                        <Button
                            variant="outline"
                            size="sm"
                            className="h-8 w-8 sm:w-auto px-0 sm:px-3 text-xs border-border/60 hover:border-amber-500/40 hover:bg-amber-500/5 hover:text-amber-600 dark:hover:text-amber-400 transition-all"
                            onClick={onRestart}
                            disabled={isRestarting || isStopping}
                            title="Restart Runner"
                        >
                            {isRestarting ? (
                                <Loader2 className="h-3.5 w-3.5 animate-spin sm:mr-1.5" />
                            ) : (
                                <RefreshCw className="h-4 w-4 sm:h-3.5 sm:w-3.5 sm:mr-1.5" />
                            )}
                            <span className="hidden sm:inline">{isRestarting ? "Restarting…" : "Restart"}</span>
                        </Button>
                        <Button
                            variant="outline"
                            size="sm"
                            className="h-8 w-8 sm:w-auto px-0 sm:px-3 text-xs border-border/60 hover:border-red-500/40 hover:bg-red-500/5 hover:text-red-600 dark:hover:text-red-400 transition-all"
                            onClick={onStop}
                            disabled={isRestarting || isStopping}
                            title="Stop Runner"
                        >
                            {isStopping ? (
                                <Loader2 className="h-3.5 w-3.5 animate-spin sm:mr-1.5" />
                            ) : (
                                <Power className="h-4 w-4 sm:h-3.5 sm:w-3.5 sm:mr-1.5" />
                            )}
                            <span className="hidden sm:inline">{isStopping ? "Stopping…" : "Stop"}</span>
                        </Button>
                    </div>
                </div>

                {/* Divider */}
                <div className="my-3 border-t border-border/40" />

                {/* Stats row */}
                <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
                    <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                        <Hash className="h-3.5 w-3.5 opacity-60" />
                        <span>
                            <span className="font-medium text-foreground">{sessions.length}</span>
                            {" "}Active {sessions.length === 1 ? "Session" : "Sessions"}
                        </span>
                    </div>
                    <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                        <HardDrive className="h-3.5 w-3.5 opacity-60" />
                        <span>
                            <span className="font-medium text-foreground">{runner.roots.length}</span>
                            {" "}{runner.roots.length === 1 ? "Root" : "Roots"}
                        </span>
                    </div>
                </div>

                {/* Roots */}
                {runner.roots.length > 0 && (
                    <div className="mt-3 flex flex-wrap gap-1.5">
                        {runner.roots.map((root, i) => (
                            <span
                                key={i}
                                className="inline-flex items-center font-mono text-[10px] px-1.5 py-0.5 rounded-md bg-muted/60 border border-border/40 text-muted-foreground"
                            >
                                {root}
                            </span>
                        ))}
                    </div>
                )}

                {/* Sessions accordion */}
                {sessions.length > 0 && (
                    <div className="mt-3">
                        <Collapsible open={sessionsOpen} onOpenChange={setSessionsOpen}>
                            <CollapsibleTrigger className="flex items-center gap-1.5 w-full text-left group/trigger">
                                <span className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">
                                    Sessions
                                </span>
                                <ChevronDown
                                    className={cn(
                                        "h-3 w-3 text-muted-foreground/60 transition-transform duration-200",
                                        sessionsOpen && "rotate-180"
                                    )}
                                />
                            </CollapsibleTrigger>
                            <CollapsibleContent>
                                <div className="mt-2 flex flex-col gap-1.5">
                                    {sessions.map((session) => (
                                        <SessionRow
                                            key={session.sessionId}
                                            session={session}
                                            onOpen={onOpenSession}
                                        />
                                    ))}
                                </div>
                            </CollapsibleContent>
                        </Collapsible>
                    </div>
                )}

                {/* Skills manager */}
                <SkillsManager
                    runnerId={runner.runnerId}
                    skills={runner.skills}
                    onSkillsChange={(updated) => onSkillsChange?.(runner.runnerId, updated)}
                />
            </div>
        </div>
    );
}

interface SessionRowProps {
    session: LiveSession;
    onOpen?: (sessionId: string) => void;
}

function SessionRow({ session, onOpen }: SessionRowProps) {
    const time = formatTime(session.lastHeartbeatAt ?? session.startedAt);
    const label = session.sessionName?.trim() || `Session ${session.sessionId.slice(0, 8)}…`;
    const path = session.cwd ? formatPathTail(session.cwd, 2) : null;

    return (
        <button
            type="button"
            onClick={() => onOpen?.(session.sessionId)}
            disabled={!onOpen}
            className={cn(
                "flex items-center gap-3 w-full text-left px-3 py-2 rounded-lg border border-border/40 bg-muted/30 transition-colors",
                onOpen ? "hover:bg-muted/60 hover:border-border/70 cursor-pointer" : "cursor-default"
            )}
        >
            {/* Activity dot */}
            <span
                className={cn(
                    "flex-shrink-0 h-1.5 w-1.5 rounded-full",
                    session.isActive
                        ? "bg-blue-400 shadow-[0_0_5px_#60a5fa80] animate-pulse"
                        : "bg-green-500/70"
                )}
                title={session.isActive ? "Actively generating" : "Idle"}
            />

            {/* Label + path */}
            <div className="flex-1 min-w-0">
                <div className="flex items-baseline justify-between gap-2 min-w-0">
                    <span className="text-xs font-medium truncate">{label}</span>
                    <span className="text-[10px] text-muted-foreground/60 flex-shrink-0 flex items-center gap-1">
                        <Clock className="h-2.5 w-2.5" />
                        {time}
                    </span>
                </div>
                {path && (
                    <span className="flex items-center gap-1 text-[10px] text-muted-foreground/50 font-mono mt-0.5">
                        <Terminal className="h-2.5 w-2.5 opacity-60" />
                        {path}
                    </span>
                )}
            </div>

            {onOpen && (
                <ChevronDown className="h-3 w-3 text-muted-foreground/40 flex-shrink-0 -rotate-90" />
            )}
        </button>
    );
}
