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
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { formatPathTail } from "@/lib/path";
import { MessageSquare, Play, Loader2, Clock } from "lucide-react";
import type { ResumeSessionOption } from "@/lib/types";

export interface HistoryCommandPaletteProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    /** Resume sessions from the runner (same source as /resume) */
    sessions: ResumeSessionOption[];
    /** Whether the session list is currently loading */
    loading: boolean;
    /** Trigger a refresh of the resume sessions list */
    onRefresh: () => void;
    /** Called when user selects a session to view */
    onOpenSession: (sessionId: string) => void;
    /** Called when user wants to resume a session */
    onResumeSession?: (sessionId: string) => void;
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

function groupByDate(sessions: ResumeSessionOption[]): { label: string; sessions: ResumeSessionOption[] }[] {
    const groups: Map<string, ResumeSessionOption[]> = new Map();
    const order: string[] = [];

    for (const s of sessions) {
        const label = getDateGroup(s.modified);
        if (!groups.has(label)) {
            groups.set(label, []);
            order.push(label);
        }
        groups.get(label)!.push(s);
    }

    return order.map((label) => ({ label, sessions: groups.get(label)! }));
}

/* ── Skeleton rows shown while loading ──────────────────────────────────── */

function SkeletonRows() {
    return (
        <div className="p-2 space-y-1" role="status" aria-label="Loading sessions">
            {/* Fake group heading */}
            <Skeleton className="h-3 w-12 ml-2 mb-2 mt-1" />
            {[1, 2, 3, 4, 5].map((i) => (
                <div key={i} className="flex items-center gap-2.5 px-2 py-2.5">
                    <Skeleton className="h-8 w-8 rounded-md flex-shrink-0" />
                    <div className="flex-1 min-w-0 space-y-1.5">
                        <div className="flex items-center justify-between gap-2">
                            <Skeleton className="h-3.5 rounded" style={{ width: `${40 + (i * 13) % 35}%` }} />
                            <Skeleton className="h-2.5 w-10 rounded flex-shrink-0" />
                        </div>
                        <Skeleton className="h-2.5 rounded" style={{ width: `${55 + (i * 17) % 30}%` }} />
                    </div>
                </div>
            ))}
        </div>
    );
}

