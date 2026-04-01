import * as React from "react";
import {
    CommandDialog,
    CommandInput,
    CommandList,
    CommandEmpty,
    CommandGroup,
    CommandItem,
    CommandSeparator,
} from "@/components/ui/command";
import { cn } from "@/lib/utils";
import { formatPathTail } from "@/lib/path";
import { FolderOpen, Play, Loader2 } from "lucide-react";

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

export interface HistoryCommandPaletteProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    /** Set of session IDs currently live (filtered out of history) */
    liveSessionIds: Set<string>;
    /** Set of runner IDs that are currently online */
    onlineRunnerIds: Set<string>;
    /** Called when user selects a historical session to view its snapshot */
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

function getDateGroup(isoString: string): string {
    const date = new Date(isoString);
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const yesterday = new Date(today.getTime() - 86400000);
    const weekAgo = new Date(today.getTime() - 7 * 86400000);
    const monthAgo = new Date(today.getTime() - 30 * 86400000);

    if (date >= today) return "Today";
    if (date >= yesterday) return "Yesterday";
    if (date >= weekAgo) return "This Week";
    if (date >= monthAgo) return "This Month";
    return date.toLocaleDateString(undefined, { month: "long", year: "numeric" });
}

function groupByDate(sessions: HistoricalSession[]): { label: string; sessions: HistoricalSession[] }[] {
    const groups: Map<string, HistoricalSession[]> = new Map();
    const order: string[] = [];

    for (const s of sessions) {
        const label = getDateGroup(s.lastActiveAt);
        if (!groups.has(label)) {
            groups.set(label, []);
            order.push(label);
        }
        groups.get(label)!.push(s);
    }

    return order.map((label) => ({ label, sessions: groups.get(label)! }));
}

const PAGE_SIZE = 50;

