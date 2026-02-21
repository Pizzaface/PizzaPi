import * as React from "react";
import { Resizable } from "react-resizable";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { getRelayWsBase } from "@/lib/relay";
import { ProviderIcon } from "@/components/ProviderIcon";
import { PanelLeftClose, PanelLeftOpen, Plus, User, X } from "lucide-react";

interface HubSession {
    sessionId: string;
    shareUrl: string;
    cwd: string;
    startedAt: string;
    viewerCount?: number;
    userId?: string;
    userName?: string;
    sessionName?: string | null;
    isEphemeral?: boolean;
    expiresAt?: string | null;
    isActive?: boolean;
    lastHeartbeatAt?: string | null;
    model?: { provider: string; id: string; name?: string } | null;
}

export interface SessionSidebarProps {
    onOpenSession: (sessionId: string) => void;
    onNewSession: () => void;
    onClearSelection: () => void;
    activeSessionId: string | null;
    /** Active model info for the currently selected session (used for provider indicator) */
    activeModel?: { provider: string; id: string; name?: string } | null;
    onRelayStatusChange?: (state: DotState) => void;
}

function formatRelativeDate(isoString: string): string {
    const date = new Date(isoString);
    const now = new Date();
    const diff = now.getTime() - date.getTime();
    const days = Math.floor(diff / (1000 * 60 * 60 * 24));
    if (days === 0) return "Today";
    if (days === 1) return "Yesterday";
    if (days < 7) return `${days} days ago`;
    return date.toLocaleDateString();
}

function isToday(isoString: string): boolean {
    const date = new Date(isoString);
    const now = new Date();
    return (
        date.getFullYear() === now.getFullYear() &&
        date.getMonth() === now.getMonth() &&
        date.getDate() === now.getDate()
    );
}

