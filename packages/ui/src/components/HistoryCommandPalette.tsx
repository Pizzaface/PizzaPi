import * as React from "react";
import {
    CommandDialog,
    CommandInput,
    CommandList,
    CommandEmpty,
} from "@/components/ui/command";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { formatPathTail } from "@/lib/path";
import { MessageSquare, Clock, Loader2 } from "lucide-react";
import { useVirtualizer } from "@tanstack/react-virtual";
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
    /** Called when user selects a session to resume */
    onResumeSession: (sessionId: string) => void;
    /** Cursor for the next page of sessions (null = no more pages) */
    nextCursor: string | null;
    /** Called when the user scrolls near the bottom to load more */
    onLoadMore: () => void;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const SESSION_ROW_HEIGHT = 72;   // px — matches py-3 + content height
const HEADING_ROW_HEIGHT = 32;   // px — date group heading
const OVERSCAN = 6;

// ── Date helpers ──────────────────────────────────────────────────────────────

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

// ── Filtering ─────────────────────────────────────────────────────────────────

function matchesSearch(session: ResumeSessionOption, query: string): boolean {
    if (!query) return true;
    const q = query.toLowerCase();
    const name = (session.name ?? "").toLowerCase();
    const id = session.id.toLowerCase();
    const path = session.path.toLowerCase();
    const preview = (session.firstMessage ?? "").toLowerCase();
    return name.includes(q) || id.includes(q) || path.includes(q) || preview.includes(q);
}

// ── Virtual row types ─────────────────────────────────────────────────────────

type VirtualRow =
    | { type: "heading"; label: string }
    | { type: "session"; session: ResumeSessionOption };

function buildVirtualRows(sessions: ResumeSessionOption[], query: string): VirtualRow[] {
    const filtered = query ? sessions.filter((s) => matchesSearch(s, query)) : sessions;
    const rows: VirtualRow[] = [];
    let lastGroup = "";
    for (const session of filtered) {
        const group = getDateGroup(session.modified);
        if (group !== lastGroup) {
            rows.push({ type: "heading", label: group });
            lastGroup = group;
        }
        rows.push({ type: "session", session });
    }
    return rows;
}

// ── Skeleton rows shown while loading ──────────────────────────────────── */

