import * as React from "react";
import { Resizable } from "react-resizable";
import { Button } from "@/components/ui/button";
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
import { PanelLeftClose, PanelLeftOpen, Plus, X, HardDrive, FolderOpen, CheckSquare, Square, CheckCheck, Trash2, Pin, PinOff, ChevronDown, ChevronRight, MessageSquare, Copy } from "lucide-react";
import { buildSessionTree, flattenSessionTree, getSessionIndent, getDescendantSessionIds, getGroupCwd } from "@/lib/session-tree";

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
    isPinned?: boolean;
    parentSessionId?: string | null;
}

interface PinnedSession {
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
}

function isPinnedSession(value: unknown): value is PinnedSession {
    if (!value || typeof value !== "object") return false;
    const v = value as Record<string, unknown>;
    return (
        typeof v.sessionId === "string" &&
        typeof v.cwd === "string" &&
        typeof v.shareUrl === "string" &&
        typeof v.startedAt === "string" &&
        typeof v.lastActiveAt === "string" &&
        (typeof v.endedAt === "string" || v.endedAt === null) &&
        typeof v.isEphemeral === "boolean" &&
        (typeof v.expiresAt === "string" || v.expiresAt === null) &&
        v.isPinned === true
    );
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
    /** Called when the user wants to duplicate a session (same runner + working directory) */
    onDuplicateSession?: (runnerId: string, cwd: string) => void;
    /** Called when the user wants to return from Runners view to Sessions */
    onShowSessions?: () => void;
    /** List of runners to display when showRunners is true */
    runners?: Array<{
        runnerId: string;
        name: string | null;
        sessionCount: number;
        version: string | null;
        isOnline: boolean;
    }>;
    /** Currently selected runner ID */
    selectedRunnerId?: string | null;
    /** Called when a runner is selected */
    onSelectRunner?: (runnerId: string) => void;
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
    onDuplicateSession,
    runners,
    selectedRunnerId,
    onSelectRunner,
    onShowSessions,
}: SessionSidebarProps) {
    const [collapsed, setCollapsed] = React.useState(false);

    // Multi-select mode state
    const [selectMode, setSelectMode] = React.useState(false);
    const [selectedSessionIds, setSelectedSessionIds] = React.useState<Set<string>>(new Set());
    const [confirmEndMultiple, setConfirmEndMultiple] = React.useState(false);

    const toggleSelectSession = React.useCallback((sessionId: string) => {
        setSelectedSessionIds((prev) => {
            const next = new Set(prev);
            if (next.has(sessionId)) next.delete(sessionId);
            else next.add(sessionId);
            return next;
        });
    }, []);

    const exitSelectMode = React.useCallback(() => {
        setSelectMode(false);
        setSelectedSessionIds(new Set());
    }, []);

    // Swipe-to-reveal "End" button state (iOS-style swipe-left pattern)
    // Uses pointer events so it works on both touch screens AND desktop trackpads
    // (touch events don't fire on macOS trackpad — only pointer/mouse events do).
    const [confirmEndSessionId, setConfirmEndSessionId] = React.useState<string | null>(null);
    const [revealedSessionId, setRevealedSessionId] = React.useState<string | null>(null);
    const [swipeOffsets, setSwipeOffsets] = React.useState<Map<string, number>>(new Map());
    // Reveal widths: 3 buttons (Duplicate + Pin + End) vs 2 buttons (Pin + End when no runner)
    const REVEAL_WIDTH = 198; // px — Duplicate + Pin + End (session has a runner)
    const REVEAL_WIDTH_NO_RUNNER = 132; // px — Pin + End only (session has no runner)

    const swipeRef = React.useRef<{
        sessionId: string;
        pointerId: number;
        startX: number;
        startY: number;
        curX: number;
        locked: boolean; // true once we've committed to horizontal movement
        isVertical: boolean; // true once we've committed to vertical scroll
        didSwipe: boolean; // true if any significant horizontal movement happened
        revealWidth: number; // effective snap-to width for this session's reveal area
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

    const handleSessionPointerDown = React.useCallback((e: React.PointerEvent, sessionId: string, revealWidth: number = REVEAL_WIDTH) => {
        // Only track primary button (left-click / single touch)
        if (e.button !== 0) return;
        // Prevent the event from bubbling to the App-level sidebar swipe-to-close
        // handler, which would steal pointer capture and interpret any horizontal
        // movement on a session card as a "close sidebar" gesture.
        e.stopPropagation();
        swipeRef.current = {
            sessionId,
            pointerId: e.pointerId,
            startX: e.clientX,
            startY: e.clientY,
            curX: e.clientX,
            locked: false,
            isVertical: false,
            didSwipe: false,
            revealWidth,
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
        const rw = s.revealWidth;
        const base = wasRevealed ? -rw : 0;
        const raw = base + dx;
        // Clamp: allow from -rw (with slight overscroll) to 0 (with slight overscroll)
        const clamped = Math.max(-rw - 20, Math.min(raw, wasRevealed ? 0 : 10));

        setSwipeOffsets((prev) => {
            const next = new Map(prev);
            next.set(s.sessionId, clamped);
            return next;
        });
    }, [revealedSessionId, clearLongPress]);

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
        const rw = s.revealWidth;

        // Snap open if swiped past half the reveal width, otherwise snap closed
        if (offset < -rw / 2) {
            setSwipeOffsets((prev) => {
                const next = new Map(prev);
                next.set(s.sessionId, -rw);
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
    }, [revealedSessionId, swipeOffsets, clearLongPress]);

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

    // ── Pinned sessions ──────────────────────────────────────────────────
    const [pinnedSessions, setPinnedSessions] = React.useState<PinnedSession[]>([]);
    const [pinnedSessionIds, setPinnedSessionIds] = React.useState<Set<string>>(new Set());
    const [pinPendingSessionIds, setPinPendingSessionIds] = React.useState<Set<string>>(new Set());
    const [pinError, setPinError] = React.useState<string | null>(null);
    const [expandedNodeIds, setExpandedNodeIds] = React.useState<Set<string>>(new Set());
    const pinPendingRef = React.useRef<Set<string>>(new Set());

    // Fetch pinned sessions from the API
    const fetchPinnedSessions = React.useCallback(async () => {
        try {
            const res = await fetch("/api/sessions/pinned", { credentials: "include" });
            if (!res.ok) return;
            const body = await res.json();
            const pinned: PinnedSession[] = Array.isArray(body?.pinnedSessions)
                ? body.pinnedSessions.filter(isPinnedSession)
                : [];
            setPinnedSessions(pinned);
            setPinnedSessionIds(new Set(pinned.map((s) => s.sessionId)));
        } catch {
            // best-effort
        }
    }, []);

    React.useEffect(() => {
        fetchPinnedSessions();
    }, [fetchPinnedSessions]);

    const setPinPending = React.useCallback((sessionId: string, pending: boolean) => {
        const next = new Set(pinPendingRef.current);
        if (pending) next.add(sessionId);
        else next.delete(sessionId);
        pinPendingRef.current = next;
        setPinPendingSessionIds(next);
    }, []);

    const togglePinSession = React.useCallback(async (sessionId: string, currentlyPinned: boolean) => {
        if (pinPendingRef.current.has(sessionId)) return;

        setPinError(null);
        setPinPending(sessionId, true);

        const method = currentlyPinned ? "DELETE" : "PUT";

        // Optimistic update — keep both pinnedSessionIds (Set) and
        // pinnedSessions (array) in sync so ended-pinned items disappear
        // immediately when unpinned.
        setPinnedSessionIds((prev) => {
            const next = new Set(prev);
            if (currentlyPinned) next.delete(sessionId);
            else next.add(sessionId);
            return next;
        });

        // Snapshot the removed entry so we can restore it on failure
        let removedPinnedEntry: PinnedSession | undefined;
        if (currentlyPinned) {
            setPinnedSessions((prev) => {
                removedPinnedEntry = prev.find((s) => s.sessionId === sessionId);
                return prev.filter((s) => s.sessionId !== sessionId);
            });
        }

        try {
            const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/pin`, {
                method,
                credentials: "include",
            });

            if (!res.ok) {
                throw new Error(`HTTP ${res.status}`);
            }

            await fetchPinnedSessions();
        } catch {
            // Revert optimistic update
            setPinnedSessionIds((prev) => {
                const next = new Set(prev);
                if (currentlyPinned) next.add(sessionId);
                else next.delete(sessionId);
                return next;
            });
            if (removedPinnedEntry) {
                setPinnedSessions((prev) => [...prev, removedPinnedEntry!]);
            }
            setPinError("Failed to update pinned session. Please try again.");
        } finally {
            setPinPending(sessionId, false);
        }
    }, [fetchPinnedSessions, setPinPending]);

    const selectAllSessions = React.useCallback(() => {
        setSelectedSessionIds(new Set(liveSessions.map((s) => s.sessionId)));
    }, [liveSessions]);

    // Exit select mode when there are no sessions left
    React.useEffect(() => {
        if (selectMode && liveSessions.length === 0) {
            exitSelectMode();
        }
    }, [selectMode, liveSessions.length, exitSelectMode]);

    // Prune selected IDs that no longer exist
    React.useEffect(() => {
        if (!selectMode) return;
        const ids = new Set(liveSessions.map((s) => s.sessionId));
        setSelectedSessionIds((prev) => {
            const next = new Set([...prev].filter((id) => ids.has(id)));
            if (next.size === prev.size) return prev;
            return next;
        });
    }, [selectMode, liveSessions]);

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
                        sessionName: s.sessionName ?? null,
                        isEphemeral: s.isEphemeral,
                        expiresAt: s.expiresAt,
                        isActive: s.isActive ?? false,
                        lastHeartbeatAt: s.lastHeartbeatAt ?? null,
                        model: s.model ?? null,
                        runnerId: s.runnerId ?? null,
                        runnerName: s.runnerName ?? null,
                        parentSessionId: s.parentSessionId ?? null,
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

            // Also refresh pinned entries so late runner-link updates are not
            // lost when the session ends and drops out of liveSessions.
            if (runnerId !== undefined || runnerName !== undefined) {
                setPinnedSessions((prev) =>
                    prev.map((p) =>
                        p.sessionId === sessionId
                            ? {
                                  ...p,
                                  runnerId: runnerId !== undefined ? runnerId : p.runnerId,
                                  runnerName: runnerName !== undefined ? runnerName : p.runnerName,
                              }
                            : p,
                    ),
                );
            }
        });

        return () => {
            socket.disconnect();
        };
    }, []);

    interface ProjectGroup {
        cwd: string;
        label: string;
        sessions: HubSession[];
    }
    interface RunnerGroup {
        key: string;      // runnerId or "__local__"
        label: string;    // runner display name
        isLocal: boolean;
        projects: ProjectGroup[];
    }

    const liveGroups = React.useMemo(() => {
        // Step 1: group sessions by runnerId.
        const runnerMap = new Map<string, { label: string; sessions: HubSession[] }>();
        for (const s of liveSessions) {
            const key = s.runnerId ?? "__local__";
            if (!runnerMap.has(key)) {
                const label = s.runnerName?.trim() || (s.runnerId ? `Runner ${s.runnerId.slice(0, 8)}…` : "Local");
                runnerMap.set(key, { label, sessions: [] });
            }
            runnerMap.get(key)!.sessions.push(s);
        }

        // Step 2: sort sessions within each runner — pinned first, then by most recently active/started.
        for (const entry of runnerMap.values()) {
            entry.sessions.sort((a, b) => {
                const aPinned = pinnedSessionIds.has(a.sessionId) ? 1 : 0;
                const bPinned = pinnedSessionIds.has(b.sessionId) ? 1 : 0;
                if (bPinned !== aPinned) return bPinned - aPinned;
                const aT = Date.parse(a.lastHeartbeatAt ?? a.startedAt);
                const bT = Date.parse(b.lastHeartbeatAt ?? b.startedAt);
                return (Number.isFinite(bT) ? bT : 0) - (Number.isFinite(aT) ? aT : 0);
            });
        }

        // Step 3: for every runner, split sessions into per-cwd project groups.
        // Child sessions (spawned in worktrees or with a parentSessionId) are
        // collapsed under the same project group as their root ancestor.
        const result: RunnerGroup[] = [];
        for (const [key, { label, sessions }] of runnerMap) {
            const isLocal = key === "__local__";

            // Build a lookup map so getGroupCwd can follow parent chains
            const runnerSessionMap = new Map<string, HubSession>(
                sessions.map((s) => [s.sessionId, s]),
            );

            const cwdMap = new Map<string, HubSession[]>();
            for (const s of sessions) {
                const groupCwd = getGroupCwd(s, runnerSessionMap);
                if (!cwdMap.has(groupCwd)) cwdMap.set(groupCwd, []);
                cwdMap.get(groupCwd)!.push(s);
            }

            const projects: ProjectGroup[] = Array.from(cwdMap.entries()).map(([cwd, cwdSessions]) => ({
                cwd,
                label: cwd ? formatPathTail(cwd, 2) : (isLocal ? "Local" : label),
                sessions: cwdSessions,
            }));

            // Sort projects — groups containing a pinned session float first,
            // then by most recently active session within the group.
            projects.sort((a, b) => {
                const hasPinned = (grp: ProjectGroup) =>
                    grp.sessions.some((s) => pinnedSessionIds.has(s.sessionId)) ? 1 : 0;
                const pinDiff = hasPinned(b) - hasPinned(a);
                if (pinDiff !== 0) return pinDiff;
                const latestTs = (grp: ProjectGroup) =>
                    Math.max(0, ...grp.sessions
                        .map((s) => Date.parse(s.lastHeartbeatAt ?? s.startedAt))
                        .filter(Number.isFinite));
                return latestTs(b) - latestTs(a);
            });

            result.push({ key, label, isLocal, projects });
        }

        // Step 4: sort runners — named runners first (alphabetically), then unnamed, then local.
        result.sort((a, b) => {
            if (a.isLocal && !b.isLocal) return 1;
            if (!a.isLocal && b.isLocal) return -1;
            return a.label.localeCompare(b.label);
        });

        return result;
    }, [liveSessions, pinnedSessionIds]);

    // Find session name for the confirm dialog
    const confirmSession = confirmEndSessionId
        ? liveSessions.find((s) => s.sessionId === confirmEndSessionId)
        : null;
    const confirmSessionLabel = confirmSession?.sessionName?.trim()
        || (confirmEndSessionId ? `Session ${confirmEndSessionId.slice(0, 8)}…` : "");

    // Check if the session being ended has child sessions
    const confirmDescendantIds = React.useMemo(
        () => confirmEndSessionId ? getDescendantSessionIds(confirmEndSessionId, liveSessions) : [],
        [confirmEndSessionId, liveSessions],
    );
    const hasDescendants = confirmDescendantIds.length > 0;

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
                            {hasDescendants && (
                                <span className="block mt-1">
                                    This session has {confirmDescendantIds.length} child session{confirmDescendantIds.length !== 1 ? "s" : ""}.
                                </span>
                            )}
                        </DialogDescription>
                    </DialogHeader>
                    <DialogFooter>
                        <Button variant="outline" onClick={() => setConfirmEndSessionId(null)}>
                            Cancel
                        </Button>
                        {hasDescendants && (
                            <Button
                                variant="destructive"
                                onClick={() => {
                                    if (confirmEndSessionId && onEndSession) {
                                        onEndSession(confirmEndSessionId);
                                        for (const id of confirmDescendantIds) {
                                            onEndSession(id);
                                        }
                                    }
                                    setConfirmEndSessionId(null);
                                }}
                            >
                                End Session Group
                            </Button>
                        )}
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

            {/* Multi-select end confirmation dialog */}
            <Dialog open={confirmEndMultiple} onOpenChange={(open) => { if (!open) setConfirmEndMultiple(false); }}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>End {selectedSessionIds.size} Session{selectedSessionIds.size !== 1 ? "s" : ""}</DialogTitle>
                        <DialogDescription>
                            End <span className="font-medium text-foreground">{selectedSessionIds.size} selected session{selectedSessionIds.size !== 1 ? "s" : ""}</span>? The agent processes
                            will be stopped and the sessions will be closed.
                        </DialogDescription>
                    </DialogHeader>
                    <DialogFooter>
                        <Button variant="outline" onClick={() => setConfirmEndMultiple(false)}>
                            Cancel
                        </Button>
                        <Button
                            variant="destructive"
                            onClick={() => {
                                if (onEndSession) {
                                    for (const id of selectedSessionIds) {
                                        onEndSession(id);
                                    }
                                }
                                setConfirmEndMultiple(false);
                                exitSelectMode();
                            }}
                        >
                            End {selectedSessionIds.size} Session{selectedSessionIds.size !== 1 ? "s" : ""}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            {/* Sidebar header */}
            {showRunners ? (
                <div className="flex items-center justify-between px-3 py-2 border-b border-sidebar-border flex-shrink-0">
                    <div className="flex items-center gap-2">
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
                            Runners
                        </span>
                    </div>
                    <div className="flex items-center gap-1">
                        <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 text-sidebar-foreground/60 hover:text-sidebar-foreground hover:bg-sidebar-accent"
                            onClick={onClose}
                            aria-label="Close sidebar"
                            title="Close sidebar"
                        >
                            <X className="h-4 w-4" />
                        </Button>
                    </div>
                </div>
            ) : selectMode ? (
                <div className="flex items-center justify-between px-3 py-2 border-b border-sidebar-border flex-shrink-0">
                    <div className="flex items-center gap-2">
                        <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 text-xs text-sidebar-foreground/70 hover:text-sidebar-foreground hover:bg-sidebar-accent px-2"
                            onClick={exitSelectMode}
                        >
                            Cancel
                        </Button>
                        <span className="text-[0.7rem] font-medium text-sidebar-foreground/60">
                            {selectedSessionIds.size} selected
                        </span>
                    </div>
                    <div className="flex items-center gap-1">
                        <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7 text-sidebar-foreground/60 hover:text-sidebar-foreground hover:bg-sidebar-accent"
                            onClick={() => {
                                if (selectedSessionIds.size === liveSessions.length) {
                                    setSelectedSessionIds(new Set());
                                } else {
                                    selectAllSessions();
                                }
                            }}
                            aria-label={selectedSessionIds.size === liveSessions.length ? "Deselect all" : "Select all"}
                            title={selectedSessionIds.size === liveSessions.length ? "Deselect all" : "Select all"}
                        >
                            <CheckCheck className="h-4 w-4" />
                        </Button>
                        <Button
                            variant="ghost"
                            size="icon"
                            className={cn(
                                "h-7 w-7",
                                selectedSessionIds.size > 0
                                    ? "text-red-500 hover:text-red-600 hover:bg-red-500/10"
                                    : "text-sidebar-foreground/30 cursor-not-allowed",
                            )}
                            onClick={() => {
                                if (selectedSessionIds.size > 0) setConfirmEndMultiple(true);
                            }}
                            disabled={selectedSessionIds.size === 0}
                            aria-label="End selected sessions"
                            title="End selected sessions"
                        >
                            <Trash2 className="h-4 w-4" />
                        </Button>
                    </div>
                </div>
            ) : (
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
                        <span className="text-[0.7rem] font-semibold uppercase tracking-widest text-sidebar-foreground/60">
                            Sessions
                        </span>
                    </div>
                    <div className="flex items-center gap-1">
                        {liveSessions.length > 0 && (
                            <Button
                                variant="ghost"
                                size="icon"
                                className="h-8 w-8 text-sidebar-foreground/60 hover:text-sidebar-foreground hover:bg-sidebar-accent"
                                onClick={() => setSelectMode(true)}
                                aria-label="Select sessions"
                                title="Select sessions"
                            >
                                <CheckSquare className="h-4 w-4" />
                            </Button>
                        )}
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
                            onClick={onClose}
                            aria-label="Clear selected session"
                            title="Clear selected session"
                        >
                            <X className="h-4 w-4" />
                        </Button>
                    </div>
                </div>
            )}

            <div className="flex flex-col flex-1 min-h-0 overflow-hidden">
                {/* Sessions / Runners nav tabs */}
                <div className="mx-3 mt-2 mb-1 flex-shrink-0 flex border-b border-sidebar-border/50">
                    <button
                        onClick={onShowSessions}
                        className={cn(
                            "flex items-center justify-center gap-1.5 px-3 pb-2 text-xs font-medium transition-colors relative",
                            "focus-visible:outline-none",
                            !showRunners
                                ? "text-sidebar-foreground"
                                : "text-sidebar-foreground/40 hover:text-sidebar-foreground/70"
                        )}
                    >
                        <MessageSquare className="h-3.5 w-3.5" />
                        <span>Sessions</span>
                        {!showRunners && <div className="absolute bottom-0 inset-x-1 h-[2px] bg-primary rounded-full" />}
                    </button>
                    <button
                        onClick={onShowRunners}
                        className={cn(
                            "flex items-center justify-center gap-1.5 px-3 pb-2 text-xs font-medium transition-colors relative",
                            "focus-visible:outline-none",
                            showRunners
                                ? "text-sidebar-foreground"
                                : "text-sidebar-foreground/40 hover:text-sidebar-foreground/70"
                        )}
                    >
                        <HardDrive className="h-3.5 w-3.5" />
                        <span>Runners</span>
                        <LiveDot state={dotState} />
                        {showRunners && <div className="absolute bottom-0 inset-x-1 h-[2px] bg-primary rounded-full" />}
                    </button>
                </div>

                {showRunners && runners && (
                    <div className="px-2 mt-1 flex-1 flex flex-col gap-0.5 overflow-y-auto overflow-x-hidden" style={{ paddingBottom: "max(0.5rem, env(safe-area-inset-bottom))" }}>
                        <div className="text-[9px] font-medium text-sidebar-foreground/35 uppercase tracking-widest px-2.5 py-1">
                            Connected Runners
                        </div>
                        {runners.length === 0 ? (
                            <div className="px-2.5 py-4 text-center">
                                <p className="text-xs font-medium text-sidebar-foreground/50">No runners connected</p>
                                <p className="text-[10px] text-sidebar-foreground/30 mt-1">
                                    Run <code className="font-mono bg-sidebar-accent/50 px-1 py-0.5 rounded text-[9px]">pizzapi runner</code> on your machine.
                                </p>
                            </div>
                        ) : (
                            runners.map((r) => (
                                <button
                                    key={r.runnerId}
                                    onClick={() => { onSelectRunner?.(r.runnerId); if (window.innerWidth < 768) onClose?.(); }}
                                    className={cn(
                                        "flex items-center gap-2.5 w-full px-2.5 py-2 rounded-lg text-left transition-colors",
                                        selectedRunnerId === r.runnerId
                                            ? "bg-sidebar-accent border border-sidebar-border"
                                            : r.isOnline
                                                ? "hover:bg-sidebar-accent/50 opacity-70"
                                                : "opacity-30"
                                    )}
                                >
                                    <div className="relative flex-shrink-0">
                                        <div className={cn(
                                            "h-[7px] w-[7px] rounded-full",
                                            r.isOnline ? "bg-green-500 shadow-[0_0_6px_rgba(34,197,94,0.4)]" : "bg-sidebar-foreground/30"
                                        )} />
                                    </div>
                                    <div className="flex-1 min-w-0">
                                        <div className="text-xs font-semibold truncate">{r.name || "Unnamed Runner"}</div>
                                        <div className="text-[9px] font-mono text-sidebar-foreground/40 mt-0.5">
                                            {r.isOnline ? `${r.sessionCount} session${r.sessionCount !== 1 ? "s" : ""}` : "offline"}
                                        </div>
                                    </div>
                                </button>
                            ))
                        )}
                    </div>
                )}

                {!showRunners && <div className="flex-1 px-2 overflow-y-auto overflow-x-hidden" style={{ paddingBottom: "max(0.5rem, env(safe-area-inset-bottom))" }}>
                    {pinError && (
                        <p role="alert" aria-live="polite" className="px-2 py-2 text-[0.7rem] text-red-400">
                            {pinError}
                        </p>
                    )}

                    {!hasLoaded ? (
                        <SidebarSkeleton />
                    ) : liveGroups.length === 0 ? (
                        <p className="px-2 py-3 text-xs italic text-sidebar-foreground/40 text-center">No live sessions</p>
                    ) : (
                        liveGroups.map((runnerGroup) => (
                            <div key={runnerGroup.key} className="flex flex-col mb-2">
                                {/* Runner header */}
                                <div className="flex items-center gap-1.5 px-1.5 py-1 min-w-0">
                                    <HardDrive className="h-3 w-3 text-sidebar-foreground/35 flex-shrink-0" />
                                    <span
                                        className="text-[0.65rem] font-medium text-sidebar-foreground/45 truncate flex-1"
                                        title={runnerGroup.label}
                                    >
                                        {runnerGroup.label}
                                    </span>
                                </div>

                                {/* Project groups within this runner */}
                                {runnerGroup.projects.map((project) => (
                                    <div key={project.cwd || "__root__"}>
                                        {/* Project sub-header — only shown when there are multiple projects */}
                                        {runnerGroup.projects.length > 1 && (
                                            <div className="flex items-center gap-1.5 pl-4 pr-1.5 py-0.5 min-w-0">
                                                <FolderOpen className="h-2.5 w-2.5 text-sidebar-foreground/25 flex-shrink-0" />
                                                <span
                                                    className="text-[0.6rem] font-medium text-sidebar-foreground/35 truncate flex-1"
                                                    title={project.cwd || project.label}
                                                >
                                                    {project.label}
                                                </span>
                                            </div>
                                        )}

                                        {/* Session cards — organized in tree structure */}
                                        {(() => {
                                            const sessionTree = buildSessionTree(project.sessions);
                                            const flatSessions = flattenSessionTree(sessionTree, expandedNodeIds);
                                            
                                            // Build a map of sessionId -> children count for the collapse toggle
                                            const childrenByParent = new Map<string, number>();
                                            for (const child of project.sessions) {
                                              if (child.parentSessionId) {
                                                childrenByParent.set(
                                                  child.parentSessionId,
                                                  (childrenByParent.get(child.parentSessionId) ?? 0) + 1
                                                );
                                              }
                                            }
                                            
                                            return flatSessions.map(({ session: s, depth, isExpanded }) => {
                                            // Hide cwd on individual cards when the runner is already
                                            // split into project sub-groups (avoids redundant display).
                                            const showCwd = runnerGroup.projects.length === 1;
                                            const isActiveSession = !showRunners && activeSessionId === s.sessionId;
                                            const isChecked = selectedSessionIds.has(s.sessionId);
                                            const provider = s.model?.provider ??
                                                (activeSessionId === s.sessionId ? activeModel?.provider : undefined) ??
                                                "unknown";
                                            const timeLabel = isToday(s.startedAt)
                                                ? formatTime(s.lastHeartbeatAt ?? s.startedAt)
                                                : formatRelativeDate(s.startedAt);
                                            const isPinned = pinnedSessionIds.has(s.sessionId);
                                            const isPinPending = pinPendingSessionIds.has(s.sessionId);
                                            const swipeOffset = swipeOffsets.get(s.sessionId) ?? 0;
                                            const isRevealed = revealedSessionId === s.sessionId;
                                            const hasOffset = swipeOffset !== 0;

                                            return (
                                                <div
                                                    key={s.sessionId}
                                                    className="relative overflow-hidden rounded-lg"
                                                >
                                                    {/* "Duplicate" + "Pin" + "End" actions behind the card — only rendered during swipe/reveal (not in select mode) */}
                                                    {/* Width adapts: 3 buttons when session has a runner, 2 buttons otherwise */}
                                                    {!selectMode && (hasOffset || isRevealed) && <div
                                                        className="absolute inset-y-0 right-0 flex items-stretch rounded-r-lg overflow-hidden"
                                                        style={{ width: s.runnerId ? REVEAL_WIDTH : REVEAL_WIDTH_NO_RUNNER }}
                                                    >
                                                        {s.runnerId && (
                                                        <button
                                                            className="flex flex-col items-center justify-center flex-1 text-xs font-semibold gap-0.5 bg-violet-500 text-white active:bg-violet-600 transition-colors"
                                                            onClick={(e) => {
                                                                e.stopPropagation();
                                                                onDuplicateSession?.(s.runnerId!, s.cwd || "");
                                                                // Close the revealed state
                                                                setSwipeOffsets((prev) => {
                                                                    const next = new Map(prev);
                                                                    next.delete(s.sessionId);
                                                                    return next;
                                                                });
                                                                setRevealedSessionId(null);
                                                            }}
                                                            aria-label="Duplicate session"
                                                            title="New session with same runner & directory"
                                                        >
                                                            <Copy className="h-4 w-4" />
                                                            <span>Duplicate</span>
                                                        </button>
                                                        )}
                                                        <button
                                                            className={cn(
                                                                "flex flex-col items-center justify-center flex-1 text-xs font-semibold gap-0.5 bg-blue-500 text-white transition-colors",
                                                                isPinPending ? "opacity-60 cursor-not-allowed" : "active:bg-blue-600",
                                                            )}
                                                            onClick={(e) => {
                                                                e.stopPropagation();
                                                                if (isPinPending) return;
                                                                togglePinSession(s.sessionId, isPinned);
                                                                // Close the revealed state
                                                                setSwipeOffsets((prev) => {
                                                                    const next = new Map(prev);
                                                                    next.delete(s.sessionId);
                                                                    return next;
                                                                });
                                                                setRevealedSessionId(null);
                                                            }}
                                                            disabled={isPinPending}
                                                            aria-label={isPinned ? "Unpin session" : "Pin session"}
                                                        >
                                                            {isPinned ? <PinOff className="h-4 w-4" /> : <Pin className="h-4 w-4" />}
                                                            <span>{isPinPending ? "Saving" : isPinned ? "Unpin" : "Pin"}</span>
                                                        </button>
                                                        <button
                                                            className="flex flex-col items-center justify-center flex-1 pt-1 text-xs font-semibold gap-0.5 bg-red-600 text-white active:bg-red-700 transition-colors"
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
                                                            if (selectMode) {
                                                                toggleSelectSession(s.sessionId);
                                                                return;
                                                            }
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
                                                        title={selectMode
                                                            ? `Toggle selection for ${s.sessionName?.trim() || s.sessionId.slice(0, 8)}`
                                                            : `View session ${s.sessionId} (press P to ${isPinned ? "unpin" : "pin"})`}
                                                        onKeyDown={(e) => {
                                                            if (selectMode) return;
                                                            if (e.key.toLowerCase() !== "p") return;
                                                            e.preventDefault();
                                                            e.stopPropagation();
                                                            togglePinSession(s.sessionId, isPinned);
                                                        }}
                                                        onPointerDown={selectMode ? undefined : (e) => handleSessionPointerDown(e, s.sessionId, s.runnerId ? REVEAL_WIDTH : REVEAL_WIDTH_NO_RUNNER)}
                                                        onPointerMove={selectMode ? undefined : handleSessionPointerMove}
                                                        onPointerUp={selectMode ? undefined : handleSessionPointerUp}
                                                        onContextMenu={(e) => e.preventDefault()}
                                                        className={cn(
                                                            "relative flex items-center gap-2.5 w-full min-w-0 px-2.5 py-3 md:py-2.5 text-left rounded-md",
                                                            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
                                                            !hasOffset && "transition-transform duration-200 ease-out",
                                                            selectMode && isChecked
                                                                ? "bg-sidebar-accent text-sidebar-accent-foreground"
                                                                : isActiveSession
                                                                    ? "bg-sidebar-accent text-sidebar-accent-foreground"
                                                                    : "bg-sidebar text-sidebar-foreground hover:bg-sidebar-accent/50",
                                                        )}
                                                        style={{
                                                            transform: !selectMode && hasOffset ? `translateX(${swipeOffset}px)` : undefined,
                                                            touchAction: selectMode ? undefined : "pan-y",
                                                            marginLeft: `${getSessionIndent(depth)}px`,
                                                        }}
                                                    >
                                                        {/* Expand/collapse toggle for parent sessions */}
                                                        {(() => {
                                                            const childCount = childrenByParent.get(s.sessionId) ?? 0;
                                                            if (childCount > 0) {
                                                              return (
                                                                <span
                                                                  role="button"
                                                                  tabIndex={0}
                                                                  onPointerDown={(e) => {
                                                                    // Stop the parent session button from capturing the
                                                                    // pointer — without this, setPointerCapture steals
                                                                    // subsequent events and the click never fires.
                                                                    e.stopPropagation();
                                                                  }}
                                                                  onClick={(e) => {
                                                                    e.stopPropagation();
                                                                    setExpandedNodeIds(prev => {
                                                                      const next = new Set(prev);
                                                                      if (next.has(s.sessionId)) {
                                                                        next.delete(s.sessionId);
                                                                      } else {
                                                                        next.add(s.sessionId);
                                                                      }
                                                                      return next;
                                                                    });
                                                                  }}
                                                                  onKeyDown={(e) => {
                                                                    if (e.key === "Enter" || e.key === " ") {
                                                                      e.preventDefault();
                                                                      e.stopPropagation();
                                                                      setExpandedNodeIds(prev => {
                                                                        const next = new Set(prev);
                                                                        if (next.has(s.sessionId)) {
                                                                          next.delete(s.sessionId);
                                                                        } else {
                                                                          next.add(s.sessionId);
                                                                        }
                                                                        return next;
                                                                      });
                                                                    }
                                                                  }}
                                                                  className="flex-shrink-0 text-sidebar-foreground/50 hover:text-sidebar-foreground/70 transition-colors cursor-pointer"
                                                                  aria-label={isExpanded ? "Collapse" : "Expand"}
                                                                >
                                                                  {isExpanded ? (
                                                                    <ChevronDown className="h-4 w-4" />
                                                                  ) : (
                                                                    <ChevronRight className="h-4 w-4" />
                                                                  )}
                                                                </span>
                                                              );
                                                            }
                                                            return null;
                                                        })()}

                                                        {/* Select mode checkbox */}
                                                        {selectMode && (
                                                            <div className="flex-shrink-0 flex items-center justify-center w-5 h-5">
                                                                {isChecked ? (
                                                                    <CheckSquare className="h-4 w-4 text-primary" />
                                                                ) : (
                                                                    <Square className="h-4 w-4 text-sidebar-foreground/40" />
                                                                )}
                                                            </div>
                                                        )}

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

                                                        {/* Pin toggle */}
                                                        {!selectMode && (
                                                            <span
                                                                role="button"
                                                                tabIndex={-1}
                                                                className={cn(
                                                                    "flex-shrink-0 flex items-center justify-center w-5 h-5 rounded transition-colors",
                                                                    isPinned
                                                                        ? "text-blue-400 hover:text-blue-300"
                                                                        : "text-sidebar-foreground/20 hover:text-sidebar-foreground/40",
                                                                    isPinPending && "opacity-50 pointer-events-none",
                                                                )}
                                                                onClick={(e) => {
                                                                    e.stopPropagation();
                                                                    e.preventDefault();
                                                                    if (!isPinPending) togglePinSession(s.sessionId, isPinned);
                                                                }}
                                                                onPointerDown={(e) => e.stopPropagation()}
                                                                aria-label={isPinned ? "Unpin session" : "Pin session"}
                                                                title={isPinned ? "Unpin" : "Pin"}
                                                            >
                                                                <Pin className={cn("h-3.5 w-3.5", isPinned && "fill-blue-400/30")} />
                                                            </span>
                                                        )}

                                                        {/* Text info */}
                                                        <div className="flex-1 min-w-0">
                                                            <div className="flex items-baseline justify-between gap-1 min-w-0">
                                                                <span className="truncate text-[0.8rem] font-medium leading-tight">
                                                                    {s.parentSessionId && (
                                                                        <span className="text-[0.6rem] text-blue-400/70 mr-1" title="Child session">↳</span>
                                                                    )}
                                                                    {s.sessionName?.trim() || `Session ${s.sessionId.slice(0, 8)}…`}
                                                                </span>
                                                                <span className="text-[0.65rem] text-sidebar-foreground/45 flex-shrink-0">
                                                                    {timeLabel}
                                                                </span>
                                                            </div>
                                                            {/* Worktree badge — shown when cwd is inside a .worktrees/ directory */}
                                                            {(() => {
                                                                const cwd = s.cwd || "";
                                                                const match = cwd.match(/\/\.worktrees\/([^/]+)/);
                                                                return match ? (
                                                                    <div className="flex items-center gap-1 mt-0.5">
                                                                        <span
                                                                            className="text-[0.55rem] bg-amber-500/15 text-amber-400/80 px-1 py-0.5 rounded font-mono leading-none truncate max-w-full"
                                                                            title={`Worktree: ${match[1]}`}
                                                                        >
                                                                            {match[1]}
                                                                        </span>
                                                                    </div>
                                                                ) : null;
                                                            })()}
                                                            {(s.userName || (showCwd && s.cwd)) && (
                                                                <div className="flex items-center gap-1 mt-0.5 min-w-0">
                                                                    {s.userName && (
                                                                        <span className="text-[0.65rem] text-sidebar-foreground/45 truncate">
                                                                            {s.userName}
                                                                        </span>
                                                                    )}
                                                                    {showCwd && s.cwd && (
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
                                            });
                                            })()}
                                    </div>
                                ))}
                            </div>
                        ))
                    )}

                    {/* ── Pinned (ended) sessions ──────────────────────────────── */}
                    {(() => {
                        const liveIds = new Set(liveSessions.map((s) => s.sessionId));
                        const endedPinned = pinnedSessions.filter(
                            (p) => p.isPinned && !liveIds.has(p.sessionId),
                        );
                        if (endedPinned.length === 0) return null;
                        return (
                            <div className="mt-3 border-t border-sidebar-border pt-2">
                                <div className="flex items-center gap-1.5 px-1.5 py-1 min-w-0">
                                    <Pin className="h-3 w-3 text-blue-400/60 flex-shrink-0" />
                                    <span className="text-[0.65rem] font-medium text-sidebar-foreground/45 truncate flex-1">
                                        Pinned
                                    </span>
                                </div>
                                {endedPinned.map((p) => {
                                    const isActiveSession = !showRunners && activeSessionId === p.sessionId;
                                    const timeLabel = isToday(p.startedAt)
                                        ? formatTime(p.lastActiveAt)
                                        : formatRelativeDate(p.startedAt);
                                    const isPinPending = pinPendingSessionIds.has(p.sessionId);
                                    const swipeOffset = swipeOffsets.get(p.sessionId) ?? 0;
                                    const isRevealed = revealedSessionId === p.sessionId;
                                    const hasOffset = swipeOffset !== 0;

                                    return (
                                        <div
                                            key={p.sessionId}
                                            className="relative overflow-hidden rounded-lg"
                                        >
                                            {/* "Unpin" action behind the card — uses REVEAL_WIDTH to match swipe snap distance */}
                                            {(hasOffset || isRevealed) && <div
                                                className="absolute inset-y-0 right-0 flex items-stretch rounded-r-lg overflow-hidden"
                                                style={{ width: REVEAL_WIDTH }}
                                            >
                                                <button
                                                    className={cn(
                                                        "flex flex-col items-center justify-center w-1/2 text-xs font-semibold gap-0.5 bg-blue-500 text-white transition-colors",
                                                        isPinPending ? "opacity-60 cursor-not-allowed" : "active:bg-blue-600",
                                                    )}
                                                    onClick={(e) => {
                                                        e.stopPropagation();
                                                        if (isPinPending) return;
                                                        togglePinSession(p.sessionId, true);
                                                        setSwipeOffsets((prev) => {
                                                            const next = new Map(prev);
                                                            next.delete(p.sessionId);
                                                            return next;
                                                        });
                                                        setRevealedSessionId(null);
                                                    }}
                                                    disabled={isPinPending}
                                                    aria-label={`Unpin session ${p.sessionId.slice(0, 8)}`}
                                                >
                                                    <PinOff className="h-4 w-4" />
                                                    <span>{isPinPending ? "Saving" : "Unpin"}</span>
                                                </button>
                                            </div>}

                                            {/* Sliding session card */}
                                            <button
                                                type="button"
                                                onClick={() => {
                                                    if (suppressClickRef.current) { suppressClickRef.current = false; return; }
                                                    if (isRevealed) {
                                                        handleCloseRevealed();
                                                        return;
                                                    }
                                                    if (revealedSessionId && revealedSessionId !== p.sessionId) {
                                                        handleCloseRevealed();
                                                    }
                                                    onOpenSession(p.sessionId);
                                                }}
                                                onPointerDown={(e) => handleSessionPointerDown(e, p.sessionId)}
                                                onPointerMove={handleSessionPointerMove}
                                                onPointerUp={handleSessionPointerUp}
                                                onContextMenu={(e) => e.preventDefault()}
                                                title={`View pinned session ${p.sessionId}`}
                                                className={cn(
                                                    "flex items-center gap-2.5 w-full min-w-0 px-2.5 py-3 md:py-2.5 text-left",
                                                    !hasOffset && "transition-transform duration-200 ease-out",
                                                    isActiveSession
                                                        ? "bg-sidebar-accent text-sidebar-accent-foreground"
                                                        : "bg-sidebar text-sidebar-foreground/60 hover:bg-sidebar-accent/50",
                                                )}
                                                style={{
                                                    transform: hasOffset ? `translateX(${swipeOffset}px)` : undefined,
                                                    touchAction: "pan-y",
                                                }}
                                            >
                                                <div className="relative flex-shrink-0 flex items-center justify-center w-7 h-7 rounded-md bg-sidebar-accent/30">
                                                    <Pin className="size-4 text-blue-400/70" />
                                                </div>
                                                <div className="flex-1 min-w-0">
                                                    <div className="flex items-baseline justify-between gap-1 min-w-0">
                                                        <span className="truncate text-[0.8rem] font-medium leading-tight opacity-70">
                                                            {`Session ${p.sessionId.slice(0, 8)}…`}
                                                        </span>
                                                        <span className="text-[0.65rem] text-sidebar-foreground/35 flex-shrink-0">
                                                            {timeLabel}
                                                        </span>
                                                    </div>
                                                    <div className="flex items-center gap-1 mt-0.5 min-w-0">
                                                        <span className="text-[0.65rem] text-sidebar-foreground/30 truncate" title={p.cwd}>
                                                            {formatPathTail(p.cwd, 2)}
                                                        </span>
                                                        {(p.runnerName || p.runnerId) && (
                                                            <span className="text-[0.6rem] text-sidebar-foreground/25 truncate max-w-[6rem]" title={p.runnerName ?? `Runner ${p.runnerId}`}>
                                                                · {p.runnerName || `Runner ${p.runnerId?.slice(0, 8)}…`}
                                                            </span>
                                                        )}
                                                        <span className="text-[0.6rem] text-sidebar-foreground/25">· ended</span>
                                                    </div>
                                                </div>

                                                {/* Desktop: inline unpin icon */}
                                                <div
                                                    className={cn(
                                                        "hidden md:flex flex-shrink-0 p-1 rounded transition-colors",
                                                        isPinPending
                                                            ? "opacity-60 cursor-not-allowed"
                                                            : "hover:bg-sidebar-accent/80 text-sidebar-foreground/40 hover:text-sidebar-foreground/70",
                                                    )}
                                                    role="button"
                                                    tabIndex={0}
                                                    onClick={(e) => {
                                                        e.stopPropagation();
                                                        if (!isPinPending) togglePinSession(p.sessionId, true);
                                                    }}
                                                    onKeyDown={(e) => {
                                                        if (e.key === "Enter" || e.key === " ") {
                                                            e.preventDefault();
                                                            e.stopPropagation();
                                                            if (!isPinPending) togglePinSession(p.sessionId, true);
                                                        }
                                                    }}
                                                    title="Unpin session"
                                                    aria-label={`Unpin session ${p.sessionId.slice(0, 8)}`}
                                                >
                                                    <PinOff className="h-3.5 w-3.5" />
                                                </div>
                                            </button>
                                        </div>
                                    );
                                })}
                            </div>
                        );
                    })()}
                </div>}
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
