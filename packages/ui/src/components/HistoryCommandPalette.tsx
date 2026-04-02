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
            // Skip if we fetched within the last 5 seconds
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
        // Reset after a delay — the session switch will handle the rest
        setTimeout(() => setResumingSessionId(null), 2000);
    }, [onResumeSession, onOpenChange]);

    const handleSelect = React.useCallback((sessionId: string) => {
        onOpenSession(sessionId);
        onOpenChange(false);
    }, [onOpenSession, onOpenChange]);

    const dateGroups = React.useMemo(() => groupByDate(sessions), [sessions]);

    return (
        <CommandDialog
            open={open}
            onOpenChange={onOpenChange}
            title="Session History"
            description="Search and resume past sessions"
            className="max-w-lg"
            showCloseButton={false}
        >
            <CommandInput placeholder="Search sessions by name or path…" />
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
                                const isResuming = resumingSessionId === s.id;
                                const displayName = s.name?.trim() || `Session ${s.id.slice(0, 8)}…`;

                                // Build search keywords for cmdk filtering
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
                                                    {formatRelativeDate(s.modified)}
                                                </span>
                                            </div>
                                            <div className="flex items-center gap-1 mt-0.5 min-w-0">
                                                <span className="text-xs text-muted-foreground/70 truncate" title={s.path}>
                                                    {formatPathTail(s.path, 2)}
                                                </span>
                                            </div>
                                            {s.firstMessage && (
                                                <div className="mt-0.5 min-w-0">
                                                    <span className="text-[0.65rem] text-muted-foreground/50 truncate block">
                                                        {s.firstMessage.length > 80 ? `${s.firstMessage.slice(0, 80)}…` : s.firstMessage}
                                                    </span>
                                                </div>
                                            )}
                                        </div>

                                        {/* Resume button */}
                                        {onResumeSession && (
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
                                                title="Resume session"
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
            </CommandList>
        </CommandDialog>
    );
});