function formatTime(isoString: string): string {
    return new Date(isoString).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function cwdLabel(cwd: string): string {
    if (!cwd) return "Unknown node";
    const parts = cwd.replace(/\\/g, "/").split("/").filter(Boolean);
    return parts[parts.length - 1] || cwd;
}

/**
 * Group key for a session path.
 * - POSIX: "/srv/repos/foo" -> "/srv"
 * - Windows-ish: "C:/repo" -> "C:"
 */
function rootFolder(cwd: string): string {
    if (!cwd) return "Unknown";
    const normalized = cwd.replace(/\\/g, "/");
    const drive = normalized.match(/^[A-Za-z]:/);
    if (drive) return drive[0];
    if (normalized.startsWith("/")) {
        const parts = normalized.split("/").filter(Boolean);
        return parts.length > 0 ? `/${parts[0]}` : "/";
    }
    // Fallback: treat first segment as "root"
    return normalized.split("/").filter(Boolean)[0] ?? "Unknown";
}

function relativeToRoot(cwd: string, root: string): string {
    const normalized = cwd.replace(/\\/g, "/");
    const r = root.replace(/\\/g, "/");
    if (normalized === r) return ".";
    if (normalized.startsWith(r + "/")) return normalized.slice((r + "/").length);
    return normalized;
}

export type DotState = "connecting" | "connected" | "disconnected";

function LiveDot({ state }: { state: DotState }) {
    return (
        <span
            className={cn(
                "inline-block h-2 w-2 rounded-full flex-shrink-0 transition-colors",
                state === "connected" && "bg-green-500 shadow-[0_0_4px_#22c55e80]",
                state === "disconnected" && "bg-red-500",
                state === "connecting" && "bg-slate-400",
            )}
            title={state === "connected" ? "Connected" : state === "disconnected" ? "Disconnected" : "Connecting…"}
        />
    );
}

export const SessionSidebar = React.memo(function SessionSidebar({
    onOpenSession,
    onNewSession,
    onClearSelection,
    activeSessionId,
    activeModel,
    onRelayStatusChange,
}: SessionSidebarProps) {
    const [collapsed, setCollapsed] = React.useState(false);

    const [isDesktop, setIsDesktop] = React.useState(() => {
        if (typeof window === "undefined") return true;
        return window.matchMedia("(min-width: 768px)").matches;
    });

    React.useEffect(() => {
        if (typeof window === "undefined") return;
        const mql = window.matchMedia("(min-width: 768px)");
        const onChange = (evt: MediaQueryListEvent) => setIsDesktop(evt.matches);
        setIsDesktop(mql.matches);
        if ("addEventListener" in mql) mql.addEventListener("change", onChange);
        else (mql as any).addListener(onChange);
        return () => {
            if ("removeEventListener" in mql) mql.removeEventListener("change", onChange);
            else (mql as any).removeListener(onChange);
        };
    }, []);

    const effectiveCollapsed = isDesktop ? collapsed : false;

    // Desktop-only: allow resizing the sidebar width.
    const [sidebarWidth, setSidebarWidth] = React.useState(() => {
        if (typeof localStorage === "undefined") return 240;
        const raw = localStorage.getItem("pp.sidebarWidth");
        const n = raw ? Number(raw) : NaN;
        if (Number.isFinite(n)) return Math.min(Math.max(n, 220), 520);
        return 240;
    });

    React.useEffect(() => {
        if (!isDesktop) return;
        if (effectiveCollapsed) return;
        localStorage.setItem("pp.sidebarWidth", String(sidebarWidth));
    }, [sidebarWidth, effectiveCollapsed, isDesktop]);

    const [liveSessions, setLiveSessions] = React.useState<HubSession[]>([]);
    const [dotState, setDotState] = React.useState<DotState>("connecting");

    React.useEffect(() => {
        onRelayStatusChange?.(dotState);
    }, [dotState, onRelayStatusChange]);

    React.useEffect(() => {
        let ws: WebSocket | null = null;
        let retryDelay = 1000;
        let destroyed = false;

        function connect() {
            if (destroyed) return;
            try {
                ws = new WebSocket(`${getRelayWsBase()}/ws/hub`);

                ws.onopen = () => {
                    retryDelay = 1000;
                    setDotState("connected");
                };

                ws.onmessage = (evt) => {
                    let msg: Record<string, unknown>;
                    try { msg = JSON.parse(evt.data as string); } catch { return; }

                    if (msg.type === "sessions") {
                        setLiveSessions((msg.sessions as HubSession[]) ?? []);
                    } else if (msg.type === "session_added") {
                        const s = msg as unknown as HubSession;
                        setLiveSessions((prev) => {
                            if (prev.some((p) => p.sessionId === s.sessionId)) return prev;
                            return [
                                ...prev,
                                {
                                    sessionId: s.sessionId,
                                    shareUrl: s.shareUrl,
                                    cwd: s.cwd,
                                    startedAt: s.startedAt,
                                    userId: s.userId,
                                    userName: s.userName,
                                    sessionName: (s as any).sessionName ?? null,
                                    isEphemeral: s.isEphemeral,
                                    expiresAt: s.expiresAt,
                                    isActive: (s as any).isActive ?? false,
                                    lastHeartbeatAt: (s as any).lastHeartbeatAt ?? null,
                                    model: (s as any).model ?? null,
                                },
                            ];
                        });
                    } else if (msg.type === "session_removed") {
                        setLiveSessions((prev) => prev.filter((s) => s.sessionId !== msg.sessionId));
                    } else if (msg.type === "session_status") {
                        // Update active status (and model) from heartbeat notifications.
                        const { sessionId, isActive, lastHeartbeatAt, model, sessionName } = msg as {
                            sessionId: string;
                            isActive: boolean;
                            lastHeartbeatAt: string;
                            model?: { provider: string; id: string; name?: string } | null;
                            sessionName?: string | null;
                        };
                        setLiveSessions((prev) =>
                            prev.map((s) =>
                                s.sessionId === sessionId
                                    ? {
                                          ...s,
                                          isActive,
                                          lastHeartbeatAt,
                                          model: model === undefined ? (s.model ?? null) : model,
                                          sessionName: sessionName === undefined ? (s.sessionName ?? null) : sessionName,
                                      }
                                    : s,
                            ),
                        );
                    }
                };

                ws.onclose = () => {
                    setDotState("disconnected");
                    if (!destroyed) {
                        setTimeout(() => {
                            retryDelay = Math.min(retryDelay * 2, 30_000);
                            connect();
                        }, retryDelay);
                    }
                };
            } catch {
                setDotState("disconnected");
            }
        }

        connect();
        return () => {
            destroyed = true;
            ws?.close();
        };
    }, []);

    const liveGroups = React.useMemo(() => {
        const groups = new Map<string, HubSession[]>();
        for (const s of liveSessions) {
            const key = rootFolder(s.cwd || "");
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key)!.push(s);
        }

        // Sort sessions within each root by most recently active/started.
        for (const [k, sessions] of groups.entries()) {
            sessions.sort((a, b) => {
                const aT = Date.parse(a.lastHeartbeatAt ?? a.startedAt);
                const bT = Date.parse(b.lastHeartbeatAt ?? b.startedAt);
                return (Number.isFinite(bT) ? bT : 0) - (Number.isFinite(aT) ? aT : 0);
            });
            groups.set(k, sessions);
        }

        return new Map(Array.from(groups.entries()).sort(([a], [b]) => a.localeCompare(b)));
    }, [liveSessions]);

    const sidebarContent = (
        <aside
            className={cn(
                "flex flex-col h-full bg-sidebar border-r border-sidebar-border flex-shrink-0 overflow-hidden relative w-full",
            )}
        >
            <div className="flex items-center justify-between px-3 py-2 border-b border-sidebar-border flex-shrink-0">
                <Button
                    variant="ghost"
                    size="icon"
                    className="hidden md:inline-flex h-7 w-7 text-sidebar-foreground/60 hover:text-sidebar-foreground hover:bg-sidebar-accent"
                    onClick={() => setCollapsed(true)}
                    aria-label="Collapse sidebar"
                >
                    <PanelLeftClose className="h-4 w-4" />
                </Button>
                <span className="text-[0.7rem] font-semibold uppercase tracking-widest text-sidebar-foreground/60">
                    Sessions
                </span>
                <div className="flex items-center gap-1">
                    <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 text-sidebar-foreground/60 hover:text-sidebar-foreground hover:bg-sidebar-accent"
                        onClick={onNewSession}
                        aria-label="New session"
                        title="New session"
                    >
                        <Plus className="h-4 w-4" />
                    </Button>
                    <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 text-sidebar-foreground/60 hover:text-sidebar-foreground hover:bg-sidebar-accent"
                        onClick={onClearSelection}
                        aria-label="Clear selected session"
                        title="Clear selected session"
                    >
                        <X className="h-4 w-4" />
                    </Button>
                </div>
            </div>

            <div className="flex flex-col flex-1 min-h-0 overflow-hidden">
                <div className="flex items-center gap-1.5 px-3 py-1.5 flex-shrink-0">
                    <span className="text-[0.65rem] font-semibold uppercase tracking-widest text-sidebar-foreground/50">
                        Live Sessions
                    </span>
                    <LiveDot state={dotState} />
                </div>
                <ScrollArea className="flex-1 px-1.5 pb-1.5">
                    {liveGroups.size === 0 ? (
                        <p className="px-2 py-1 text-xs italic text-sidebar-foreground/40">No live sessions</p>
                    ) : (
                        Array.from(liveGroups.entries()).map(([root, sessions]) => (
                            <div key={root} className="flex flex-col">
                                <div className="flex items-center gap-1 px-1.5 py-1 min-w-0">
                                    <span className="text-[0.65rem] text-sidebar-primary/70">⬡</span>
                                    <span
                                        className="text-[0.65rem] font-semibold text-sidebar-foreground/55 truncate flex-1"
                                        title={root}
                                    >
                                        {root}
                                    </span>
                                </div>
                                {sessions.map((s) => (
                                    <button
                                        key={s.sessionId}
                                        onClick={() => onOpenSession(s.sessionId)}
                                        title={`View session ${s.sessionId}`}
                                        className={cn(
                                            "flex flex-col gap-0.5 w-full min-w-0 px-2 py-1.5 rounded-md text-left text-sidebar-foreground hover:bg-sidebar-accent transition-colors",
                                            activeSessionId === s.sessionId && "bg-sidebar-accent text-sidebar-accent-foreground",
                                        )}
                                    >
                                        <div className="flex items-center gap-2 justify-between mt-1 mr-2 flex-row min-w-0">
                                            <div className="flex flex-col items-center px-2 gap-1 w-3 flex-shrink-0 pt-0.5">
                                                <span
                                                    className={cn(
                                                        "inline-block h-1.5 w-1.5 rounded-full transition-colors",
                                                        s.isActive
                                                            ? "bg-blue-500 shadow-[0_0_4px_#3b82f680] animate-pulse"
                                                            : "bg-green-600",
                                                    )}
                                                    title={s.isActive ? "Actively generating" : "Session idle"}
                                                />
                                                <ProviderIcon
                                                    provider={
                                                        s.model?.provider ??
                                                        (activeSessionId === s.sessionId ? activeModel?.provider : undefined) ??
                                                        "unknown"
                                                    }
                                                    className="size-3 text-sidebar-foreground/70"
                                                    title={
                                                        s.model?.provider
                                                            ? `${s.model.provider} · ${s.model.name ?? s.model.id}`
                                                            : activeSessionId === s.sessionId && activeModel?.provider
                                                              ? `${activeModel.provider} · ${activeModel.name ?? activeModel.id}`
                                                              : "unknown"
                                                    }
                                                />
                                            </div>
                                            <div className="flex-1 min-w-0">
                                                <div className="truncate text-[0.78rem] font-medium">
                                                    {s.sessionName?.trim() || `Session ${s.sessionId.slice(0, 8)}…`}
                                                </div>
                                                {s.userName && (
                                                    <div className="flex items-center gap-1">
                                                        <User className="h-2.5 w-2.5 text-sidebar-foreground/40 flex-shrink-0" />
                                                        <span className="text-[0.65rem] text-sidebar-foreground/50 truncate">
                                                            {s.userName}
                                                        </span>
                                                    </div>
                                                )}
                                                {!!s.cwd && (
                                                    <div
                                                        className="text-[0.65rem] text-sidebar-foreground/40 truncate"
                                                        title={s.cwd}
                                                    >
                                                        {(() => {
                                                            const r = rootFolder(s.cwd);
                                                            return relativeToRoot(s.cwd, r);
                                                        })()}
                                                    </div>
                                                )}
                                            </div>
                                            <span className="text-[0.65rem] text-sidebar-foreground/50 flex-shrink-0">
                                                {isToday(s.startedAt)
                                                    ? formatTime(s.lastHeartbeatAt ?? s.startedAt)
                                                    : formatRelativeDate(s.startedAt)}
                                            </span>
                                        </div>
                                    </button>
                                ))}
                            </div>
                        ))
                    )}
                </ScrollArea>
            </div>
        </aside>
    );

    if (effectiveCollapsed) {
        return (
            <aside className="hidden md:flex flex-col h-full bg-sidebar border-r border-sidebar-border flex-shrink-0 w-10">
                <div className="p-2">
                    <Button
                        variant="outline"
                        size="icon"
                        className="h-8 w-8 shadow-sm"
                        onClick={() => setCollapsed(false)}
                        aria-label="Expand sidebar"
                    >
                        <PanelLeftOpen className="h-4 w-4" />
                    </Button>
                </div>
            </aside>
        );
    }

    if (isDesktop) {
        return (
            <Resizable
                width={sidebarWidth}
                height={0}
                axis="x"
                resizeHandles={["e"]}
                minConstraints={[220, 0]}
                maxConstraints={[520, 0]}
                onResize={(_, data) => setSidebarWidth(data.size.width)}
                onResizeStop={(_, data) => setSidebarWidth(data.size.width)}
                handle={(_, ref) => (
                    <div
                        ref={ref as any}
                        className="hidden md:block absolute top-0 right-0 h-full w-1.5 cursor-col-resize hover:bg-sidebar-border/60"
                        aria-label="Resize sidebar"
                        role="separator"
                    />
                )}
            >
                <div className="relative h-full flex-shrink-0" style={{ width: sidebarWidth }}>
                    {sidebarContent}
                </div>
            </Resizable>
        );
    }

    return sidebarContent;
});
