import * as React from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Plus, Loader2, RefreshCw } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { RunnerDetailPanel } from "@/components/RunnerDetailPanel";
import { NewSessionWizardDialog } from "@/components/NewSessionWizardDialog";
import type { SkillInfo } from "@/components/SkillsManager";
import type { AgentInfo } from "@/components/AgentsManager";
import type { PluginInfo } from "@/components/PluginsManager";

interface RunnerHook {
    type: string;
    scripts: string[];
}

interface RunnerInfo {
    runnerId: string;
    name: string | null;
    roots: string[];
    sessionCount: number;
    skills: SkillInfo[];
    agents: AgentInfo[];
    plugins: PluginInfo[];
    hooks?: RunnerHook[];
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
                    hooks: Array.isArray(r.hooks) ? r.hooks : [],
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
    };

    const handleWizardSpawn = async (runnerId: string, cwd: string | undefined) => {
        const res = await fetch("/api/runners/spawn", {
            method: "POST",
            credentials: "include",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ runnerId, ...(cwd ? { cwd } : {}) }),
        });
        const body = await res.json().catch(() => null) as any;
        if (!res.ok) {
            throw new Error(body?.error || `Spawn failed (HTTP ${res.status})`);
        }
        const sessionId = body?.sessionId;
        if (!sessionId) throw new Error("Spawn failed: missing sessionId in response");

        setSpawnRunnerId(null);

        if (onOpenSession) {
            const deadline = Date.now() + 30_000;
            const poll = async (): Promise<void> => {
                if (Date.now() > deadline) return;
                try {
                    const r = await fetch("/api/sessions", { credentials: "include" });
                    if (r.ok) {
                        const d = await r.json().catch(() => null) as any;
                        const live = Array.isArray(d?.sessions) && d.sessions.some((s: any) => s?.sessionId === sessionId);
                        if (live) { onOpenSession(sessionId); return; }
                    }
                } catch {}
                await new Promise((r) => setTimeout(r, 1000));
                return poll();
            };
            void poll();
        }
        fetchData();
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
                onPluginsChange={(rid, plugins) => setRunners(prev => prev.map(r => r.runnerId === rid ? { ...r, plugins } : r))}
            />

            {/* New session dialog */}
            <NewSessionWizardDialog
                open={spawnRunnerId !== null}
                onOpenChange={(open) => { if (!open) setSpawnRunnerId(null); }}
                runners={runners.map((r) => ({ ...r, isOnline: true }))}
                preselectedRunnerId={spawnRunnerId}
                onSpawn={handleWizardSpawn}
            />
        </>
    );
}