function SkeletonRows() {
    return (
        <div className="p-2 space-y-1" role="status" aria-label="Loading sessions">
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

// ── Main component ────────────────────────────────────────────────────────────

export const HistoryCommandPalette = React.memo(function HistoryCommandPalette({
    open,
    onOpenChange,
    sessions,
    loading,
    onRefresh,
    onResumeSession,
    nextCursor,
    onLoadMore,
}: HistoryCommandPaletteProps) {

    const [search, setSearch] = React.useState("");
    const [selectedIndex, setSelectedIndex] = React.useState(-1);
    const scrollRef = React.useRef<HTMLDivElement>(null);

    // ── Refresh on open ──────────────────────────────────────────────────
    const lastOpenRef = React.useRef(false);
    const lastFetchRef = React.useRef(0);
    React.useEffect(() => {
        if (open && !lastOpenRef.current) {
            const now = Date.now();
            if (now - lastFetchRef.current > 5_000 || sessions.length === 0) {
                lastFetchRef.current = now;
                onRefresh();
            }
            // Reset search & selection when re-opening
            setSearch("");
            setSelectedIndex(-1);
        }
        lastOpenRef.current = open;
    }, [open, onRefresh, sessions.length]);

    // ── Build virtual rows ───────────────────────────────────────────────
    const virtualRows = React.useMemo(() => buildVirtualRows(sessions, search), [sessions, search]);

    // Get session-only rows for keyboard navigation
    const sessionIndices = React.useMemo(
        () => virtualRows.map((r, i) => (r.type === "session" ? i : -1)).filter((i) => i >= 0),
        [virtualRows],
    );

    // ── Virtualizer ──────────────────────────────────────────────────────
    const virtualizer = useVirtualizer({
        count: virtualRows.length,
        getScrollElement: () => scrollRef.current,
        estimateSize: (index) =>
            virtualRows[index]?.type === "heading" ? HEADING_ROW_HEIGHT : SESSION_ROW_HEIGHT,
        overscan: OVERSCAN,
    });

    // ── Infinite scroll: load more when near bottom ──────────────────────
    const loadMoreTriggered = React.useRef(false);
    React.useEffect(() => {
        // Reset the trigger guard when cursor changes (new page arrived)
        loadMoreTriggered.current = false;
    }, [nextCursor]);

    React.useEffect(() => {
        if (!open || !nextCursor || loading || loadMoreTriggered.current) return;
        // If we're searching, don't load more (client-side filter handles it)
        if (search) return;

        const items = virtualizer.getVirtualItems();
        if (items.length === 0) return;
        const lastItem = items[items.length - 1];
        // Trigger when the last visible virtual item is within 5 rows of the end
        if (lastItem.index >= virtualRows.length - 5) {
            loadMoreTriggered.current = true;
            onLoadMore();
        }
    }, [open, nextCursor, loading, search, virtualizer.getVirtualItems(), virtualRows.length, onLoadMore]);

    // ── Keyboard navigation ──────────────────────────────────────────────
    const handleSelect = React.useCallback((sessionId: string) => {
        onResumeSession(sessionId);
        onOpenChange(false);
    }, [onResumeSession, onOpenChange]);

    React.useEffect(() => {
        if (!open) return;

        function onKeyDown(e: KeyboardEvent) {
            if (e.key === "ArrowDown") {
                e.preventDefault();
                setSelectedIndex((prev) => {
                    const currentPos = sessionIndices.indexOf(prev);
                    const nextPos = currentPos < sessionIndices.length - 1 ? currentPos + 1 : 0;
                    const nextIdx = sessionIndices[nextPos];
                    if (nextIdx != null) virtualizer.scrollToIndex(nextIdx, { align: "auto" });
                    return nextIdx ?? prev;
                });
            } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setSelectedIndex((prev) => {
                    const currentPos = sessionIndices.indexOf(prev);
                    const nextPos = currentPos > 0 ? currentPos - 1 : sessionIndices.length - 1;
                    const nextIdx = sessionIndices[nextPos];
                    if (nextIdx != null) virtualizer.scrollToIndex(nextIdx, { align: "auto" });
                    return nextIdx ?? prev;
                });
            } else if (e.key === "Enter") {
                e.preventDefault();
                const row = virtualRows[selectedIndex];
                if (row?.type === "session") {
                    handleSelect(row.session.id);
                }
            }
        }

        window.addEventListener("keydown", onKeyDown);
        return () => window.removeEventListener("keydown", onKeyDown);
    }, [open, sessionIndices, selectedIndex, virtualRows, virtualizer, handleSelect]);

    // Auto-select first session when rows change
    React.useEffect(() => {
        if (sessionIndices.length > 0 && selectedIndex === -1) {
            setSelectedIndex(sessionIndices[0]);
        }
    }, [sessionIndices, selectedIndex]);

    // Reset selection when search changes
    React.useEffect(() => {
        setSelectedIndex(sessionIndices[0] ?? -1);
    }, [search]); // eslint-disable-line react-hooks/exhaustive-deps

    const showSkeleton = loading && sessions.length === 0;
    const showEmpty = !loading && sessions.length === 0;
    const showNoResults = !loading && sessions.length > 0 && virtualRows.length === 0 && !!search;

    return (
        <CommandDialog
            open={open}
            onOpenChange={onOpenChange}
            title="Session History"
            description="Search and resume past sessions"
            className="max-w-lg max-md:max-w-[calc(100%-1rem)]"
            showCloseButton={false}
            shouldFilter={false}
        >
            <CommandInput
                placeholder="Search sessions…"
                value={search}
                onValueChange={setSearch}
            />
            {/* We use CommandList only for the empty state; the actual list is virtualized */}
            {showSkeleton ? (
                <SkeletonRows />
            ) : showEmpty ? (
                <CommandList>
                    <CommandEmpty>
                        <div className="flex flex-col items-center gap-2 py-4 text-muted-foreground">
                            <Clock className="h-8 w-8 opacity-30" />
                            <span className="text-sm">No sessions found</span>
                        </div>
                    </CommandEmpty>
                </CommandList>
            ) : showNoResults ? (
                <div className="flex flex-col items-center gap-2 py-8 text-muted-foreground">
                    <Clock className="h-8 w-8 opacity-30" />
                    <span className="text-sm">No matching sessions</span>
                </div>
            ) : (
                <div
                    ref={scrollRef}
                    className="max-h-[min(70vh,420px)] md:max-h-[min(60vh,400px)] overflow-y-auto overflow-x-hidden"
                >
                    <div
                        style={{
                            height: virtualizer.getTotalSize(),
                            position: "relative",
                            width: "100%",
                        }}
                    >
                        {virtualizer.getVirtualItems().map((vItem) => {
                            const row = virtualRows[vItem.index];
                            if (!row) return null;

                            if (row.type === "heading") {
                                return (
                                    <div
                                        key={`heading-${row.label}`}
                                        style={{
                                            position: "absolute",
                                            top: vItem.start,
                                            left: 0,
                                            right: 0,
                                            height: HEADING_ROW_HEIGHT,
                                        }}
                                        className="flex items-center px-3 text-xs font-medium text-muted-foreground"
                                    >
                                        {row.label}
                                    </div>
                                );
                            }

                            const s = row.session;
                            const isSelected = vItem.index === selectedIndex;
                            const displayName = s.name?.trim() || `Session ${s.id.slice(0, 8)}…`;
                            const preview = s.firstMessage && s.firstMessage !== "(no messages)"
                                ? s.firstMessage
                                : null;

                            return (
                                <div
                                    key={s.id}
                                    style={{
                                        position: "absolute",
                                        top: vItem.start,
                                        left: 0,
                                        right: 0,
                                        height: SESSION_ROW_HEIGHT,
                                    }}
                                    role="option"
                                    aria-selected={isSelected}
                                    data-selected={isSelected}
                                    className={cn(
                                        "flex items-center gap-2.5 px-3 cursor-default rounded-sm transition-colors",
                                        isSelected
                                            ? "bg-accent text-accent-foreground"
                                            : "hover:bg-accent/50",
                                    )}
                                    onClick={() => handleSelect(s.id)}
                                    onMouseEnter={() => setSelectedIndex(vItem.index)}
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
                                </div>
                            );
                        })}
                    </div>

                    {/* Loading more indicator */}
                    {loading && sessions.length > 0 && (
                        <div className="flex items-center justify-center gap-2 py-3 text-muted-foreground/60">
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            <span className="text-xs">Loading more…</span>
                        </div>
                    )}
                </div>
            )}
        </CommandDialog>
    );
});