export const HistoryCommandPalette = React.memo(function HistoryCommandPalette({
    open,
    onOpenChange,
    liveSessionIds,
    onlineRunnerIds,
    onOpenSession,
    onResumeSession,
}: HistoryCommandPaletteProps) {
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

    // Fetch when the palette opens
    React.useEffect(() => {
        if (open && !initialLoaded) {
            fetchSessions();
        }
    }, [open, initialLoaded, fetchSessions]);

    // Refresh on re-open (stale data check)
    const lastOpenRef = React.useRef(false);
    React.useEffect(() => {
        if (open && !lastOpenRef.current && initialLoaded) {
            // Re-opening — refresh the first page
            fetchSessions(0);
        }
        lastOpenRef.current = open;
    }, [open, initialLoaded, fetchSessions]);

    const handleResume = React.useCallback(async (e: React.MouseEvent, s: HistoricalSession) => {
        e.stopPropagation();
        e.preventDefault();
        if (!s.runnerId || !onResumeSession) return;
        setResumingSessionId(s.sessionId);
        try {
            await onResumeSession(s.sessionId, s.runnerId, s.cwd);
            onOpenChange(false);
        } finally {
            setResumingSessionId(null);
        }
    }, [onResumeSession, onOpenChange]);

    const handleSelect = React.useCallback((sessionId: string) => {
        onOpenSession(sessionId);
        onOpenChange(false);
    }, [onOpenSession, onOpenChange]);

    // Filter out live sessions
    const filteredSessions = React.useMemo(
        () => sessions.filter((s) => !liveSessionIds.has(s.sessionId)),
        [sessions, liveSessionIds],
    );

    const dateGroups = React.useMemo(() => groupByDate(filteredSessions), [filteredSessions]);

    return (
        <CommandDialog
            open={open}
            onOpenChange={onOpenChange}
            title="Session History"
            description="Search and resume past sessions"
            className="max-w-lg"
            showCloseButton={false}
        >
            <CommandInput placeholder="Search sessions by name, path, or runner…" />
            <CommandList className="max-h-[min(60vh,400px)]">
                <CommandEmpty>
                    {loading ? (
                        <div className="flex items-center justify-center gap-2">
                            <Loader2 className="h-4 w-4 animate-spin" />
                            <span>Loading sessions…</span>
                        </div>
                    ) : (
                        "No sessions found"
                    )}
                </CommandEmpty>

                {dateGroups.map((group, gi) => (
                    <React.Fragment key={group.label}>
                        {gi > 0 && <CommandSeparator />}
                        <CommandGroup heading={group.label}>
                            {group.sessions.map((s) => {
                                const canResume = !!s.runnerId && onlineRunnerIds.has(s.runnerId) && !!onResumeSession;
                                const isResuming = resumingSessionId === s.sessionId;
                                const displayName = s.sessionName?.trim() || `Session ${s.sessionId.slice(0, 8)}…`;

                                // Build search keywords for cmdk filtering
                                const keywords = [
                                    s.sessionId,
                                    s.cwd,
                                    s.runnerName ?? "",
                                    s.runnerId ?? "",
                                    s.sessionName ?? "",
                                ].filter(Boolean);

                                return (
                                    <CommandItem
                                        key={s.sessionId}
                                        value={`${displayName} ${s.cwd} ${s.runnerName ?? ""}`}
                                        keywords={keywords}
                                        onSelect={() => handleSelect(s.sessionId)}
                                        className="flex items-center gap-2.5 py-2.5"
                                    >
                                        <div className="flex-shrink-0 flex items-center justify-center w-7 h-7 rounded-md bg-muted/50">
                                            <FolderOpen className="size-3.5 text-muted-foreground" />
                                        </div>
                                        <div className="flex-1 min-w-0">
                                            <div className="flex items-baseline justify-between gap-2 min-w-0">
                                                <span className="truncate text-sm font-medium">
                                                    {displayName}
                                                </span>
                                                <span className="text-[0.65rem] text-muted-foreground flex-shrink-0 whitespace-nowrap">
                                                    {formatRelativeDate(s.lastActiveAt)}
                                                </span>
                                            </div>
                                            <div className="flex items-center gap-1 mt-0.5 min-w-0">
                                                <span className="text-xs text-muted-foreground/70 truncate" title={s.cwd}>
                                                    {formatPathTail(s.cwd, 2)}
                                                </span>
                                                {(s.runnerName || s.runnerId) && (
                                                    <span className="text-[0.65rem] text-muted-foreground/50 truncate max-w-[6rem]">
                                                        · {s.runnerName || `Runner ${s.runnerId?.slice(0, 8)}…`}
                                                    </span>
                                                )}
                                            </div>
                                        </div>

                                        {/* Resume button */}
                                        {canResume && (
                                            <button
                                                type="button"
                                                onClick={(e) => handleResume(e, s)}
                                                disabled={isResuming}
                                                className={cn(
                                                    "flex-shrink-0 flex items-center gap-1 px-2 py-1 rounded-md text-xs font-medium transition-colors",
                                                    isResuming
                                                        ? "text-muted-foreground/50"
                                                        : "text-green-600 dark:text-green-400 hover:bg-green-500/10",
                                                )}
                                                title={`Resume on ${s.runnerName || "runner"}`}
                                            >
                                                {isResuming ? (
                                                    <Loader2 className="h-3 w-3 animate-spin" />
                                                ) : (
                                                    <Play className="h-3 w-3" />
                                                )}
                                                <span>Resume</span>
                                            </button>
                                        )}
                                    </CommandItem>
                                );
                            })}
                        </CommandGroup>
                    </React.Fragment>
                ))}

                {/* Load more */}
                {hasMore && (
                    <>
                        <CommandSeparator />
                        <div className="p-2">
                            <button
                                type="button"
                                onClick={() => fetchSessions(sessions.length)}
                                disabled={loading}
                                className="w-full px-3 py-2 text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-accent rounded-md transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                            >
                                {loading ? "Loading…" : "Load more sessions"}
                            </button>
                        </div>
                    </>
                )}
            </CommandList>
        </CommandDialog>
    );
});
