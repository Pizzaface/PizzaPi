import * as React from "react";
import { Resizable } from "react-resizable";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { io } from "socket.io-client";
import type { HubServerToClientEvents, HubClientToServerEvents } from "@pizzapi/protocol";
import { formatPathTail } from "@/lib/path";
import { ProviderIcon } from "@/components/ProviderIcon";
import { PanelLeftClose, PanelLeftOpen, Plus, User, X, HardDrive } from "lucide-react";

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
    runnerId?: string | null;
    runnerName?: string | null;
}

export type { HubSession };

export interface SessionSidebarProps {
    onOpenSession: (sessionId: string) => void;
    onNewSession: () => void;
    onClearSelection: () => void;
    onShowRunners: () => void;
    activeSessionId: string | null;
    showRunners?: boolean;
    /** Active model info for the currently selected session (used for provider indicator) */
    activeModel?: { provider: string; id: string; name?: string } | null;
    onRelayStatusChange?: (state: DotState) => void;
    /** Called whenever the live sessions list changes so the parent can use it (e.g. mobile switcher) */
    onSessionsChange?: (sessions: HubSession[]) => void;
    /** Called when the user taps the close/back button on mobile */
    onClose?: () => void;
    /** Called when the user confirms ending a session via the swipe gesture */
    onEndSession?: (sessionId: string) => void;
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

import { Skeleton } from "@/components/ui/skeleton";

function SidebarSkeleton() {
    return (
        <div className="flex flex-col px-2 pb-2 gap-2 mt-2 animate-in fade-in duration-500">
             <div className="flex flex-col gap-1">
                <div className="flex items-center gap-1.5 px-1.5 py-2 opacity-50">
                     <Skeleton className="h-3 w-3 rounded-full" />
                     <Skeleton className="h-3 w-16 rounded-sm" />
                </div>
                {[1, 2, 3].map((i) => (
                    <div key={i} className="flex items-center gap-3 px-2.5 py-3 rounded-lg">
                        <Skeleton className="h-8 w-8 rounded-md shrink-0" />
                        <div className="flex-1 space-y-2 min-w-0">
                            <Skeleton className="h-3.5 w-3/4 rounded-sm" />
                            <Skeleton className="h-2.5 w-1/2 rounded-sm" />
                        </div>
                    </div>
                ))}
             </div>
        </div>
    );
}

export const SessionSidebar = React.memo(function SessionSidebar({
    onOpenSession,
    onNewSession,
    onClearSelection,
    onShowRunners,
    activeSessionId,
    showRunners,
    activeModel,
    onRelayStatusChange,
    onSessionsChange,
    onClose,
    onEndSession,
}: SessionSidebarProps) {
    const [collapsed, setCollapsed] = React.useState(false);

    // Swipe-to-reveal "End" button state (iOS-style swipe-left pattern)
    // Uses pointer events so it works on both touch screens AND desktop trackpads
    // (touch events don't fire on macOS trackpad — only pointer/mouse events do).
    const [confirmEndSessionId, setConfirmEndSessionId] = React.useState<string | null>(null);
    const [revealedSessionId, setRevealedSessionId] = React.useState<string | null>(null);
    const [swipeOffsets, setSwipeOffsets] = React.useState<Map<string, number>>(new Map());
    const REVEAL_WIDTH = 72; // px width of the revealed "End" button

    const swipeRef = React.useRef<{
        sessionId: string;
        pointerId: number;
        startX: number;
        startY: number;
        curX: number;
        locked: boolean; // true once we've committed to horizontal movement
        isVertical: boolean; // true once we've committed to vertical scroll
        didSwipe: boolean; // true if any significant horizontal movement happened
    } | null>(null);
    // Flag to suppress the click that fires after a swipe/long-press pointerUp
    const suppressClickRef = React.useRef(false);
    // Long-press timer: fires the confirmation dialog if the user holds for 500ms
    const longPressTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

    const clearLongPress = React.useCallback(() => {
        if (longPressTimerRef.current) {
            clearTimeout(longPressTimerRef.current);
            longPressTimerRef.current = null;
        }
    }, []);

    // Cleanup long-press timer on unmount
    React.useEffect(() => () => { clearLongPress(); }, [clearLongPress]);

    const handleSessionPointerDown = React.useCallback((e: React.PointerEvent, sessionId: string) => {
        // Only track primary button (left-click / single touch)
        if (e.button !== 0) return;
        swipeRef.current = {
            sessionId,
            pointerId: e.pointerId,
            startX: e.clientX,
            startY: e.clientY,
            curX: e.clientX,
            locked: false,
            isVertical: false,
            didSwipe: false,
        };
        // Capture the pointer so we get move/up even if the cursor leaves the element
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);

        // Start long-press timer — show confirmation after 500ms of holding
        clearLongPress();
        longPressTimerRef.current = setTimeout(() => {
            longPressTimerRef.current = null;
            // Only fire if the user hasn't started swiping or scrolling
            const s = swipeRef.current;
            if (s && !s.locked && !s.isVertical && !s.didSwipe) {
                s.didSwipe = true; // prevent the click from firing
                suppressClickRef.current = true;
                requestAnimationFrame(() => { suppressClickRef.current = false; });
                setConfirmEndSessionId(sessionId);
            }
        }, 500);
    }, [clearLongPress]);

    const handleSessionPointerMove = React.useCallback((e: React.PointerEvent) => {
        const s = swipeRef.current;
        if (!s || e.pointerId !== s.pointerId) return;
        s.curX = e.clientX;
        const dx = e.clientX - s.startX;
        const dy = e.clientY - s.startY;

        // Any significant movement cancels the long-press timer
        if (Math.abs(dx) > 5 || Math.abs(dy) > 5) {
            clearLongPress();
        }

        // Determine direction lock on first significant movement
        if (!s.locked && !s.isVertical) {
            if (Math.abs(dy) > 8 && Math.abs(dy) > Math.abs(dx)) {
                s.isVertical = true; // vertical scroll — bail out
                return;
            }
            if (Math.abs(dx) > 8 && Math.abs(dx) > Math.abs(dy)) {
                s.locked = true; // horizontal swipe — we own the gesture
            }
        }

        if (s.isVertical) return;
        if (!s.locked) return;

        s.didSwipe = true;
        e.preventDefault();
        e.stopPropagation();

        // If this session was previously revealed, account for that
        const wasRevealed = revealedSessionId === s.sessionId;
        const base = wasRevealed ? -REVEAL_WIDTH : 0;
        const raw = base + dx;
        // Clamp: allow from -REVEAL_WIDTH (with slight overscroll) to 0 (with slight overscroll)
        const clamped = Math.max(-REVEAL_WIDTH - 20, Math.min(raw, wasRevealed ? 0 : 10));

        setSwipeOffsets((prev) => {
            const next = new Map(prev);
            next.set(s.sessionId, clamped);
            return next;
        });
    }, [revealedSessionId, REVEAL_WIDTH, clearLongPress]);

    const handleSessionPointerUp = React.useCallback((e: React.PointerEvent) => {
        clearLongPress();
        const s = swipeRef.current;
        if (!s || e.pointerId !== s.pointerId) return;
        const didSwipe = s.didSwipe;
        swipeRef.current = null;

        try {
            (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
        } catch { /* ignore */ }

        if (didSwipe) {
            // Suppress the click event that follows this pointerUp
            suppressClickRef.current = true;
            requestAnimationFrame(() => { suppressClickRef.current = false; });
        }

        if (s.isVertical || !s.locked) return;

        const wasRevealed = revealedSessionId === s.sessionId;
        const offset = swipeOffsets.get(s.sessionId) ?? 0;

        // Snap open if swiped past half the reveal width, otherwise snap closed
        if (offset < -REVEAL_WIDTH / 2) {
            setSwipeOffsets((prev) => {
                const next = new Map(prev);
                next.set(s.sessionId, -REVEAL_WIDTH);
                return next;
            });
            setRevealedSessionId(s.sessionId);
        } else {
            setSwipeOffsets((prev) => {
                const next = new Map(prev);
                next.delete(s.sessionId);
                return next;
            });
            if (wasRevealed) setRevealedSessionId(null);
        }
    }, [revealedSessionId, swipeOffsets, REVEAL_WIDTH, clearLongPress]);

    // Close revealed item when clicking elsewhere
    const handleCloseRevealed = React.useCallback(() => {
        if (revealedSessionId) {
            setSwipeOffsets((prev) => {
                const next = new Map(prev);
                next.delete(revealedSessionId);
                return next;
            });
            setRevealedSessionId(null);
        }
    }, [revealedSessionId]);

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
    const [hasLoaded, setHasLoaded] = React.useState(false);

    React.useEffect(() => {
        onRelayStatusChange?.(dotState);
    }, [dotState, onRelayStatusChange]);

    React.useEffect(() => {
        onSessionsChange?.(liveSessions);
    }, [liveSessions, onSessionsChange]);

    React.useEffect(() => {
        const socket = io("/hub", { withCredentials: true });

        socket.on("connect", () => {
            setDotState("connected");
        });

        socket.on("disconnect", () => {
            setDotState("disconnected");
        });

        socket.on("connect_error", () => {
            setDotState("disconnected");
        });

        socket.on("sessions", (data) => {
            setLiveSessions((data.sessions as HubSession[]) ?? []);
            setHasLoaded(true);
        });

        socket.on("session_added", (data) => {
            const s = data as unknown as HubSession;
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
                        runnerId: (s as any).runnerId ?? null,
                        runnerName: (s as any).runnerName ?? null,
                    },
                ];
            });
        });

