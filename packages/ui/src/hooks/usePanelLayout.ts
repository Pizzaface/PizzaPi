import * as React from "react";
import type { TerminalTab } from "@/components/TerminalManager";

// ── 9-Zone panel position ─────────────────────────────────────────────────────
// Layout grid (center-middle = main content, not a dock target):
//   ┌──────────┬──────────────┬──────────┐
//   │ left-top │  center-top  │right-top │
//   ├──────────┤              ├──────────┤
//   │left-mid  │  MAIN CONTENT│right-mid │
//   ├──────────┤              ├──────────┤
//   │left-bot  │ center-bot   │right-bot │
//   └──────────┴──────────────┴──────────┘
export type PanelPosition =
  | "left-top"    | "left-middle"    | "left-bottom"
  | "center-top"  | "center-bottom"
  | "right-top"   | "right-middle"   | "right-bottom";

/** Migrate old 3-value localStorage position strings → new 8-value format. */
function migratePanelPosition(raw: string | null, fallback: PanelPosition): PanelPosition {
  if (!raw) return fallback;
  if (raw === "left") return "left-middle";
  if (raw === "right") return "right-middle";
  if (raw === "bottom") return "center-bottom";
  const valid: readonly PanelPosition[] = [
    "left-top", "left-middle", "left-bottom",
    "center-top", "center-bottom",
    "right-top", "right-middle", "right-bottom",
  ];
  return (valid as readonly string[]).includes(raw) ? (raw as PanelPosition) : fallback;
}

// ── Resize direction ──────────────────────────────────────────────────────────
type ResizeDir =
  | "col-left"           // drag left-column right edge → adjust leftColumnWidth
  | "col-right"          // drag right-column left edge → adjust rightColumnWidth
  | "zone-left-top"      // drag handle under left-top → adjust leftTopHeight
  | "zone-left-bottom"   // drag handle above left-bottom → adjust leftBottomHeight
  | "zone-right-top"
  | "zone-right-bottom"
  | "zone-center-top"
  | "zone-center-bottom"
  | null;

// ── Size bounds ───────────────────────────────────────────────────────────────
const COL_MIN  = 200;
const COL_MAX  = 1400;
const ZONE_MIN = 80;
const ZONE_MAX = 900;

function clampColWidth(v: number)    { return Math.max(COL_MIN, Math.min(v, COL_MAX)); }
function clampZoneHeight(v: number)  { return Math.max(ZONE_MIN, Math.min(v, ZONE_MAX)); }

function loadColWidth(key: string, def: number): number {
  try {
    const raw = localStorage.getItem(key);
    if (raw) return clampColWidth(parseInt(raw, 10));
  } catch {}
  return def;
}
function loadZoneHeight(key: string, def: number): number {
  try {
    const raw = localStorage.getItem(key);
    if (raw) return clampZoneHeight(parseInt(raw, 10));
  } catch {}
  return def;
}
function saveNum(key: string, value: number) {
  try { localStorage.setItem(key, String(Math.round(value))); } catch {}
}
function loadPos(key: string, fallback: PanelPosition): PanelPosition {
  try { return migratePanelPosition(localStorage.getItem(key), fallback); } catch { return fallback; }
}
function savePos(key: string, pos: PanelPosition) {
  try { localStorage.setItem(key, pos); } catch {}
}

// ── Public interface ──────────────────────────────────────────────────────────
export interface PanelLayoutState {
  // ── Column widths ──────────────────────────────────────────────────────────
  leftColumnWidth: number;
  rightColumnWidth: number;

  // ── Zone heights (for the 6 non-fill zones) ────────────────────────────────
  leftTopHeight: number;
  leftBottomHeight: number;
  rightTopHeight: number;
  rightBottomHeight: number;
  centerTopHeight: number;
  centerBottomHeight: number;

  // ── Main layout container ref ──────────────────────────────────────────────
  // Attach to the outermost layout div; used for all resize + drag calculations.
  terminalColumnRef: React.RefObject<HTMLDivElement | null>;

