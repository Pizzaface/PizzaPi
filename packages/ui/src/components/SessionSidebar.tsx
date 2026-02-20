import * as React from "react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { getRelayWsBase } from "@/lib/relay";
import { PanelLeftClose, PanelLeftOpen, Plus, User } from "lucide-react";

interface HubSession {
    sessionId: string;
    shareUrl: string;
    cwd: string;
    startedAt: string;
    viewerCount?: number;
    userId?: string;
    userName?: string;
    isEphemeral?: boolean;
    expiresAt?: string | null;
    isActive?: boolean;
    lastHeartbeatAt?: string | null;
}

interface PersistedSessionSummary {
    sessionId: string;
    cwd: string;
    shareUrl: string;
    startedAt: string;
    lastActiveAt: string;
    endedAt: string | null;
    isEphemeral: boolean;
    expiresAt: string | null;
}

interface SessionsApiResponse {
    sessions?: HubSession[];
    persistedSessions?: PersistedSessionSummary[];
}

export interface SessionSidebarProps {
    onOpenSession: (sessionId: string) => void;
    onClearSelection: () => void;
    activeSessionId: string | null;
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

function cwdLabel(cwd: string): string {
    if (!cwd) return "Unknown node";
    const parts = cwd.replace(/\\/g, "/").split("/").filter(Boolean);
    return parts[parts.length - 1] || cwd;
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

export function SessionSidebar({
    onOpenSession,
    onClearSelection,
    activeSessionId,
    onRelayStatusChange,
}: SessionSidebarProps) {
    const [collapsed, setCollapsed] = React.useState(false);
    const [liveSessions, setLiveSessions] = React.useState<HubSession[]>([]);
    const [persistedSessions, setPersistedSessions] = React.useState<PersistedSessionSummary[]>([]);
    const [dotState, setDotState] = React.useState<DotState>("connecting");

    React.useEffect(() => {
        onRelayStatusChange?.(dotState);
    }, [dotState, onRelayStatusChange]);

    const loadPersisted = React.useCallback(async () => {
        try {
            const res = await fetch("/api/sessions", { credentials: "include" });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const json = (await res.json()) as SessionsApiResponse;
            setPersistedSessions(Array.isArray(json.persistedSessions) ? json.persistedSessions : []);
        } catch {
            setPersistedSessions([]);
        }
    }, []);

    React.useEffect(() => {
        loadPersisted();
        const timer = setInterval(() => {
            void loadPersisted();
        }, 20_000);
        return () => clearInterval(timer);
    }, [loadPersisted]);

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
                                    isEphemeral: s.isEphemeral,
                                    expiresAt: s.expiresAt,
                                    isActive: (s as any).isActive ?? false,
                                    lastHeartbeatAt: (s as any).lastHeartbeatAt ?? null,
                                },
                            ];
                        });
                        void loadPersisted();
                    } else if (msg.type === "session_removed") {
                        setLiveSessions((prev) => prev.filter((s) => s.sessionId !== msg.sessionId));
                        void loadPersisted();
                    } else if (msg.type === "session_status") {
                        // Update active status from heartbeat notifications.
                        const { sessionId, isActive, lastHeartbeatAt } = msg as {
                            sessionId: string;
                            isActive: boolean;
                            lastHeartbeatAt: string;
                        };
                        setLiveSessions((prev) =>
                            prev.map((s) =>
                                s.sessionId === sessionId
                                    ? { ...s, isActive, lastHeartbeatAt }
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
    }, [loadPersisted]);

    const liveGroups = React.useMemo(() => {
        const groups = new Map<string, HubSession[]>();
        for (const s of liveSessions) {
            const key = s.cwd || "";
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key)!.push(s);
        }
        return groups;
    }, [liveSessions]);

    const liveSessionIds = React.useMemo(() => new Set(liveSessions.map((s) => s.sessionId)), [liveSessions]);

    const historySessions = React.useMemo(
        () => persistedSessions.filter((s) => !liveSessionIds.has(s.sessionId)),
        [persistedSessions, liveSessionIds],
    );

    const storedGroups = React.useMemo(() => {
        const groups = new Map<string, PersistedSessionSummary[]>();
        for (const s of historySessions) {
            const label = formatRelativeDate(s.lastActiveAt || s.startedAt);
            if (!groups.has(label)) groups.set(label, []);
            groups.get(label)!.push(s);
        }
        return groups;
    }, [historySessions]);

    return (
        <>
            <aside
                className={cn(
                    "flex flex-col h-full bg-sidebar border-r border-sidebar-border flex-shrink-0 overflow-hidden transition-[width,min-width] duration-200",
                    collapsed ? "w-0 min-w-0" : "w-60 min-w-60",
                )}
            >
                <div className="flex items-center justify-between px-3 py-2 border-b border-sidebar-border flex-shrink-0">
                    <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 text-sidebar-foreground/60 hover:text-sidebar-foreground hover:bg-sidebar-accent"
                        onClick={() => setCollapsed(true)}
                        aria-label="Collapse sidebar"
                    >
                        <PanelLeftClose className="h-4 w-4" />
                    </Button>
                    <span className="text-[0.7rem] font-semibold uppercase tracking-widest text-sidebar-foreground/60">
                        Sessions
                    </span>
                    <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 text-sidebar-foreground/60 hover:text-sidebar-foreground hover:bg-sidebar-accent"
                        onClick={onClearSelection}
                        aria-label="Clear selected session"
                        title="Clear selected session"
                    >
                        <Plus className="h-4 w-4" />
                    </Button>
                </div>

                {collapsed && (
                    <Button
                        variant="outline"
                        size="icon"
                        className="m-2 h-8 w-8 shadow-sm"
                        onClick={() => setCollapsed(false)}
                        aria-label="Expand sidebar"
                    >
                        <PanelLeftOpen className="h-4 w-4" />
                    </Button>
                )}

                <div className="flex flex-col flex-shrink-0 overflow-hidden">
                    <div className="flex items-center gap-1.5 px-3 py-1.5">
                        <span className="text-[0.65rem] font-semibold uppercase tracking-widest text-sidebar-foreground/50">
                            Live Sessions
                        </span>
                        <LiveDot state={dotState} />
                    </div>
                    <div className="flex flex-col px-1.5 pb-1.5 max-h-44 overflow-y-auto">
                        {liveGroups.size === 0 ? (
                            <p className="px-2 py-1 text-xs italic text-sidebar-foreground/40">No live sessions</p>
                        ) : (
                            Array.from(liveGroups.entries()).map(([cwd, sessions]) => (
                                <div key={cwd}>
                                    <div className="flex items-center gap-1 px-1.5 py-1">
                                        <span className="text-[0.65rem] text-sidebar-primary/70">⬡</span>
                                        <span
                                            className="text-[0.65rem] font-semibold text-sidebar-foreground/55 truncate"
                                            title={cwd}
                                        >
                                            {cwdLabel(cwd)}
                                        </span>
                                    </div>
                                    {sessions.map((s) => (
                                        <button
                                            key={s.sessionId}
                                            onClick={() => onOpenSession(s.sessionId)}
                                            title={`View session ${s.sessionId}`}
                                            className={cn(
                                                "flex flex-col gap-0.5 w-full px-2 py-1.5 rounded-md text-left text-sidebar-foreground hover:bg-sidebar-accent transition-colors",
                                                activeSessionId === s.sessionId && "bg-sidebar-accent text-sidebar-accent-foreground",
                                            )}
                                        >
                                            <div className="flex items-center gap-2">
                                                <span
                                                    className={cn(
                                                        "inline-block h-1.5 w-1.5 rounded-full flex-shrink-0 transition-colors",
                                                        s.isActive
                                                            ? "bg-green-400 shadow-[0_0_4px_#4ade8060] animate-pulse"
                                                            : "bg-green-600",
                                                    )}
                                                    title={s.isActive ? "Agent actively processing" : "Session idle"}
                                                />
                                                <span className="flex-1 truncate text-[0.78rem] font-medium">
                                                    Session {s.sessionId.slice(0, 8)}…
                                                </span>
                                                <span className="text-[0.65rem] text-sidebar-foreground/50 flex-shrink-0">
                                                    {formatRelativeDate(s.startedAt)}
                                                </span>
                                            </div>
                                            {s.userName && (
                                                <div className="flex items-center gap-1 pl-3.5">
                                                    <User className="h-2.5 w-2.5 text-sidebar-foreground/40 flex-shrink-0" />
                                                    <span className="text-[0.65rem] text-sidebar-foreground/50 truncate">
                                                        {s.userName}
                                                    </span>
                                                </div>
                                            )}
                                        </button>
                                    ))}
                                </div>
                            ))
                        )}
                    </div>
                </div>

                <div className="flex flex-col flex-1 min-h-0 border-t border-sidebar-border overflow-hidden">
                    <div className="px-3 py-1.5 flex-shrink-0">
                        <span className="text-[0.65rem] font-semibold uppercase tracking-widest text-sidebar-foreground/50">
                            History
                        </span>
                    </div>
                    <ScrollArea className="flex-1 px-1.5 pb-1.5">
                        {storedGroups.size === 0 ? (
                            <p className="px-2 py-1 text-xs italic text-sidebar-foreground/40">No saved sessions</p>
                        ) : (
                            Array.from(storedGroups.entries()).map(([label, sessions]) => (
                                <div key={label}>
                                    <div className="px-1.5 py-1">
                                        <span className="text-[0.65rem] font-semibold text-sidebar-foreground/55">
                                            {label}
                                        </span>
                                    </div>
                                    {sessions.map((s) => (
                                        <button
                                            key={s.sessionId}
                                            onClick={() => onOpenSession(s.sessionId)}
                                            title={s.sessionId}
                                            className={cn(
                                                "flex flex-col gap-0.5 w-full px-2 py-1.5 rounded-md text-left text-sidebar-foreground hover:bg-sidebar-accent transition-colors min-w-0",
                                                s.sessionId === activeSessionId && "bg-sidebar-accent text-sidebar-accent-foreground",
                                            )}
                                        >
                                            <span className="text-[0.8rem] font-medium truncate">
                                                Session {s.sessionId.slice(0, 8)}…
                                            </span>
                                            <span className="text-[0.65rem] text-sidebar-foreground/50">
                                                Last active {formatRelativeDate(s.lastActiveAt || s.startedAt)}
                                            </span>
                                        </button>
                                    ))}
                                </div>
                            ))
                        )}
                    </ScrollArea>
                </div>
            </aside>

        </>
    );
}
