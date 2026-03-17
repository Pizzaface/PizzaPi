import * as React from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Plus, FolderOpen, Loader2, RefreshCw, X } from "lucide-react";
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
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorAlert } from "@/components/ui/error-alert";
import { RunnerDetailPanel } from "@/components/RunnerDetailPanel";
import type { SkillInfo } from "@/components/SkillsManager";
import type { AgentInfo } from "@/components/AgentsManager";
import type { PluginInfo } from "@/components/PluginsManager";

interface RunnerInfo {
    runnerId: string;
    name: string | null;
    roots: string[];
    sessionCount: number;
    skills: SkillInfo[];
    agents: AgentInfo[];
    plugins: PluginInfo[];
    version: string | null;
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
    onRunnersChange?: (runners: Array<{
        runnerId: string;
        name: string | null;
        sessionCount: number;
        version: string | null;
        isOnline: boolean;
    }>) => void;
    selectedRunnerId: string | null;
    onSelectRunner?: (runnerId: string) => void;
}

export function RunnerManager({ onOpenSession, onRunnersChange, selectedRunnerId, onSelectRunner }: RunnerManagerProps) {
    const [runners, setRunners] = React.useState<RunnerInfo[]>([]);
    const [sessions, setSessions] = React.useState<LiveSession[]>([]);
    const [loading, setLoading] = React.useState(true);
    const [latestVersion, setServerVersion] = React.useState<string | null>(null);
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
                    agents: Array.isArray(r.agents) ? r.agents : [],
                    plugins: Array.isArray(r.plugins) ? r.plugins : [],
                    version: r.version ?? null,
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

    // Fetch server version once
    React.useEffect(() => {
        fetch("/api/version")
            .then((res) => res.ok ? res.json() : null)
            .then((data) => { if (data?.version) setServerVersion(data.version); })
            .catch(() => {});
    }, []);

    // Fetch recent folders when a runner is selected in the spawn dialog
    React.useEffect(() => {
        if (!spawnRunnerId) {
            setRecentFolders([]);
            return;
        }
        // Clear stale folders immediately so chips from the previous runner
        // can't be deleted against the newly selected runner.
        setRecentFolders([]);
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

    // Auto-select when there's exactly one runner
    React.useEffect(() => {
        if (runners.length === 1 && selectedRunnerId !== runners[0].runnerId) {
            onSelectRunner?.(runners[0].runnerId);
        }
    }, [runners, selectedRunnerId, onSelectRunner]);

    // Notify parent of runner list changes
    React.useEffect(() => {
        onRunnersChange?.(runners.map(r => ({
            runnerId: r.runnerId,
            name: r.name,
            sessionCount: r.sessionCount,
            version: r.version,
            isOnline: true, // runners from API are always online
        })));
    }, [runners, onRunnersChange]);

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

    // Loading skeleton
    if (loading && runners.length === 0) {
        return (
            <div className="flex flex-col flex-1 p-6 gap-4 animate-in fade-in duration-700">
                <div className="flex items-center justify-between">
                    <div className="space-y-2">
                        <Skeleton className="h-6 w-48 rounded-md" />
                        <Skeleton className="h-3 w-72 rounded-md" />
                    </div>
                    <div className="flex gap-2">
                        <Skeleton className="h-8 w-28 rounded-md" />
                        <Skeleton className="h-8 w-8 rounded-md" />
                        <Skeleton className="h-8 w-8 rounded-md" />
                    </div>
                </div>
                <div className="flex gap-4 border-b border-border/40 pb-2">
                    {[80, 56, 64, 60, 64].map((w, i) => (
                        <Skeleton key={i} className="h-4 rounded-md" style={{ width: w }} />
                    ))}
                </div>
                <div className="flex flex-col gap-2">
                    {[1, 2, 3].map((i) => (
                        <Skeleton key={i} className="h-16 w-full rounded-lg" />
                    ))}
                </div>
            </div>
        );
    }

    const selectedRunner = runners.find(r => r.runnerId === selectedRunnerId) ?? null;
    const runnerSessions = sessions.filter(s => s.runnerId === selectedRunnerId);

    return (
        <>
            <RunnerDetailPanel
                runner={selectedRunner}
                hasRunners={runners.length > 0}
                sessions={runnerSessions}
                latestVersion={latestVersion}
                isRestarting={restarting.has(selectedRunnerId ?? "")}
                isStopping={stopping.has(selectedRunnerId ?? "")}
                isOffline={!selectedRunner}
                onRestart={() => selectedRunnerId && handleRestart(selectedRunnerId)}
                onStop={() => selectedRunnerId && handleStop(selectedRunnerId)}
                onNewSession={() => selectedRunnerId && handleOpenNewSession(selectedRunnerId)}
                onOpenSession={onOpenSession}
                onSkillsChange={(rid, skills) => setRunners(prev => prev.map(r => r.runnerId === rid ? { ...r, skills } : r))}
                onAgentsChange={(rid, agents) => setRunners(prev => prev.map(r => r.runnerId === rid ? { ...r, agents } : r))}
            />

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

                    <div className="flex flex-col gap-4 py-2 min-w-0 overflow-hidden">
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
                            <div className="flex flex-col gap-1.5 min-w-0">
                                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Recent folders</p>
                                {recentFoldersLoading ? (
                                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                                        <Loader2 className="h-3 w-3 animate-spin" />
                                        Loading…
                                    </div>
                                ) : (
                                    <div className="flex flex-col gap-1 min-w-0">
                                        {recentFolders.map((folder) => (
                                            <div
                                                key={folder}
                                                className={cn(
                                                    "flex items-center gap-2 text-left px-2.5 py-1.5 rounded-md text-xs font-mono transition-colors min-w-0 group",
                                                    spawnCwd === folder
                                                        ? "bg-accent text-accent-foreground"
                                                        : "text-muted-foreground hover:bg-muted hover:text-foreground"
                                                )}
                                            >
                                                <button
                                                    type="button"
                                                    onClick={() => setSpawnCwd(folder)}
                                                    className="flex items-center gap-2 min-w-0 flex-1"
                                                    title={folder}
                                                >
                                                    <FolderOpen className="h-3.5 w-3.5 flex-shrink-0 opacity-60" />
                                                    <span className="truncate">{folder.split("/").filter(Boolean).pop() || folder}</span>
                                                </button>
                                                <button
                                                    type="button"
                                                    onClick={async (e) => {
                                                        e.stopPropagation();
                                                        const targetRunner = spawnRunnerId;
                                                        if (targetRunner) {
                                                            await fetch(`/api/runners/${encodeURIComponent(targetRunner)}/recent-folders`, {
                                                                method: "DELETE",
                                                                credentials: "include",
                                                                headers: { "Content-Type": "application/json" },
                                                                body: JSON.stringify({ path: folder }),
                                                            });
                                                        }
                                                        // Only update local state if the runner hasn't changed during the request
                                                        if (spawnRunnerId === targetRunner) {
                                                            setRecentFolders((prev) => prev.filter((f) => f !== folder));
                                                        }
                                                    }}
                                                    className="flex-shrink-0 opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive transition-opacity"
                                                    title="Remove from recent"
                                                >
                                                    <X className="h-3 w-3" />
                                                </button>
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </div>
                        )}

                        {spawnError && (
                            <ErrorAlert>{spawnError}</ErrorAlert>
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