  // ── Column + zone resize starters ─────────────────────────────────────────
  startColumnWidthResize: (side: "left" | "right", e: React.PointerEvent) => void;
  startZoneHeightResize: (zone: PanelPosition, e: React.PointerEvent) => void;

  // ── Drag-to-reposition ─────────────────────────────────────────────────────
  panelDragActive: boolean;
  panelDragZone: PanelPosition | null;
  startPanelDragWith: (e: React.PointerEvent, applyPosition: (pos: PanelPosition) => void) => void;

  // ── Combined outer pointer handlers (resize + drag) ────────────────────────
  handleOuterPointerMove: (e: React.PointerEvent) => void;
  handleOuterPointerUp: () => void;

  // ── Combined panel tab state ───────────────────────────────────────────────
  combinedActiveTab: string;
  handleCombinedTabChange: (tab: string) => void;
  handleCombinedPositionChange: (pos: PanelPosition) => void;

  // ── Lifted terminal tab state ──────────────────────────────────────────────
  terminalTabs: TerminalTab[];
  activeTerminalId: string | null;
  setActiveTerminalId: React.Dispatch<React.SetStateAction<string | null>>;
  handleTerminalTabAdd: (tab: TerminalTab) => void;
  handleTerminalTabClose: (terminalId: string) => void;

  // ── Terminal panel ─────────────────────────────────────────────────────────
  showTerminal: boolean;
  setShowTerminal: React.Dispatch<React.SetStateAction<boolean>>;
  terminalPosition: PanelPosition;
  handleTerminalPositionChange: (pos: PanelPosition) => void;

  // ── File explorer panel ────────────────────────────────────────────────────
  showFileExplorer: boolean;
  setShowFileExplorer: React.Dispatch<React.SetStateAction<boolean>>;
  filesPosition: PanelPosition;
  handleFilesPositionChange: (pos: PanelPosition) => void;

  // ── Git panel ─────────────────────────────────────────────────────────────
  showGit: boolean;
  setShowGit: React.Dispatch<React.SetStateAction<boolean>>;
  gitPosition: PanelPosition;
  handleGitPositionChange: (pos: PanelPosition) => void;

  // ── Triggers panel ────────────────────────────────────────────────────────
  showTriggers: boolean;
  setShowTriggers: React.Dispatch<React.SetStateAction<boolean>>;
  triggersPosition: PanelPosition;
  handleTriggersPositionChange: (pos: PanelPosition) => void;
}

// ── Terminal-prune grace period ───────────────────────────────────────────────
// How long a session may be absent from liveSessionIds before we treat it as
// ended. A same-ID reconnect broadcasts session_removed *before*
// session_added (server: registerTuiSession -> endSharedSessionUnlocked), and
// an empty/partial "sessions" resync can transiently drop an entry too — both
// recover well within this window in the normal case.
const TERMINAL_PRUNE_GRACE_MS = 5000;

