import * as React from "react";
import { useState, useEffect, Suspense } from "react";
import { Button } from "@/components/ui/button";
import {
    Tooltip,
    TooltipContent,
    TooltipProvider,
    TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { syncedPulse } from "@/lib/synced-animation";
import { formatPathTail } from "@/lib/path";
import { SkillsManager, type SkillInfo } from "@/components/SkillsManager";
import { AgentsManager, type AgentInfo } from "@/components/AgentsManager";
import { PluginsManager, type PluginInfo } from "@/components/PluginsManager";
import { SandboxManager } from "@/components/SandboxManager";
const UsageDashboard = React.lazy(() =>
    import("@/components/usage-dashboard/UsageDashboard").then((m) => ({
        default: m.UsageDashboard,
    }))
);
import {
    Plus,
    RefreshCw,
    Power,
    Loader2,
    AlertTriangle,
    Clock,
    Terminal,
    ChevronRight,
    Server,
    Webhook,
} from "lucide-react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RunnerTab = "sessions" | "skills" | "agents" | "plugins" | "sandbox" | "hooks" | "usage";

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

export interface RunnerDetailPanelProps {
    runner: RunnerInfo | null;
    hasRunners: boolean;
    sessions: LiveSession[];
    latestVersion: string | null;
    isRestarting: boolean;
    isStopping: boolean;
    isOffline?: boolean;
    onRestart: () => void;
    onStop: () => void;
    onNewSession: () => void;
    onOpenSession?: (sessionId: string) => void;
    onSkillsChange?: (runnerId: string, skills: SkillInfo[]) => void;
    onAgentsChange?: (runnerId: string, agents: AgentInfo[]) => void;
    onPluginsChange?: (runnerId: string, plugins: PluginInfo[]) => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function semverLt(a: string, b: string): boolean {
    const parse = (v: string) => {
        const clean = v.replace(/^v/, "");
        const [core, pre] = clean.split("-", 2);
        return { parts: core.split(".").map(Number), pre: pre ?? null };
    };
    const pa = parse(a),
        pb = parse(b);
    for (let i = 0; i < Math.max(pa.parts.length, pb.parts.length); i++) {
        const na = pa.parts[i] ?? 0,
            nb = pb.parts[i] ?? 0;
        if (isNaN(na) || isNaN(nb)) return false;
        if (na < nb) return true;
        if (na > nb) return false;
    }
    if (pa.pre !== null && pb.pre === null) return true;
    return false;
}

function formatTime(iso: string): string {
    return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

// ---------------------------------------------------------------------------
// SessionsList (local)
// ---------------------------------------------------------------------------

function SessionsList({
    sessions,
    onOpenSession,
}: {
    sessions: LiveSession[];
    onOpenSession?: (sessionId: string) => void;
}) {
    if (sessions.length === 0) {
        return (
            <p className="text-center text-xs text-muted-foreground py-8">No sessions</p>
        );
    }

    return (
        <div className="flex flex-col gap-1.5">
            {sessions.map((session) => {
                const active = session.isActive;
                return (
                    <button
                        key={session.sessionId}
                        type="button"
                        onClick={() => onOpenSession?.(session.sessionId)}
                        className={cn(
                            "flex items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors hover:bg-accent/40",
                            active
                                ? "bg-blue-500/[0.04] border-blue-500/[0.12]"
                                : "bg-white/[0.02] border-white/[0.06]",
                        )}
                    >
                        {/* Activity dot */}
                        <span
                            className={cn(
                                "h-2 w-2 shrink-0 rounded-full",
                                active
                                    ? "bg-blue-400 shadow-[0_0_5px_#60a5fa80] animate-pulse"
                                    : "bg-green-500/70",
                            )}
                            style={active ? syncedPulse() : undefined}
                        />

                        {/* Name + cwd */}
                        <div className="flex flex-col gap-0.5 min-w-0 flex-1">
                            <span className="text-sm font-medium truncate">
                                {session.sessionName ?? `Session ${session.sessionId.slice(0, 8)}…`}
                            </span>
                            <span className="text-[10px] font-mono text-muted-foreground truncate">
                                {formatPathTail(session.cwd, 2)}
                            </span>
                        </div>

                        {/* Status badge */}
                        <span
                            className={cn(
                                "text-[9px] px-1.5 py-0.5 rounded-full shrink-0",
                                active
                                    ? "bg-blue-500/12 text-blue-300"
                                    : "bg-green-500/8 text-green-300",
                            )}
                        >
                            {active ? "active" : "idle"}
                        </span>

                        {/* Timestamp */}
                        <span className="text-[10px] text-muted-foreground shrink-0">
                            {formatTime(session.lastHeartbeatAt ?? session.startedAt)}
                        </span>

                        {/* Chevron */}
                        <ChevronRight className="h-3 w-3 text-muted-foreground shrink-0" />
                    </button>
                );
            })}
        </div>
    );
}

// ---------------------------------------------------------------------------
// HooksList
// ---------------------------------------------------------------------------

function HooksList({ hooks }: { hooks?: RunnerHook[] }) {
    if (!hooks || hooks.length === 0) {
        return (
            <div className="flex flex-col items-center justify-center py-10 gap-3 text-center">
                <div className="rounded-full bg-muted p-3">
                    <Webhook className="h-5 w-5 text-muted-foreground" />
                </div>
                <div className="space-y-1">
                    <p className="text-sm font-medium text-muted-foreground">No active hooks</p>
                    <p className="text-xs text-muted-foreground/60 max-w-xs">
                        Configure hooks in{" "}
                        <code className="font-mono bg-muted px-1 py-0.5 rounded text-[11px]">
                            ~/.pizzapi/config.json
                        </code>{" "}
                        under the <code className="font-mono bg-muted px-1 py-0.5 rounded text-[11px]">hooks</code> key.
                    </p>
                </div>
            </div>
        );
    }

    return (
        <div className="flex flex-col gap-2">
            <p className="text-[11px] text-muted-foreground/50 px-1">
                Global hooks only — project-local hooks vary per session working directory.
            </p>
            {hooks.map((hook) => (
                <div
                    key={hook.type}
                    className="flex flex-col gap-1.5 rounded-lg border border-border/40 bg-muted/20 px-3 py-2.5"
                >
                    {/* Hook type badge */}
                    <div className="flex items-center gap-2">
                        <span className="inline-flex items-center gap-1 text-[10px] font-mono font-semibold px-1.5 py-0.5 rounded bg-blue-500/10 border border-blue-500/20 text-blue-300">
                            <Webhook className="h-2.5 w-2.5" />
                            {hook.type}
                        </span>
                    </div>

                    {/* Script names */}
                    <div className="flex flex-wrap gap-1.5 pl-0.5">
                        {hook.scripts.map((script, i) => (
                            <span
                                key={i}
                                className="text-[11px] font-mono bg-muted/60 px-2 py-0.5 rounded border border-border/30 text-muted-foreground"
                            >
                                {script}
                            </span>
                        ))}
                    </div>
                </div>
            ))}
        </div>
    );
}

// ---------------------------------------------------------------------------
// TabBar
// ---------------------------------------------------------------------------

const TABS: { key: RunnerTab; label: string; countKey?: "skills" | "agents" | "plugins" | "hooks" }[] = [
    { key: "sessions", label: "Sessions" },
    { key: "skills", label: "Skills", countKey: "skills" },
    { key: "agents", label: "Agents", countKey: "agents" },
    { key: "plugins", label: "Plugins", countKey: "plugins" },
    { key: "hooks", label: "Hooks", countKey: "hooks" },
    { key: "usage", label: "Usage" },
    { key: "sandbox", label: "Sandbox" },
];

function TabBar({
    activeTab,
    onTabChange,
    runner,
}: {
    activeTab: RunnerTab;
    onTabChange: (tab: RunnerTab) => void;
    runner: RunnerInfo;
}) {
    return (
        <div className="overflow-x-auto -mx-4 sm:-mx-6 px-4 sm:px-6">
            <div className="flex gap-1 border-b border-border/40 min-w-max">
                {TABS.map((tab) => {
                    const isActive = activeTab === tab.key;
                    const countSource = tab.countKey ? runner[tab.countKey] : null;
                    const count = countSource != null ? (Array.isArray(countSource) ? countSource.length : 0) : null;
                    return (
                        <button
                            key={tab.key}
                            type="button"
                            onClick={() => onTabChange(tab.key)}
                            className={cn(
                                "px-3 py-2 text-xs font-medium transition-all flex items-center gap-1.5 whitespace-nowrap shrink-0",
                                isActive
                                    ? "border-b-2 border-blue-500 text-blue-300"
                                    : "opacity-40 hover:opacity-70",
                            )}
                        >
                            {tab.label}
                            {count !== null && (
                                <span className="text-[9px] font-mono bg-muted/60 px-1.5 py-0.5 rounded-full">
                                    {count}
                                </span>
                            )}
                        </button>
                    );
                })}
            </div>
        </div>
    );
}

// ---------------------------------------------------------------------------
// RunnerDetailPanel
// ---------------------------------------------------------------------------

export function RunnerDetailPanel({
    runner,
    hasRunners,
    sessions,
    latestVersion,
    isRestarting,
    isStopping,
    isOffline,
    onRestart,
    onStop,
    onNewSession,
    onOpenSession,
    onSkillsChange,
    onAgentsChange,
    onPluginsChange,
}: RunnerDetailPanelProps) {
    const [activeTab, setActiveTab] = useState<RunnerTab>("sessions");

    // Reset tab when runner changes
    useEffect(() => {
        setActiveTab("sessions");
    }, [runner?.runnerId]);

    // ---- Empty states ----

    if (!hasRunners) {
        return (
            <div className="flex flex-col flex-1 p-4 sm:p-6 overflow-y-auto items-center justify-center">
                <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border/60 py-10 px-4 sm:py-16 sm:px-8 gap-4 text-center bg-muted/20">
                    <div className="rounded-full bg-muted p-3">
                        <Server className="h-6 w-6 text-muted-foreground" />
                    </div>
                    <div className="space-y-1">
                        <p className="text-sm font-medium">No active runners</p>
                        <p className="text-xs text-muted-foreground max-w-xs">
                            Connect a runner by running{" "}
                            <code className="font-mono bg-muted px-1 py-0.5 rounded text-[11px]">
                                pizzapi runner
                            </code>{" "}
                            on your machine.
                        </p>
                    </div>
                </div>
            </div>
        );
    }

    if (!runner) {
        return (
            <div className="flex flex-col flex-1 p-4 sm:p-6 overflow-y-auto items-center justify-center">
                <p className="text-sm text-muted-foreground">Select a runner from the sidebar.</p>
            </div>
        );
    }

    // ---- Version info ----

    const outdated =
        runner.version && latestVersion ? semverLt(runner.version, latestVersion) : false;
    const actionsDisabled = !!isOffline || isRestarting || isStopping;

    // ---- Tab content ----

    let tabContent: React.ReactNode;
    switch (activeTab) {
        case "sessions":
            tabContent = <SessionsList sessions={sessions} onOpenSession={onOpenSession} />;
            break;
        case "skills":
            tabContent = (
                <SkillsManager
                    runnerId={runner.runnerId}
                    skills={runner.skills}
                    onSkillsChange={(s) => onSkillsChange?.(runner.runnerId, s)}
                    bare
                />
            );
            break;
        case "agents":
            tabContent = (
                <AgentsManager
                    runnerId={runner.runnerId}
                    agents={runner.agents}
                    onAgentsChange={(a) => onAgentsChange?.(runner.runnerId, a)}
                    bare
                />
            );
            break;
        case "plugins":
            tabContent = (
                <PluginsManager
                    runnerId={runner.runnerId}
                    plugins={runner.plugins}
                    onPluginsChange={(p) => onPluginsChange?.(runner.runnerId, p)}
                    bare
                />
            );
            break;
        case "hooks":
            tabContent = <HooksList hooks={runner.hooks} />;
            break;
        case "usage":
            tabContent = (
                <Suspense
                    fallback={
                        <div className="flex items-center justify-center p-8">
                            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                            <span className="ml-2 text-muted-foreground">Loading usage dashboard...</span>
                        </div>
                    }
                >
                    <UsageDashboard runnerId={runner.runnerId} />
                </Suspense>
            );
            break;
        case "sandbox":
            tabContent = <SandboxManager runnerId={runner.runnerId} bare />;
            break;
    }

    return (
        <div className="flex flex-col flex-1 overflow-hidden">
            {/* ---- Sticky header + tabs (never scrolls away on mobile) ---- */}
            <div className="shrink-0 px-4 sm:px-6 pt-4 sm:pt-6">
                {/* ---- Header ---- */}
                <div className="flex flex-col gap-1 mb-4">
                    {/* Row 1 */}
                    <div className="flex items-center justify-between gap-3">
                        {/* Left: name + version */}
                        <div className="flex items-center gap-2 min-w-0 flex-wrap">
                            <h2 className="text-lg font-semibold truncate">
                                {runner.name ?? runner.runnerId}
                            </h2>

                            {runner.version && (
                                <span
                                    className={cn(
                                        "inline-flex items-center text-[10px] font-mono px-1.5 py-0.5 rounded-full border",
                                        outdated
                                            ? "bg-amber-500/10 border-amber-500/40 text-amber-600 dark:text-amber-400"
                                            : "bg-muted/60 border-border/40 text-muted-foreground",
                                    )}
                                >
                                    {outdated && <AlertTriangle className="h-2.5 w-2.5 mr-1" />}
                                    v{runner.version.replace(/^v/, "")}
                                </span>
                            )}

                            {outdated && latestVersion && (
                                <span className="text-[10px] text-amber-600 dark:text-amber-400">
                                    Update available (v{latestVersion.replace(/^v/, "")})
                                </span>
                            )}
                        </div>

                        {/* Right: actions */}
                        <div className="flex items-center gap-1.5 shrink-0">
                            <Button
                                variant="outline"
                                size="sm"
                                onClick={onNewSession}
                                disabled={actionsDisabled}
                            >
                                <Plus className="h-3.5 w-3.5 mr-1" />
                                New Session
                            </Button>
                            <TooltipProvider>
                                <Tooltip>
                                    <TooltipTrigger asChild>
                                        <Button
                                            variant="ghost"
                                            size="icon"
                                            className="h-8 w-8"
                                            onClick={onRestart}
                                            disabled={actionsDisabled}
                                            aria-label="Restart runner"
                                        >
                                            {isRestarting ? (
                                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                            ) : (
                                                <RefreshCw className="h-3.5 w-3.5" />
                                            )}
                                        </Button>
                                    </TooltipTrigger>
                                    <TooltipContent>Restart runner</TooltipContent>
                                </Tooltip>
                            </TooltipProvider>
                            <TooltipProvider>
                                <Tooltip>
                                    <TooltipTrigger asChild>
                                        <Button
                                            variant="ghost"
                                            size="icon"
                                            className="h-8 w-8"
                                            onClick={onStop}
                                            disabled={actionsDisabled}
                                            aria-label="Stop runner"
                                        >
                                            {isStopping ? (
                                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                            ) : (
                                                <Power className="h-3.5 w-3.5" />
                                            )}
                                        </Button>
                                    </TooltipTrigger>
                                    <TooltipContent>Stop runner</TooltipContent>
                                </Tooltip>
                            </TooltipProvider>
                        </div>
                    </div>

                    {/* Row 2: runner ID */}
                    <span className="text-[10px] font-mono text-muted-foreground/35">
                        {runner.runnerId}
                    </span>
                </div>

                {/* ---- Tabs ---- */}
                <TabBar activeTab={activeTab} onTabChange={setActiveTab} runner={runner} />
            </div>

            {/* ---- Tab Content (only this area scrolls) ---- */}
            <div className="flex-1 overflow-y-auto px-4 sm:px-6 pb-4 sm:pb-6">
                <div className="mt-4">{tabContent}</div>
            </div>
        </div>
    );
}
