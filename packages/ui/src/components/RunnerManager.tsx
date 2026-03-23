import * as React from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { RunnerDetailPanel } from "@/components/RunnerDetailPanel";
import { NewSessionWizardDialog } from "@/components/NewSessionWizardDialog";
import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { ErrorAlert } from "@/components/ui/error-alert";
import type { HubSession } from "@/components/SessionSidebar";
import type { RunnerInfo } from "@pizzapi/protocol";
import { mapUserError } from "@/lib/user-error-message";

export interface RunnerManagerProps {
    /** Runner list from the /runners WS feed — passed from App.tsx (single hook instance) */
    runners: RunnerInfo[];
    /** Connection status of the /runners feed */
    runnersStatus: "connecting" | "connected" | "disconnected";
    /** Live sessions from the /hub feed — used for spawn-wait, per-runner counts, and RunnerDetailPanel */
    sessions: HubSession[];
    onOpenSession?: (sessionId: string) => void;
    selectedRunnerId: string | null;
    onSelectRunner?: (runnerId: string) => void;
}

export function RunnerManager({
    runners,
    runnersStatus,
    sessions,
    onOpenSession,
    selectedRunnerId,
    onSelectRunner,
}: RunnerManagerProps) {
    const loading = runnersStatus === "connecting" && runners.length === 0;

    const [restarting, setRestarting] = React.useState<Set<string>>(new Set());
    const [stopping, setStopping] = React.useState<Set<string>>(new Set());
    const [latestVersion, setLatestVersion] = React.useState<string | null>(null);

    // Error state for inline error display
    const [error, setError] = React.useState<string | null>(null);

    // Stop confirmation dialog state
    const [stopConfirmRunnerId, setStopConfirmRunnerId] = React.useState<string | null>(null);

    // Fetch the latest available version from the server (used by RunnerDetailPanel for update-available badge)
    React.useEffect(() => {
        fetch("/api/version")
            .then((res) => res.ok ? res.json() : null)
            .then((data) => { if (data?.version) setLatestVersion(data.version); })
            .catch(() => {});
    }, []);

    // Auto-dismiss error after 5 seconds
    React.useEffect(() => {
        if (!error) return;
        const timer = setTimeout(() => setError(null), 5000);
        return () => clearTimeout(timer);
    }, [error]);

    // New session dialog
    const [spawnRunnerId, setSpawnRunnerId] = React.useState<string | null>(null);

    // Pending spawn: wait for session to appear in WS feed
    const [pendingSessionId, setPendingSessionId] = React.useState<string | null>(null);

    // Resolve pending spawn: when the spawned session appears in sessions, open it
    React.useEffect(() => {
        if (!pendingSessionId) return;
        const found = sessions.some(s => s.sessionId === pendingSessionId);
        if (found) {
            const id = pendingSessionId;
            setPendingSessionId(null);
            onOpenSession?.(id);
        }
    }, [pendingSessionId, sessions, onOpenSession]);

    // 30-second timeout guard: clear pendingSessionId if session never appears
    React.useEffect(() => {
        if (!pendingSessionId) return;
        const timer = setTimeout(() => setPendingSessionId(null), 30_000);
        return () => clearTimeout(timer);
    }, [pendingSessionId]);

    // Auto-select when there's exactly one runner
    React.useEffect(() => {
        if (runners.length === 1 && selectedRunnerId !== runners[0].runnerId) {
            onSelectRunner?.(runners[0].runnerId);
        }
    }, [runners, selectedRunnerId, onSelectRunner]);

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
                const data = await res.json().catch(() => null) as { error?: string } | null;
                const mapped = mapUserError({
                    error: data?.error,
                    statusCode: res.status,
                    context: "runner_restart",
                });
                console.error("Failed to restart runner:", mapped.technicalMessage, data);
                setError(mapped.userMessage);
            }
        } catch (err) {
            const mapped = mapUserError({
                error: err,
                context: "runner_restart",
            });
            console.error("Failed to restart runner:", err);
            setError(mapped.userMessage);
        } finally {
            setTimeout(() => {
                setRestarting((prev) => {
                    const next = new Set(prev);
                    next.delete(runnerId);
                    return next;
                });
            }, 2000);
        }
    };

    const handleStopRequest = (runnerId: string) => {
        setStopConfirmRunnerId(runnerId);
    };

    const handleStopConfirm = async () => {
        const runnerId = stopConfirmRunnerId;
        setStopConfirmRunnerId(null);
        if (!runnerId) return;

        setStopping((prev) => new Set(prev).add(runnerId));
        try {
            const res = await fetch("/api/runners/stop", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ runnerId }),
                credentials: "include",
            });
            if (!res.ok) {
                const data = await res.json().catch(() => null) as { error?: string } | null;
                const mapped = mapUserError({
                    error: data?.error,
                    statusCode: res.status,
                    context: "runner_stop",
                });
                console.error("Failed to stop runner:", mapped.technicalMessage, data);
                setError(mapped.userMessage);
            }
        } catch (err) {
            const mapped = mapUserError({
                error: err,
                context: "runner_stop",
            });
            console.error("Failed to stop runner:", err);
            setError(mapped.userMessage);
        } finally {
            setTimeout(() => {
                setStopping((prev) => {
                    const next = new Set(prev);
                    next.delete(runnerId);
                    return next;
                });
            }, 3000);
        }
    };

    const handleOpenNewSession = (runnerId: string) => {
        setSpawnRunnerId(runnerId);
    };

    const handleWizardSpawn = async (runnerId: string, cwd: string | undefined, workerType: "pi" | "claude-code" = "pi") => {
        const res = await fetch("/api/runners/spawn", {
            method: "POST",
            credentials: "include",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ runnerId, ...(cwd ? { cwd } : {}), ...(workerType !== "pi" ? { workerType } : {}) }),
        });
        const body = await res.json().catch(() => null) as { error?: string; sessionId?: string } | null;
        if (!res.ok) {
            const mapped = mapUserError({
                error: body?.error,
                statusCode: res.status,
                context: "session_spawn",
            });
            console.error("Failed to spawn session:", mapped.technicalMessage, body);
            throw new Error(mapped.userMessage);
        }
        const sessionId = body?.sessionId;
        if (!sessionId) {
            const mapped = mapUserError({
                error: "Spawn failed: missing sessionId in response",
                context: "session_spawn",
            });
            console.error("Failed to spawn session:", mapped.technicalMessage, body);
            throw new Error(mapped.userMessage);
        }

        setSpawnRunnerId(null);
        setPendingSessionId(sessionId);
    };

    // Loading skeleton
    if (loading) {
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

    // Map protocol RunnerInfo → RunnerDetailPanel's local RunnerInfo shape
    // (protocol has some optional fields that RunnerDetailPanel expects as required)
    const selectedRunnerRaw = runners.find(r => r.runnerId === selectedRunnerId);
    const selectedRunner = selectedRunnerRaw ? {
        runnerId: selectedRunnerRaw.runnerId,
        name: selectedRunnerRaw.name,
        roots: selectedRunnerRaw.roots,
        sessionCount: sessions.filter(s => s.runnerId === selectedRunnerRaw.runnerId).length,
        skills: selectedRunnerRaw.skills,
        agents: selectedRunnerRaw.agents,
        plugins: (selectedRunnerRaw.plugins ?? []).map(p => ({
            ...p,
            rules: p.rules ?? [],
        })),
        hooks: selectedRunnerRaw.hooks,
        version: selectedRunnerRaw.version,
    } : null;

    // Map HubSession → LiveSession shape expected by RunnerDetailPanel
    const runnerSessions = sessions
        .filter(s => s.runnerId === selectedRunnerId)
        .map(s => ({
            sessionId: s.sessionId,
            shareUrl: s.shareUrl ?? "",
            cwd: s.cwd ?? "",
            startedAt: s.startedAt ?? "",
            sessionName: s.sessionName ?? null,
            isActive: s.isActive ?? false,
            lastHeartbeatAt: s.lastHeartbeatAt ?? null,
            runnerId: s.runnerId ?? null,
            runnerName: s.runnerName ?? null,
        }));

    // latestVersion is fetched from /api/version above — it represents the latest npm release,
    // not the runner's own version. This allows RunnerDetailPanel to show an "update available" badge
    // when the runner's version is older than the latest available version.

    return (
        <>
            {/* Inline error banner — auto-dismisses after 5 seconds */}
            {error && (
                <div className="px-4 pt-3">
                    <ErrorAlert>{error}</ErrorAlert>
                </div>
            )}

            <RunnerDetailPanel
                runner={selectedRunner}
                hasRunners={runners.length > 0}
                sessions={runnerSessions}
                latestVersion={latestVersion}
                isRestarting={restarting.has(selectedRunnerId ?? "")}
                isStopping={stopping.has(selectedRunnerId ?? "")}
                isOffline={!selectedRunner}
                onRestart={() => selectedRunnerId && handleRestart(selectedRunnerId)}
                onStop={() => selectedRunnerId && handleStopRequest(selectedRunnerId)}
                onNewSession={() => selectedRunnerId && handleOpenNewSession(selectedRunnerId)}
                onOpenSession={onOpenSession}
                onSkillsChange={() => {}}
                onAgentsChange={() => {}}
                onPluginsChange={() => {}}
            />

            {/* New session dialog */}
            <NewSessionWizardDialog
                open={spawnRunnerId !== null}
                onOpenChange={(open) => { if (!open) setSpawnRunnerId(null); }}
                runners={runners.map((r) => ({
                    runnerId: r.runnerId,
                    name: r.name ?? null,
                    roots: r.roots,
                    sessionCount: sessions.filter(s => s.runnerId === r.runnerId).length,
                    platform: r.platform ?? null,
                    isOnline: true,
                }))}
                preselectedRunnerId={spawnRunnerId}
                onSpawn={handleWizardSpawn}
            />

            {/* Stop runner confirmation dialog */}
            <AlertDialog
                open={stopConfirmRunnerId !== null}
                onOpenChange={(open) => { if (!open) setStopConfirmRunnerId(null); }}
            >
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>Stop runner?</AlertDialogTitle>
                        <AlertDialogDescription>
                            This runner will shut down completely and won&apos;t restart automatically.
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction onClick={handleStopConfirm}>Stop runner</AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </>
    );
}
