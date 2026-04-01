import * as React from "react";
import { cn } from "@/lib/utils";
import { formatPathTail } from "@/lib/path";
import { FolderOpen, Play, Clock, Loader2 } from "lucide-react";

export interface HistoricalSession {
    sessionId: string;
    cwd: string;
    shareUrl: string;
    startedAt: string;
    lastActiveAt: string;
    endedAt: string | null;
    isEphemeral: boolean;
    expiresAt: string | null;
    isPinned: boolean;
    runnerId: string | null;
    runnerName: string | null;
    sessionName: string | null;
}

export interface HistoryPanelProps {
    activeSessionId: string | null;
    /** Set of session IDs currently live (used to filter out active sessions) */
    liveSessionIds: Set<string>;
    /** Set of runner IDs that are currently online */
    onlineRunnerIds: Set<string>;
    /** Called when user clicks a historical session to view its snapshot */
    onOpenSession: (sessionId: string) => void;
    /** Called when user wants to resume a session on a runner */
    onResumeSession?: (sessionId: string, runnerId: string, cwd: string) => void;
}

function formatRelativeDate(isoString: string): string {
    const date = new Date(isoString);
    const now = new Date();
    const diff = now.getTime() - date.getTime();
    const minutes = Math.floor(diff / (1000 * 60));
    const hours = Math.floor(diff / (1000 * 60 * 60));
    const days = Math.floor(diff / (1000 * 60 * 60 * 24));
    if (minutes < 1) return "Just now";
    if (minutes < 60) return `${minutes}m ago`;
    if (hours < 24) return `${hours}h ago`;
    if (days === 1) return "Yesterday";
    if (days < 7) return `${days}d ago`;
    if (days < 30) return `${Math.floor(days / 7)}w ago`;
    return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function groupByDate(sessions: HistoricalSession[]): { label: string; sessions: HistoricalSession[] }[] {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const yesterday = new Date(today.getTime() - 86400000);
    const weekAgo = new Date(today.getTime() - 7 * 86400000);
    const monthAgo = new Date(today.getTime() - 30 * 86400000);

    const groups: Map<string, HistoricalSession[]> = new Map();
    const order: string[] = [];

    for (const s of sessions) {
        const date = new Date(s.lastActiveAt);
        let label: string;
        if (date >= today) label = "Today";
        else if (date >= yesterday) label = "Yesterday";
        else if (date >= weekAgo) label = "This Week";
        else if (date >= monthAgo) label = "This Month";
        else {
            const month = date.toLocaleDateString(undefined, { month: "long", year: "numeric" });
            label = month;
        }

        if (!groups.has(label)) {
            groups.set(label, []);
            order.push(label);
        }
        groups.get(label)!.push(s);
    }

    return order.map((label) => ({ label, sessions: groups.get(label)! }));
}

const PAGE_SIZE = 30;

export const HistoryPanel = React.memo(function HistoryPanel({
    activeSessionId,
    liveSessionIds,
    onlineRunnerIds,
    onOpenSession,
    onResumeSession,
}: HistoryPanelProps) {
    const [sessions, setSessions] = React.useState<HistoricalSession[]>([]);
    const [loading, setLoading] = React.useState(false);
    const [initialLoaded, setInitialLoaded] = React.useState(false);
    const [hasMore, setHasMore] = React.useState(false);
    const [resumingSessionId, setResumingSessionId] = React.useState<string | null>(null);

    const fetchSessions = React.useCallback(async (offset: number = 0) => {
        setLoading(true);
        try {
            const params = new URLSearchParams({ limit: String(PAGE_SIZE + 1) });
            if (offset > 0) params.set("offset", String(offset));
            const res = await fetch(`/api/sessions?${params.toString()}`, { credentials: "include" });
            if (!res.ok) return;
            const body = await res.json();
            const persisted: HistoricalSession[] = Array.isArray(body?.persistedSessions)
                ? body.persistedSessions.map((s: any) => ({
                    sessionId: s.sessionId,
                    cwd: s.cwd ?? "",
                    shareUrl: s.shareUrl ?? "",
                    startedAt: s.startedAt ?? "",
                    lastActiveAt: s.lastActiveAt ?? "",
                    endedAt: s.endedAt ?? null,
                    isEphemeral: s.isEphemeral ?? false,
                    expiresAt: s.expiresAt ?? null,
                    isPinned: s.isPinned ?? false,
                    runnerId: s.runnerId ?? null,
                    runnerName: s.runnerName ?? null,
                    sessionName: s.sessionName ?? null,
                }))
                : [];

            const hasMoreItems = persisted.length > PAGE_SIZE;
            const pageItems = hasMoreItems ? persisted.slice(0, PAGE_SIZE) : persisted;

            if (offset > 0) {
                setSessions((prev) => {
                    const existingIds = new Set(prev.map((s) => s.sessionId));
                    const newItems = pageItems.filter((s) => !existingIds.has(s.sessionId));
                    return [...prev, ...newItems];
                });
            } else {
                setSessions(pageItems);
            }
            setHasMore(hasMoreItems);
            setInitialLoaded(true);
        } catch {
            // best-effort
        } finally {
            setLoading(false);
        }
    }, []);

    // Load initial page on mount
    React.useEffect(() => {
        if (!initialLoaded) {
            fetchSessions();
        }
    }, [initialLoaded, fetchSessions]);

    const handleResume = React.useCallback(async (s: HistoricalSession) => {
        if (!s.runnerId || !onResumeSession) return;
        setResumingSessionId(s.sessionId);
        try {
            await onResumeSession(s.sessionId, s.runnerId, s.cwd);
        } finally {
            setResumingSessionId(null);
        }
    }, [onResumeSession]);

    // Filter out live sessions from history
    const filteredSessions = React.useMemo(
        () => sessions.filter((s) => !liveSessionIds.has(s.sessionId)),
        [sessions, liveSessionIds],
    );

    const dateGroups = React.useMemo(() => groupByDate(filteredSessions), [filteredSessions]);

    if (!initialLoaded) {
        return (
            <div className="flex items-center justify-center py-8">
                <Loader2 className="h-4 w-4 animate-spin text-sidebar-foreground/40" />
            </div>
        );
    }

    if (filteredSessions.length === 0) {
        return (
            <div className="px-4 py-8 text-center">
                <Clock className="h-8 w-8 text-sidebar-foreground/20 mx-auto mb-2" />
                <p className="text-xs font-medium text-sidebar-foreground/50">No session history</p>
                <p className="text-[10px] text-sidebar-foreground/30 mt-1">
                    Past sessions will appear here
                </p>
            </div>
        );
    }

    return (
        <div className="flex flex-col gap-1 px-2 pb-2">
            {dateGroups.map((group) => (
                <div key={group.label}>
                    <div className="text-[9px] font-medium text-sidebar-foreground/35 uppercase tracking-widest px-2.5 py-1.5 sticky top-0 bg-sidebar z-10">
                        {group.label}
                    </div>
                    {group.sessions.map((s) => {
                        const isActive = activeSessionId === s.sessionId;
                        const canResume = !!s.runnerId && onlineRunnerIds.has(s.runnerId) && !!onResumeSession;
                        const isResuming = resumingSessionId === s.sessionId;
                        const displayName = s.sessionName?.trim() || `Session ${s.sessionId.slice(0, 8)}…`;

                        return (
                            <div
                                key={s.sessionId}
                                className={cn(
                                    "group flex items-center gap-2.5 w-full min-w-0 px-2.5 py-2.5 text-left rounded-md transition-colors",
                                    isActive
                                        ? "bg-sidebar-accent text-sidebar-accent-foreground"
                                        : "text-sidebar-foreground/70 hover:bg-sidebar-accent/50",
                                )}
                            >
                                {/* Click to view snapshot */}
                                <button
                                    type="button"
                                    onClick={() => onOpenSession(s.sessionId)}
                                    className="flex items-center gap-2.5 flex-1 min-w-0 text-left"
                                    title={`View session ${displayName}`}
                                >
                                    <div className="relative flex-shrink-0 flex items-center justify-center w-7 h-7 rounded-md bg-sidebar-accent/30">
                                        <FolderOpen className="size-3.5 text-sidebar-foreground/40" />
                                    </div>
                                    <div className="flex-1 min-w-0">
                                        <div className="flex items-baseline justify-between gap-1 min-w-0">
                                            <span className="truncate text-[0.78rem] font-medium leading-tight">
                                                {displayName}
                                            </span>
                                            <span className="text-[0.6rem] text-sidebar-foreground/35 flex-shrink-0 whitespace-nowrap">
                                                {formatRelativeDate(s.lastActiveAt)}
                                            </span>
                                        </div>
                                        <div className="flex items-center gap-1 mt-0.5 min-w-0">
                                            <span className="text-[0.6rem] text-sidebar-foreground/30 truncate" title={s.cwd}>
                                                {formatPathTail(s.cwd, 2)}
                                            </span>
                                            {(s.runnerName || s.runnerId) && (
                                                <span className="text-[0.55rem] text-sidebar-foreground/25 truncate max-w-[5rem]" title={s.runnerName ?? `Runner ${s.runnerId}`}>
                                                    · {s.runnerName || `Runner ${s.runnerId?.slice(0, 8)}…`}
                                                </span>
                                            )}
                                        </div>
                                    </div>
                                </button>

                                {/* Resume button — only shown when runner is online */}
                                {canResume && (
                                    <button
                                        type="button"
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            handleResume(s);
                                        }}
                                        disabled={isResuming}
                                        className={cn(
                                            "flex-shrink-0 flex items-center justify-center w-7 h-7 rounded-md transition-all",
                                            "opacity-0 group-hover:opacity-100 focus-visible:opacity-100",
                                            "md:opacity-0 md:group-hover:opacity-100",
                                            // Always visible on touch devices
                                            "max-md:opacity-100",
                                            isResuming
                                                ? "text-sidebar-foreground/30"
                                                : "text-green-500/70 hover:text-green-500 hover:bg-green-500/10",
                                        )}
                                        title={`Resume on ${s.runnerName || "runner"}`}
                                        aria-label={`Resume session on ${s.runnerName || "runner"}`}
                                    >
                                        {isResuming ? (
                                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                        ) : (
                                            <Play className="h-3.5 w-3.5" />
                                        )}
                                    </button>
                                )}
                            </div>
                        );
                    })}
                </div>
            ))}

            {/* Load more */}
            {hasMore && (
                <button
                    type="button"
                    onClick={() => fetchSessions(sessions.length)}
                    disabled={loading}
                    className="w-full px-2.5 py-2 mt-1 text-[0.7rem] font-medium text-sidebar-foreground/50 hover:text-sidebar-foreground/70 hover:bg-sidebar-accent/40 rounded-md transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                >
                    {loading ? "Loading…" : "Load more"}
                </button>
            )}
        </div>
    );
});