// ── Hook ──────────────────────────────────────────────────────────────────────
export function usePanelLayout(
  activeSessionId: string | null,
  liveSessionIds?: string[],
  /**
   * Fresh, authoritative re-check for whether a session that's been absent
   * from liveSessionIds for the full grace period is REALLY gone (e.g. a
   * dedicated /api/sessions fetch), independent of the live discovery feed's
   * own (possibly still-recovering) state. Required to actually prune —
   * without it, absent sessions are never confirmed ended and their tabs are
   * left alone (fail safe: never prune on an unconfirmed signal).
   *
   * This is UI-only bookkeeping: pruning here only removes a stale tab so its
   * WebTerminal unmounts and drops its socket. It never emits kill_terminal —
   * the remote PTY is killed by the SERVER on confirmed session end (see
   * endSharedSession), cross-node-safe via emitToRunner, so a wrongly-kept or
   * wrongly-dropped tab here is a display nit, never an orphaned-or-killed
   * live shell.
   */
  confirmSessionEnded?: (sessionId: string) => Promise<boolean>,
): PanelLayoutState {
  // ── Column widths ───────────────────────────────────────────────────────
  const [leftColumnWidth, setLeftColumnWidth] = React.useState(() =>
    // Migrate from legacy pp-terminal-width / pp-files-width if present
    loadColWidth("pp-left-col-width",
      loadColWidth("pp-terminal-width",
        loadColWidth("pp-files-width", 320))),
  );
  const [rightColumnWidth, setRightColumnWidth] = React.useState(() =>
    loadColWidth("pp-right-col-width",
      loadColWidth("pp-terminal-width", 320)),
  );

  // ── Zone heights ────────────────────────────────────────────────────────
  const [leftTopHeight, setLeftTopHeight] = React.useState(() =>
    loadZoneHeight("pp-zone-left-top-h", 200));
  const [leftBottomHeight, setLeftBottomHeight] = React.useState(() =>
    loadZoneHeight("pp-zone-left-bottom-h", 200));
  const [rightTopHeight, setRightTopHeight] = React.useState(() =>
    loadZoneHeight("pp-zone-right-top-h", 200));
  const [rightBottomHeight, setRightBottomHeight] = React.useState(() =>
    loadZoneHeight("pp-zone-right-bottom-h", 200));
  const [centerTopHeight, setCenterTopHeight] = React.useState(() =>
    loadZoneHeight("pp-zone-center-top-h",
      // migrate from old pp-terminal-height (which was the bottom panel height)
      loadZoneHeight("pp-terminal-height", 200)));
  const [centerBottomHeight, setCenterBottomHeight] = React.useState(() =>
    loadZoneHeight("pp-zone-center-bottom-h",
      loadZoneHeight("pp-terminal-height", 280)));

  // ── Main layout container ref ───────────────────────────────────────────
  const terminalColumnRef = React.useRef<HTMLDivElement>(null);

  // ── Resize ──────────────────────────────────────────────────────────────
  const resizeDir = React.useRef<ResizeDir>(null);

  const startColumnWidthResize = React.useCallback((side: "left" | "right", e: React.PointerEvent) => {
    e.preventDefault();
    resizeDir.current = side === "left" ? "col-left" : "col-right";
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }, []);

  const startZoneHeightResize = React.useCallback((zone: PanelPosition, e: React.PointerEvent) => {
    e.preventDefault();
    const dirMap: Partial<Record<PanelPosition, ResizeDir>> = {
      "left-top":      "zone-left-top",
      "left-bottom":   "zone-left-bottom",
      "right-top":     "zone-right-top",
      "right-bottom":  "zone-right-bottom",
      "center-top":    "zone-center-top",
      "center-bottom": "zone-center-bottom",
    };
    resizeDir.current = dirMap[zone] ?? null;
    if (resizeDir.current) {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    }
  }, []);

  const handleResizeMove = React.useCallback((e: React.PointerEvent) => {
    const dir = resizeDir.current;
    if (!dir || !terminalColumnRef.current) return;
    const rect = terminalColumnRef.current.getBoundingClientRect();

    switch (dir) {
      case "col-left":
        setLeftColumnWidth(clampColWidth(e.clientX - rect.left));
        break;
      case "col-right":
        setRightColumnWidth(clampColWidth(rect.right - e.clientX));
        break;
      case "zone-left-top":
        setLeftTopHeight(clampZoneHeight(e.clientY - rect.top));
        break;
      case "zone-left-bottom":
        setLeftBottomHeight(clampZoneHeight(rect.bottom - e.clientY));
        break;
      case "zone-right-top":
        setRightTopHeight(clampZoneHeight(e.clientY - rect.top));
        break;
      case "zone-right-bottom":
        setRightBottomHeight(clampZoneHeight(rect.bottom - e.clientY));
        break;
      case "zone-center-top":
        setCenterTopHeight(clampZoneHeight(e.clientY - rect.top));
        break;
      case "zone-center-bottom":
        setCenterBottomHeight(clampZoneHeight(rect.bottom - e.clientY));
        break;
    }
  }, []);

  const handleResizeEnd = React.useCallback(() => {
    const dir = resizeDir.current;
    if (!dir) return;
    resizeDir.current = null;
    // Persist on pointer-up
    switch (dir) {
      case "col-left":      setLeftColumnWidth((v)      => { saveNum("pp-left-col-width",           v); return v; }); break;
      case "col-right":     setRightColumnWidth((v)     => { saveNum("pp-right-col-width",          v); return v; }); break;
      case "zone-left-top":    setLeftTopHeight((v)     => { saveNum("pp-zone-left-top-h",          v); return v; }); break;
      case "zone-left-bottom": setLeftBottomHeight((v)  => { saveNum("pp-zone-left-bottom-h",       v); return v; }); break;
      case "zone-right-top":   setRightTopHeight((v)    => { saveNum("pp-zone-right-top-h",         v); return v; }); break;
      case "zone-right-bottom":setRightBottomHeight((v) => { saveNum("pp-zone-right-bottom-h",      v); return v; }); break;
      case "zone-center-top":  setCenterTopHeight((v)   => { saveNum("pp-zone-center-top-h",        v); return v; }); break;
      case "zone-center-bottom":setCenterBottomHeight((v)=>{ saveNum("pp-zone-center-bottom-h",     v); return v; }); break;
    }
  }, []);

  // ── Drag-to-reposition ──────────────────────────────────────────────────
  const isPanelDragging = React.useRef(false);
  const panelDragZoneRef = React.useRef<PanelPosition | null>(null);
  const [panelDragActive, setPanelDragActive] = React.useState(false);
  const [panelDragZone, setPanelDragZone] = React.useState<PanelPosition | null>(null);
  const dragApplyRef = React.useRef<((zone: PanelPosition) => void) | null>(null);

  const startPanelDragWith = React.useCallback((
    e: React.PointerEvent,
    applyPosition: (pos: PanelPosition) => void,
  ) => {
    e.preventDefault();
    dragApplyRef.current = applyPosition;
    isPanelDragging.current = true;
    panelDragZoneRef.current = null;
    setPanelDragActive(true);
    setPanelDragZone(null);
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }, []);

  const handleDragMove = React.useCallback((e: React.PointerEvent) => {
    if (!isPanelDragging.current || !terminalColumnRef.current) return;
    const rect = terminalColumnRef.current.getBoundingClientRect();
    const pctX = (e.clientX - rect.left) / rect.width;
    const pctY = (e.clientY - rect.top)  / rect.height;

    const col: "left" | "center" | "right" =
      pctX < 0.33 ? "left" : pctX > 0.67 ? "right" : "center";
    const row: "top" | "middle" | "bottom" =
      pctY < 0.33 ? "top" : pctY > 0.67 ? "bottom" : "middle";

    // center-middle is the main content area — not a valid dock target
    const zone: PanelPosition | null =
      col === "center" && row === "middle" ? null : `${col}-${row}` as PanelPosition;

    panelDragZoneRef.current = zone;
    setPanelDragZone(zone);
  }, []);

  const handleDragEnd = React.useCallback(() => {
    if (!isPanelDragging.current) return;
    isPanelDragging.current = false;
    const zone = panelDragZoneRef.current;
    panelDragZoneRef.current = null;
    setPanelDragActive(false);
    setPanelDragZone(null);
    if (zone) dragApplyRef.current?.(zone);
    dragApplyRef.current = null;
  }, []);

  // ── Combined pointer handlers ───────────────────────────────────────────
  const handleOuterPointerMove = React.useCallback((e: React.PointerEvent) => {
    handleResizeMove(e);
    handleDragMove(e);
  }, [handleResizeMove, handleDragMove]);

  const handleOuterPointerUp = React.useCallback(() => {
    handleResizeEnd();
    handleDragEnd();
  }, [handleResizeEnd, handleDragEnd]);

  // ── Combined panel tab state ────────────────────────────────────────────
  const [combinedActiveTab, setCombinedActiveTab] = React.useState<string>(() => {
    try { return localStorage.getItem("pp-combined-tab") ?? "terminal"; } catch { return "terminal"; }
  });
  const handleCombinedTabChange = React.useCallback((tab: string) => {
    setCombinedActiveTab(tab);
    try { localStorage.setItem("pp-combined-tab", tab); } catch {}
  }, []);

  // ── Lifted terminal tab state ───────────────────────────────────────────
  const [terminalTabs, setTerminalTabs] = React.useState<TerminalTab[]>([]);
  const [activeTerminalId, setActiveTerminalId] = React.useState<string | null>(null);

  const sessionActiveTerminalRef = React.useRef<Map<string | null, string | null>>(new Map());
  const prevSessionIdForTerminalRef = React.useRef<string | null>(null);
  const activeTerminalIdRef = React.useRef<string | null>(null);
  activeTerminalIdRef.current = activeTerminalId;

  React.useEffect(() => {
    const prev = prevSessionIdForTerminalRef.current;
    if (prev === activeSessionId) return;
    prevSessionIdForTerminalRef.current = activeSessionId;
    sessionActiveTerminalRef.current.set(prev, activeTerminalIdRef.current);
    const incoming = activeSessionId;
    const sessionTabs = incoming != null
      ? terminalTabs.filter((t) => t.sessionId === incoming)
      : terminalTabs;
    const savedActive = sessionActiveTerminalRef.current.get(incoming);
    if (savedActive && sessionTabs.some((t) => t.terminalId === savedActive)) {
      setActiveTerminalId(savedActive);
    } else if (sessionTabs.length > 0) {
      setActiveTerminalId(sessionTabs[sessionTabs.length - 1].terminalId);
    } else {
      setActiveTerminalId(null);
    }
  }, [activeSessionId, terminalTabs]);

  const handleTerminalTabAdd = React.useCallback((tab: TerminalTab) => {
    setTerminalTabs((prev) => [...prev, tab]);
    setActiveTerminalId(tab.terminalId);
  }, []);

  const handleTerminalTabClose = React.useCallback((terminalId: string) => {
    setTerminalTabs((prev) => {
      const next = prev.filter((t) => t.terminalId !== terminalId);
      setActiveTerminalId((current) => {
        if (current !== terminalId) return current;
        const removed = prev.find((t) => t.terminalId === terminalId);
        const sameSess = next.filter((t) => t.sessionId === (removed?.sessionId ?? null));
        return sameSess.length > 0 ? sameSess[sameSess.length - 1].terminalId : null;
      });
      return next;
    });
  }, []);

  // Prune terminal tabs whose session has been CONFIRMED ended, so their
  // WebTerminal unmounts and the WS connection closes. We only consider a
  // session for pruning once we've actually observed it as live (via
  // seenLiveSessionIdsRef) — this avoids wiping tabs on first mount before
  // the sessions feed has hydrated (liveSessionIds starts empty/undefined).
  //
  // Mere absence from liveSessionIds does NOT prune on its own: it only
  // starts a grace-period timer (TERMINAL_PRUNE_GRACE_MS). If the session
  // reappears before the timer fires (reconnect, corrected resync), the
  // timer is cancelled and nothing is touched. Only if it's still absent
  // after the grace period AND confirmSessionEnded independently agrees does
  // the tab actually get pruned — see GM VD0KKFpB.
  //
  // Pruning here is UI-only bookkeeping (drops a stale tab); it never emits
  // kill_terminal. The server kills the session's terminals on confirmed end
  // (endSharedSession, cross-node via emitToRunner) — see sio-registry/sessions.ts.
  //
  // Only tracks sessions that currently own a terminal tab (requirement:
  // bounded growth — never accumulates every session the feed has ever
  // reported, only the handful with an open tab right now).
  const seenLiveSessionIdsRef = React.useRef<Set<string>>(new Set());
  const pendingEndTimersRef = React.useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  // Bumped by clearPendingEnd every time a session is seen live again — lets
  // an in-flight confirmSessionEnded() await detect (after it resolves) that
  // the session reappeared while the fetch was in flight, even though its
  // timer entry was already cleared by then.
  const sessionGenerationRef = React.useRef<Map<string, number>>(new Map());
  // Most recent liveSessionIds snapshot, so a tab created for an
  // already-confirmed-live session can be marked "seen" immediately instead
  // of waiting for the next liveSessionIds change (which may be the session
  // actually ending — too late to start the gate then).
  const lastLiveSetRef = React.useRef<Set<string> | null>(null);
  // Kept current every render (not in an effect) so the grace-period effect
  // below can read the latest tabs without depending on `terminalTabs` as an
  // effect dependency (which would re-run the scheduling loop on every tab
  // mutation, including ones made by this same effect).
  const terminalTabsRef = React.useRef<TerminalTab[]>(terminalTabs);
  terminalTabsRef.current = terminalTabs;

  const clearPendingEnd = React.useCallback((sessionId: string) => {
    sessionGenerationRef.current.set(sessionId, (sessionGenerationRef.current.get(sessionId) ?? 0) + 1);
    const timer = pendingEndTimersRef.current.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      pendingEndTimersRef.current.delete(sessionId);
    }
  }, []);

  const pruneSession = React.useCallback((sessionId: string) => {
    clearPendingEnd(sessionId);
    seenLiveSessionIdsRef.current.delete(sessionId); // bounded: forget once resolved
    setTerminalTabs((prev) => {
      const next = prev.filter((t) => t.sessionId !== sessionId);
      if (next.length === prev.length) return prev;
      setActiveTerminalId((current) => {
        if (current == null || next.some((t) => t.terminalId === current)) return current;
        const removed = prev.find((t) => t.terminalId === current);
        const sameSess = next.filter((t) => t.sessionId === (removed?.sessionId ?? null));
        return sameSess.length > 0 ? sameSess[sameSess.length - 1].terminalId : null;
      });
      return next;
    });
  }, [clearPendingEnd]);

  // Schedule (or cancel) grace-period confirmation as liveSessionIds changes.
  // Uses terminalTabsRef (not the reactive `terminalTabs`) so pruning a
  // session below doesn't re-run this scheduling loop.
  React.useEffect(() => {
    if (!liveSessionIds) return;
    const liveSet = new Set(liveSessionIds);
    lastLiveSetRef.current = liveSet;

    const ownedSessionIds = new Set(
      terminalTabsRef.current.map((t) => t.sessionId).filter((id): id is string => id != null),
    );

    // Mark currently-owned sessions that are live right now as "seen" — the
    // gate that allows them to be pruned later if they disappear.
    for (const id of ownedSessionIds) {
      if (liveSet.has(id)) seenLiveSessionIdsRef.current.add(id);
    }

    for (const id of ownedSessionIds) {
      if (liveSet.has(id)) {
        clearPendingEnd(id); // reappeared — cancel any countdown
        continue;
      }
      if (!seenLiveSessionIdsRef.current.has(id)) continue; // never confirmed live yet
      if (pendingEndTimersRef.current.has(id)) continue; // already counting down

      const scheduledGeneration = sessionGenerationRef.current.get(id) ?? 0;
      pendingEndTimersRef.current.set(id, setTimeout(() => {
        pendingEndTimersRef.current.delete(id);
        void (async () => {
          let reallyEnded: boolean;
          try {
            reallyEnded = confirmSessionEnded ? await confirmSessionEnded(id) : false;
          } catch {
            reallyEnded = false; // can't confirm — fail safe, don't prune
          }
          if (!reallyEnded) return;
          // The session may have reappeared while confirmSessionEnded's fetch
          // was in flight — by now pendingEndTimersRef already has nothing to
          // cancel, so re-check directly against the live set / generation
          // token before pruning a session that's actually back.
          if (lastLiveSetRef.current?.has(id)) return;
          if ((sessionGenerationRef.current.get(id) ?? 0) !== scheduledGeneration) return;
          pruneSession(id);
        })();
      }, TERMINAL_PRUNE_GRACE_MS));
    }
  }, [liveSessionIds, confirmSessionEnded, clearPendingEnd, pruneSession]);

  // Track newly-owned sessions (tab just opened) against the last known live
  // set, and stop tracking a session once its last tab closes for any reason
  // (user close, confirmed prune) — bounds seenLiveSessionIdsRef / timer
  // growth instead of retaining every session ID ever seen for the tab's
  // lifetime.
  React.useEffect(() => {
    const owned = new Set(
      terminalTabs.map((t) => t.sessionId).filter((id): id is string => id != null),
    );
    const liveSet = lastLiveSetRef.current;
    if (liveSet) {
      for (const id of owned) {
        if (liveSet.has(id)) seenLiveSessionIdsRef.current.add(id);
      }
    }
    for (const id of Array.from(seenLiveSessionIdsRef.current)) {
      if (!owned.has(id)) {
        seenLiveSessionIdsRef.current.delete(id);
        clearPendingEnd(id);
      }
    }
  }, [terminalTabs, clearPendingEnd]);

  // Clear any in-flight grace timers on unmount.
  React.useEffect(() => () => {
    for (const timer of pendingEndTimersRef.current.values()) clearTimeout(timer);
    pendingEndTimersRef.current.clear();
  }, []);

  // ── Terminal panel ──────────────────────────────────────────────────────
  const [showTerminal, setShowTerminal] = React.useState(false);
  const [terminalPosition, setTerminalPosition] = React.useState<PanelPosition>(() =>
    loadPos("pp-terminal-position", "center-bottom"),
  );
  const handleTerminalPositionChange = React.useCallback((pos: PanelPosition) => {
    setTerminalPosition(pos);
    savePos("pp-terminal-position", pos);
  }, []);

  // ── File explorer panel ─────────────────────────────────────────────────
  const [showFileExplorer, setShowFileExplorer] = React.useState(false);
  const [filesPosition, setFilesPosition] = React.useState<PanelPosition>(() =>
    loadPos("pp-files-position", "left-middle"),
  );
  const handleFilesPositionChange = React.useCallback((pos: PanelPosition) => {
    setFilesPosition(pos);
    savePos("pp-files-position", pos);
  }, []);

  // ── Git panel ───────────────────────────────────────────────────────────
  const [showGit, setShowGit] = React.useState(false);
  const [gitPosition, setGitPosition] = React.useState<PanelPosition>(() =>
    loadPos("pp-git-position", "left-middle"),
  );
  const handleGitPositionChange = React.useCallback((pos: PanelPosition) => {
    setGitPosition(pos);
    savePos("pp-git-position", pos);
  }, []);

  // ── Triggers panel ──────────────────────────────────────────────────────
  const [showTriggers, setShowTriggers] = React.useState(false);
  const [triggersPosition, setTriggersPosition] = React.useState<PanelPosition>(() =>
    loadPos("pp-triggers-position", "right-middle"),
  );
  const handleTriggersPositionChange = React.useCallback((pos: PanelPosition) => {
    setTriggersPosition(pos);
    savePos("pp-triggers-position", pos);
  }, []);

  // ── Combined-position change (moves all co-located panels) ─────────────
  const handleCombinedPositionChange = React.useCallback((pos: PanelPosition) => {
    handleTerminalPositionChange(pos);
    handleFilesPositionChange(pos);
  }, [handleTerminalPositionChange, handleFilesPositionChange]);

  return {
    leftColumnWidth,
    rightColumnWidth,
    leftTopHeight,
    leftBottomHeight,
    rightTopHeight,
    rightBottomHeight,
    centerTopHeight,
    centerBottomHeight,
    terminalColumnRef,
    startColumnWidthResize,
    startZoneHeightResize,
    panelDragActive,
    panelDragZone,
    startPanelDragWith,
    handleOuterPointerMove,
    handleOuterPointerUp,
    combinedActiveTab,
    handleCombinedTabChange,
    handleCombinedPositionChange,
    terminalTabs,
    activeTerminalId,
    setActiveTerminalId,
    handleTerminalTabAdd,
    handleTerminalTabClose,
    showTerminal,
    setShowTerminal,
    terminalPosition,
    handleTerminalPositionChange,
    showFileExplorer,
    setShowFileExplorer,
    filesPosition,
    handleFilesPositionChange,
    showGit,
    setShowGit,
    gitPosition,
    handleGitPositionChange,
    showTriggers,
    setShowTriggers,
    triggersPosition,
    handleTriggersPositionChange,
  };
}