        socket.on("session_removed", (data) => {
            setLiveSessions((prev) => prev.filter((s) => s.sessionId !== data.sessionId));
        });

        socket.on("session_status", (data) => {
            const { sessionId, isActive, lastHeartbeatAt, model, sessionName, runnerId, runnerName } = data;
            setLiveSessions((prev) =>
                prev.map((s) =>
                    s.sessionId === sessionId
                        ? {
                              ...s,
                              isActive,
                              lastHeartbeatAt,
                              model: model === undefined ? (s.model ?? null) : model,
                              sessionName: sessionName === undefined ? (s.sessionName ?? null) : sessionName,
                              runnerId: runnerId === undefined ? (s.runnerId ?? null) : runnerId,
                              runnerName: runnerName === undefined ? (s.runnerName ?? null) : runnerName,
                          }
                        : s,
                ),
            );
        });

        return () => {
            socket.disconnect();
        };
    }, []);

    const liveGroups = React.useMemo(() => {
        // Group key: runnerId (or "__local__" for sessions not tied to a runner).
        const groups = new Map<string, { label: string; sessions: HubSession[] }>();
        for (const s of liveSessions) {
            const key = s.runnerId ?? "__local__";
            if (!groups.has(key)) {
                const label = s.runnerName?.trim() || (s.runnerId ? `Runner ${s.runnerId.slice(0, 8)}…` : "Local");
                groups.set(key, { label, sessions: [] });
            }
            groups.get(key)!.sessions.push(s);
        }

        // Sort sessions within each group by most recently active/started.
        for (const entry of groups.values()) {
            entry.sessions.sort((a, b) => {
                const aT = Date.parse(a.lastHeartbeatAt ?? a.startedAt);
                const bT = Date.parse(b.lastHeartbeatAt ?? b.startedAt);
                return (Number.isFinite(bT) ? bT : 0) - (Number.isFinite(aT) ? aT : 0);
            });
        }

        // Sort groups: named runners first (alphabetically), then unnamed, then local.
        return new Map(
            Array.from(groups.entries()).sort(([aKey, aVal], [bKey, bVal]) => {
                if (aKey === "__local__") return 1;
                if (bKey === "__local__") return -1;
                return aVal.label.localeCompare(bVal.label);
            }),
        );
    }, [liveSessions]);

    // Find session name for the confirm dialog
    const confirmSession = confirmEndSessionId
        ? liveSessions.find((s) => s.sessionId === confirmEndSessionId)
        : null;
    const confirmSessionLabel = confirmSession?.sessionName?.trim()
        || (confirmEndSessionId ? `Session ${confirmEndSessionId.slice(0, 8)}…` : "");

    const sidebarContent = (
        <aside
            className={cn(
                "flex flex-col h-full bg-sidebar border-r border-sidebar-border flex-shrink-0 overflow-hidden relative w-full",
            )}
        >
            {/* End-session confirmation dialog */}
            <Dialog open={!!confirmEndSessionId} onOpenChange={(open) => { if (!open) setConfirmEndSessionId(null); }}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>End Session</DialogTitle>
                        <DialogDescription>
                            End <span className="font-medium text-foreground">{confirmSessionLabel}</span>? The agent process
                            will be stopped and the session will be closed.
                        </DialogDescription>
                    </DialogHeader>
                    <DialogFooter>
                        <Button variant="outline" onClick={() => setConfirmEndSessionId(null)}>
                            Cancel
                        </Button>
                        <Button
                            variant="destructive"
                            onClick={() => {
                                if (confirmEndSessionId && onEndSession) {
                                    onEndSession(confirmEndSessionId);
                                }
                                setConfirmEndSessionId(null);
                            }}
                        >
                            End Session
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            {/* Sidebar header */}
            <div className="flex items-center justify-between px-3 py-2 border-b border-sidebar-border flex-shrink-0">
                <div className="flex items-center gap-2">
                    {/* Desktop: collapse button */}
                    <Button
                        variant="ghost"
                        size="icon"
                        className="hidden md:inline-flex h-7 w-7 text-sidebar-foreground/60 hover:text-sidebar-foreground hover:bg-sidebar-accent"
                        onClick={() => setCollapsed(true)}
                        aria-label="Collapse sidebar"
                    >
                        <PanelLeftClose className="h-4 w-4" />
                    </Button>
                    {/* Mobile: back/close button */}
                    {onClose && (
                        <Button
                            variant="ghost"
                            size="icon"
                            className="md:hidden h-8 w-8 -ml-1 text-sidebar-foreground/70 hover:text-sidebar-foreground hover:bg-sidebar-accent"
                            onClick={onClose}
                            aria-label="Close sidebar"
                        >
                            <PanelLeftClose className="h-4 w-4" />
                        </Button>
                    )}
                    <span className="text-[0.7rem] font-semibold uppercase tracking-widest text-sidebar-foreground/60">
                        Sessions
                    </span>
                </div>
                <div className="flex items-center gap-1">
                    <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 text-sidebar-foreground/60 hover:text-sidebar-foreground hover:bg-sidebar-accent"
                        onClick={onNewSession}
                        aria-label="New session"
                        title="New session"
                    >
                        <Plus className="h-4 w-4" />
                    </Button>
                    <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 text-sidebar-foreground/60 hover:text-sidebar-foreground hover:bg-sidebar-accent"
                        onClick={onClearSelection}
                        aria-label="Clear selected session"
                        title="Clear selected session"
                    >
                        <X className="h-4 w-4" />
                    </Button>
                </div>
            </div>

            <div className="flex flex-col flex-1 min-h-0 overflow-hidden">
                {/* Runners nav item / Live sessions header */}
                <div className="px-2 pt-2 pb-1 flex-shrink-0">
                    <button
                        onClick={onShowRunners}
                        className={cn(
                            "flex items-center gap-2.5 w-full px-3 py-3 md:py-2 rounded-lg text-sm font-medium transition-colors active:scale-[0.98]",
                            showRunners
                                ? "bg-sidebar-accent text-sidebar-accent-foreground"
                                : "text-sidebar-foreground/70 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground"
                        )}
                    >
                        <HardDrive className={cn("h-4 w-4 flex-shrink-0", showRunners ? "text-primary" : "text-sidebar-foreground/50")} />
                        <span>Runners</span>
                        <div className="ml-auto">
                            <LiveDot state={dotState} />
                        </div>
                    </button>
                </div>

                <ScrollArea className="flex-1 px-2" style={{ paddingBottom: "max(0.5rem, env(safe-area-inset-bottom))" }}>
                    {!hasLoaded ? (
                        <SidebarSkeleton />
                    ) : liveGroups.size === 0 ? (
                        <p className="px-2 py-3 text-xs italic text-sidebar-foreground/40 text-center">No live sessions</p>
                    ) : (
                        Array.from(liveGroups.entries()).map(([groupKey, { label, sessions }]) => (
                            <div key={groupKey} className="flex flex-col mb-2">
                                {/* Group header */}
                                <div className="flex items-center gap-1.5 px-1.5 py-1 min-w-0">
                                    <HardDrive className="h-3 w-3 text-sidebar-foreground/35 flex-shrink-0" />
                                    <span
                                        className="text-[0.65rem] font-medium text-sidebar-foreground/45 truncate flex-1"
                                        title={label}
                                    >
                                        {label}
                                    </span>
                                </div>

                                {/* Session cards */}
                                {sessions.map((s) => {
                                    const isSelected = !showRunners && activeSessionId === s.sessionId;
                                    const provider = s.model?.provider ??
                                        (activeSessionId === s.sessionId ? activeModel?.provider : undefined) ??
                                        "unknown";
                                    const timeLabel = isToday(s.startedAt)
                                        ? formatTime(s.lastHeartbeatAt ?? s.startedAt)
                                        : formatRelativeDate(s.startedAt);
                                    const swipeOffset = swipeOffsets.get(s.sessionId) ?? 0;
                                    const isRevealed = revealedSessionId === s.sessionId;
                                    const hasOffset = swipeOffset !== 0;

                                    return (
                                        <div
                                            key={s.sessionId}
                                            className="relative overflow-clip rounded-lg"
                                        >
                                            {/* "End" action behind the card — only rendered during swipe/reveal */}
                                            {(hasOffset || isRevealed) && <div
                                                className="absolute inset-y-0 right-0 flex items-center justify-center bg-red-600 text-white"
                                                style={{ width: REVEAL_WIDTH }}
                                            >
                                                <button
                                                    className="flex flex-col items-center justify-center w-full h-full text-xs font-semibold gap-0.5 active:bg-red-700 transition-colors"
                                                    onClick={(e) => {
                                                        e.stopPropagation();
                                                        setConfirmEndSessionId(s.sessionId);
                                                        // Close the revealed state
                                                        setSwipeOffsets((prev) => {
                                                            const next = new Map(prev);
                                                            next.delete(s.sessionId);
                                                            return next;
                                                        });
                                                        setRevealedSessionId(null);
                                                    }}
                                                >
                                                    <X className="h-4 w-4" />
                                                    <span>End</span>
                                                </button>
                                            </div>}

                                            {/* Sliding session card */}
                                            <button
                                                onClick={(e) => {
                                                    // Suppress click that fires after a swipe gesture
                                                    if (suppressClickRef.current) { suppressClickRef.current = false; return; }
                                                    // If THIS session is revealed, close it instead of navigating
                                                    if (isRevealed) {
                                                        handleCloseRevealed();
                                                        return;
                                                    }
                                                    // If a DIFFERENT session is revealed, close that and still navigate
                                                    if (revealedSessionId && revealedSessionId !== s.sessionId) {
                                                        handleCloseRevealed();
                                                    }
                                                    onOpenSession(s.sessionId);
                                                }}
                                                title={`View session ${s.sessionId}`}
                                                onPointerDown={(e) => handleSessionPointerDown(e, s.sessionId)}
                                                onPointerMove={handleSessionPointerMove}
                                                onPointerUp={handleSessionPointerUp}
                                                onContextMenu={(e) => e.preventDefault()}
                                                className={cn(
                                                    "relative flex items-center gap-2.5 w-full min-w-0 px-2.5 py-3 md:py-2.5 rounded-lg text-left",
                                                    !hasOffset && "transition-transform duration-200 ease-out",
                                                    isSelected
                                                        ? "bg-sidebar-accent text-sidebar-accent-foreground"
                                                        : "bg-sidebar text-sidebar-foreground hover:bg-sidebar-accent/50",
                                                )}
                                                style={{
                                                    transform: hasOffset ? `translateX(${swipeOffset}px)` : undefined,
                                                    touchAction: "pan-y",
                                                }}
                                            >
                                                {/* Provider icon + activity dot */}
                                                <div className="relative flex-shrink-0 flex items-center justify-center w-7 h-7 rounded-md bg-sidebar-accent/50">
                                                    <ProviderIcon
                                                        provider={provider}
                                                        className="size-4 text-sidebar-foreground/70"
                                                        title={
                                                            s.model?.provider
                                                                ? `${s.model.provider} · ${s.model.name ?? s.model.id}`
                                                                : activeSessionId === s.sessionId && activeModel?.provider
                                                                  ? `${activeModel.provider} · ${activeModel.name ?? activeModel.id}`
                                                                  : "unknown"
                                                        }
                                                    />
                                                    <span
                                                        className={cn(
                                                            "absolute -top-0.5 -right-0.5 inline-block h-2 w-2 rounded-full border border-sidebar ring-1 ring-sidebar transition-colors",
                                                            s.isActive
                                                                ? "bg-blue-400 shadow-[0_0_4px_#60a5fa80] animate-pulse ring-blue-400/20"
                                                                : "bg-green-600 ring-green-600/20",
                                                        )}
                                                        title={s.isActive ? "Actively generating" : "Session idle"}
                                                    />
                                                </div>

                                                {/* Text info */}
                                                <div className="flex-1 min-w-0">
                                                    <div className="flex items-baseline justify-between gap-1 min-w-0">
                                                        <span className="truncate text-[0.8rem] font-medium leading-tight">
                                                            {s.sessionName?.trim() || `Session ${s.sessionId.slice(0, 8)}…`}
                                                        </span>
                                                        <span className="text-[0.65rem] text-sidebar-foreground/45 flex-shrink-0">
                                                            {timeLabel}
                                                        </span>
                                                    </div>
                                                    {(s.userName || s.cwd) && (
                                                        <div className="flex items-center gap-1 mt-0.5 min-w-0">
                                                            {s.userName && (
                                                                <span className="text-[0.65rem] text-sidebar-foreground/45 truncate">
                                                                    {s.userName}
                                                                </span>
                                                            )}
                                                            {s.cwd && (
                                                                <span
                                                                    className="text-[0.65rem] text-sidebar-foreground/35 truncate"
                                                                    title={s.cwd}
                                                                >
                                                                    {s.userName ? "·" : ""} {formatPathTail(s.cwd, 2)}
                                                                </span>
                                                            )}
                                                        </div>
                                                    )}
                                                </div>
                                            </button>
                                        </div>
                                    );
                                })}
                            </div>
                        ))
                    )}
                </ScrollArea>
            </div>
        </aside>
    );

    if (effectiveCollapsed) {
        return (
            <aside className="hidden md:flex flex-col h-full bg-sidebar border-r border-sidebar-border flex-shrink-0 w-12">
                <div className="flex flex-col items-center gap-1 py-2">
                    <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 text-sidebar-foreground/60 hover:text-sidebar-foreground hover:bg-sidebar-accent"
                        onClick={() => setCollapsed(false)}
                        aria-label="Expand sidebar"
                    >
                        <PanelLeftOpen className="h-4 w-4" />
                    </Button>
                    <Button
                        variant="ghost"
                        size="icon"
                        className={cn("h-8 w-8 hover:bg-sidebar-accent", showRunners ? "text-primary" : "text-sidebar-foreground/60 hover:text-sidebar-foreground")}
                        onClick={onShowRunners}
                        title="Runners"
                    >
                        <HardDrive className="h-4 w-4" />
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