export const HistoryCommandPalette = React.memo(function HistoryCommandPalette({
    open,
    onOpenChange,
    sessions,
    loading,
    onRefresh,
    onOpenSession,
    onResumeSession,
}: HistoryCommandPaletteProps) {
    const [resumingSessionId, setResumingSessionId] = React.useState<string | null>(null);

    // Refresh when the palette opens, but skip if data was fetched recently
    const lastOpenRef = React.useRef(false);
    const lastFetchRef = React.useRef(0);
    React.useEffect(() => {
        if (open && !lastOpenRef.current) {
            const now = Date.now();
            if (now - lastFetchRef.current > 5_000 || sessions.length === 0) {
                lastFetchRef.current = now;
                onRefresh();
            }
        }
        lastOpenRef.current = open;
    }, [open, onRefresh, sessions.length]);

    const handleResume = React.useCallback((e: React.MouseEvent, s: ResumeSessionOption) => {
        e.stopPropagation();
        e.preventDefault();
        if (!onResumeSession) return;
        setResumingSessionId(s.id);
        onResumeSession(s.id);
        onOpenChange(false);
        setTimeout(() => setResumingSessionId(null), 2000);
    }, [onResumeSession, onOpenChange]);

    const handleSelect = React.useCallback((sessionId: string) => {
        onOpenSession(sessionId);
        onOpenChange(false);
    }, [onOpenSession, onOpenChange]);

    const dateGroups = React.useMemo(() => groupByDate(sessions), [sessions]);

    const showSkeleton = loading && sessions.length === 0;

    return (
        <CommandDialog
            open={open}
            onOpenChange={onOpenChange}
            title="Session History"
            description="Search and resume past sessions"
            className="max-w-lg max-md:max-w-[calc(100%-1rem)]"
            showCloseButton={false}
        >
            <CommandInput placeholder="Search sessions…" />
            <CommandList className="max-h-[min(70vh,420px)] md:max-h-[min(60vh,400px)]">
                {showSkeleton ? (
                    <SkeletonRows />
                ) : (
                    <>
                        <CommandEmpty>
                            <div className="flex flex-col items-center gap-2 py-4 text-muted-foreground">
                                <Clock className="h-8 w-8 opacity-30" />
                                <span className="text-sm">No sessions found</span>
                            </div>
                        </CommandEmpty>

                        {dateGroups.map((group, gi) => (
                            <React.Fragment key={group.label}>
                                {gi > 0 && <CommandSeparator />}
                                <CommandGroup heading={group.label}>
                                    {group.sessions.map((s) => {
                                        const isResuming = resumingSessionId === s.id;
                                        const displayName = s.name?.trim() || `Session ${s.id.slice(0, 8)}…`;
                                        const preview = s.firstMessage && s.firstMessage !== "(no messages)"
                                            ? s.firstMessage
                                            : null;

                                        const keywords = [
                                            s.id,
                                            s.path,
                                            s.name ?? "",
                                            s.firstMessage ?? "",
                                        ].filter(Boolean);

                                        return (
                                            <CommandItem
                                                key={s.id}
                                                value={`${displayName} ${s.path}`}
                                                keywords={keywords}
                                                onSelect={() => handleSelect(s.id)}
                                                className="flex items-center gap-2.5 py-3 md:py-2.5 rounded-md"
                                            >
                                                <div className="flex-shrink-0 flex items-center justify-center w-8 h-8 md:w-7 md:h-7 rounded-md bg-muted/60">
                                                    <MessageSquare className="size-4 md:size-3.5 text-muted-foreground/70" />
                                                </div>
                                                <div className="flex-1 min-w-0">
                                                    <div className="flex items-baseline justify-between gap-2 min-w-0">
                                                        <span className="truncate text-sm font-medium leading-tight">
                                                            {displayName}
                                                        </span>
                                                        <span className="text-[0.6rem] text-muted-foreground/60 flex-shrink-0 whitespace-nowrap tabular-nums">
                                                            {formatRelativeDate(s.modified)}
                                                        </span>
                                                    </div>
                                                    {preview && (
                                                        <p className="mt-0.5 text-xs text-muted-foreground/50 truncate leading-tight">
                                                            {preview.length > 72 ? `${preview.slice(0, 72)}…` : preview}
                                                        </p>
                                                    )}
                                                    <div className="flex items-center gap-1 mt-0.5 min-w-0">
                                                        <span className="text-[0.65rem] text-muted-foreground/40 truncate leading-tight" title={s.path}>
                                                            {formatPathTail(s.path, 2)}
                                                        </span>
                                                    </div>
                                                </div>

                                                {/* Resume — icon-only on mobile, label on desktop */}
                                                {onResumeSession && (
                                                    <button
                                                        type="button"
                                                        onClick={(e) => handleResume(e, s)}
                                                        disabled={isResuming}
                                                        className={cn(
                                                            "flex-shrink-0 flex items-center justify-center gap-1 rounded-md transition-colors",
                                                            "h-8 w-8 md:h-auto md:w-auto md:px-2 md:py-1",
                                                            isResuming
                                                                ? "text-muted-foreground/40"
                                                                : "text-green-600 dark:text-green-400 hover:bg-green-500/10 active:bg-green-500/20",
                                                        )}
                                                        title="Resume session"
                                                        aria-label="Resume session"
                                                    >
                                                        {isResuming ? (
                                                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                                        ) : (
                                                            <Play className="h-3.5 w-3.5" />
                                                        )}
                                                        <span className="hidden md:inline text-xs font-medium">Resume</span>
                                                    </button>
                                                )}
                                            </CommandItem>
                                        );
                                    })}
                                </CommandGroup>
                            </React.Fragment>
                        ))}
                    </>
                )}
            </CommandList>
        </CommandDialog>
    );
});
