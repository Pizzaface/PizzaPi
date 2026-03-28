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

// ── Hook ──────────────────────────────────────────────────────────────────────
export function usePanelLayout(activeSessionId: string | null): PanelLayoutState {
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

  // ── File explorer drag-to-reposition ──────────────────────────────────
  const isFilesDragging = React.useRef(false);
  const filesDragZoneRef = React.useRef<PanelPosition | null>(null);
  const [filesDragActive, setFilesDragActive] = React.useState(false);
  const [filesDragZone, setFilesDragZone] = React.useState<PanelPosition | null>(null);

  const handleFilesDragStart = React.useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    isFilesDragging.current = true;
    filesDragZoneRef.current = null;
    setFilesDragActive(true);
    setFilesDragZone(null);
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }, []);
  const handleFilesDragMove = React.useCallback((e: React.PointerEvent) => {
    if (!isFilesDragging.current || !filesContainerRef.current) return;
    const rect = filesContainerRef.current.getBoundingClientRect();
    const pctX = (e.clientX - rect.left) / rect.width;
    const pctY = (e.clientY - rect.top) / rect.height;
    let zone: PanelPosition | null = null;
    if (pctY > 0.55) zone = "bottom";
    else if (pctX > 0.65) zone = "right";
    else if (pctX < 0.35) zone = "left";
    filesDragZoneRef.current = zone;
    setFilesDragZone(zone);
  }, []);
  const handleFilesDragEnd = React.useCallback(() => {
    if (!isFilesDragging.current) return;
    isFilesDragging.current = false;
    const zone = filesDragZoneRef.current;
    filesDragZoneRef.current = null;
    setFilesDragActive(false);
    setFilesDragZone(null);
    if (zone) handleFilesPositionChange(zone);
  }, [handleFilesPositionChange]);
  const handleFilesOuterPointerMove = React.useCallback((e: React.PointerEvent) => {
    handleFilesResizeMove(e);
    handleFilesDragMove(e);
  }, [handleFilesResizeMove, handleFilesDragMove]);
  const handleFilesOuterPointerUp = React.useCallback(() => {
    handleFilesResizeEnd();
    handleFilesDragEnd();
  }, [handleFilesResizeEnd, handleFilesDragEnd]);

  // ── Git panel state ───────────────────────────────────────────────────
  const [showGit, setShowGit] = React.useState(false);
  const [gitPosition, setGitPosition] = React.useState<PanelPosition>(() => {
    try { return (localStorage.getItem("pp-git-position") as PanelPosition) ?? "left"; } catch { return "left"; }
  });
  const handleGitPositionChange = React.useCallback((pos: PanelPosition) => {
    setGitPosition(pos);
    try { localStorage.setItem("pp-git-position", pos); } catch {}
  }, []);

  // ── Triggers panel state ──────────────────────────────────────────────
  const [showTriggers, setShowTriggers] = React.useState(false);
  const [triggersPosition, setTriggersPosition] = React.useState<PanelPosition>(() => {
    try { return (localStorage.getItem("pp-triggers-position") as PanelPosition) ?? "right"; } catch { return "right"; }
  });
  const handleTriggersPositionChange = React.useCallback((pos: PanelPosition) => {
    setTriggersPosition(pos);
    try { localStorage.setItem("pp-triggers-position", pos); } catch {}
  }, []);
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
