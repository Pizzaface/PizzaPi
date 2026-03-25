import * as React from "react";
import type { TerminalTab } from "@/components/TerminalManager";

export type PanelPosition = "bottom" | "right" | "left";

export interface PanelLayoutState {
  // ── Terminal panel ──────────────────────────────────────────────────────
  showTerminal: boolean;
  setShowTerminal: React.Dispatch<React.SetStateAction<boolean>>;
  terminalPosition: PanelPosition;
  terminalHeight: number;
  terminalWidth: number;
  terminalColumnRef: React.RefObject<HTMLDivElement | null>;
  handleTerminalResizeStart: (e: React.PointerEvent) => void;
  handleTerminalPositionChange: (pos: PanelPosition) => void;

  // ── Terminal drag-to-reposition ─────────────────────────────────────────
  panelDragActive: boolean;
  panelDragZone: PanelPosition | null;
  handlePanelDragStart: (e: React.PointerEvent) => void;
  handleTerminalTabDragStart: (e: React.PointerEvent) => void;

  // ── Terminal outer pointer handlers (resize + drag combined) ────────────
  handleOuterPointerMove: (e: React.PointerEvent) => void;
  handleOuterPointerUp: () => void;

  // ── Combined panel (terminal + file explorer + service panels) ───────────
  combinedActiveTab: string;
  handleCombinedTabChange: (tab: string) => void;
  handleCombinedPositionChange: (pos: PanelPosition) => void;

  // ── Lifted terminal tab state ───────────────────────────────────────────
  terminalTabs: TerminalTab[];
  activeTerminalId: string | null;
  setActiveTerminalId: React.Dispatch<React.SetStateAction<string | null>>;
  handleTerminalTabAdd: (tab: TerminalTab) => void;
  handleTerminalTabClose: (terminalId: string) => void;

  // ── File explorer panel ─────────────────────────────────────────────────
  showFileExplorer: boolean;
  setShowFileExplorer: React.Dispatch<React.SetStateAction<boolean>>;
  filesPosition: PanelPosition;
  filesWidth: number;
  filesHeight: number;
  filesContainerRef: React.RefObject<HTMLDivElement | null>;
  handleFilesWidthLeftResizeStart: (e: React.PointerEvent) => void;
  handleFilesWidthRightResizeStart: (e: React.PointerEvent) => void;
  handleFilesHeightResizeStart: (e: React.PointerEvent) => void;
  handleFilesPositionChange: (pos: PanelPosition) => void;

  // ── File explorer drag-to-reposition ────────────────────────────────────
  filesDragActive: boolean;
  filesDragZone: PanelPosition | null;
  handleFilesDragStart: (e: React.PointerEvent) => void;

  // ── File explorer outer pointer handlers (resize + drag combined) ───────
  handleFilesOuterPointerMove: (e: React.PointerEvent) => void;
  handleFilesOuterPointerUp: () => void;
}

/**
 * Manages the full panel layout: terminal and file explorer positioning,
 * resizing, drag-to-reposition, combined-panel tab state, and lifted
 * terminal tab state that survives panel remounts.
 */
export function usePanelLayout(activeSessionId: string | null): PanelLayoutState {
  // ── Terminal panel state ───────────────────────────────────────────────
  const [showTerminal, setShowTerminal] = React.useState(false);
  const [terminalPosition, setTerminalPosition] = React.useState<PanelPosition>(() => {
    try { return (localStorage.getItem("pp-terminal-position") as PanelPosition) ?? "bottom"; } catch { return "bottom"; }
  });
  const [terminalHeight, setTerminalHeight] = React.useState<number>(() => {
    try {
      const saved = localStorage.getItem("pp-terminal-height");
      if (saved) return Math.max(120, Math.min(parseInt(saved, 10), 900));
    } catch {}
    return 280;
  });
  const [terminalWidth, setTerminalWidth] = React.useState<number>(() => {
    try {
      const saved = localStorage.getItem("pp-terminal-width");
      if (saved) return Math.max(200, Math.min(parseInt(saved, 10), 1400));
    } catch {}
    return 480;
  });
  const terminalColumnRef = React.useRef<HTMLDivElement>(null);
  // "height" = bottom panel vertical drag, "width-right" = right panel, "width-left" = left panel
  const resizeDir = React.useRef<"height" | "width-right" | "width-left" | null>(null);

  // Single handler — direction is derived from current terminalPosition at drag start
  const handleTerminalResizeStart = React.useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    resizeDir.current = terminalPosition === "bottom" ? "height"
      : terminalPosition === "right" ? "width-right"
      : "width-left";
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }, [terminalPosition]);

  const handleTerminalResizeMove = React.useCallback((e: React.PointerEvent) => {
    const dir = resizeDir.current;
    if (!dir || !terminalColumnRef.current) return;
    const rect = terminalColumnRef.current.getBoundingClientRect();
    if (dir === "height") {
      setTerminalHeight(Math.max(120, Math.min(rect.bottom - e.clientY, rect.height - 80)));
    } else if (dir === "width-right") {
      setTerminalWidth(Math.max(200, Math.min(rect.right - e.clientX, rect.width - 200)));
    } else {
      setTerminalWidth(Math.max(200, Math.min(e.clientX - rect.left, rect.width - 200)));
    }
  }, []);

  const handleTerminalResizeEnd = React.useCallback(() => {
    const dir = resizeDir.current;
    if (!dir) return;
    resizeDir.current = null;
    if (dir === "height") {
      setTerminalHeight((h) => { try { localStorage.setItem("pp-terminal-height", String(Math.round(h))); } catch {} return h; });
    } else {
      setTerminalWidth((w) => { try { localStorage.setItem("pp-terminal-width", String(Math.round(w))); } catch {} return w; });
    }
  }, []);

  // ── Panel drag-to-reposition ──────────────────────────────────────────
  const isPanelDragging = React.useRef(false);
  const panelDragZoneRef = React.useRef<PanelPosition | null>(null);
  const [panelDragActive, setPanelDragActive] = React.useState(false);
  const [panelDragZone, setPanelDragZone] = React.useState<PanelPosition | null>(null);

  const handleTerminalPositionChange = React.useCallback((pos: PanelPosition) => {
    setTerminalPosition(pos);
    try { localStorage.setItem("pp-terminal-position", pos); } catch {}
  }, []);

  const handlePanelDragStart = React.useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    isPanelDragging.current = true;
    panelDragZoneRef.current = null;
    setPanelDragActive(true);
    setPanelDragZone(null);
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }, []);

  const handlePanelDragMove = React.useCallback((e: React.PointerEvent) => {
    if (!isPanelDragging.current || !terminalColumnRef.current) return;
    const rect = terminalColumnRef.current.getBoundingClientRect();
    const pctX = (e.clientX - rect.left) / rect.width;
    const pctY = (e.clientY - rect.top) / rect.height;
    let zone: PanelPosition | null = null;
    if (pctY > 0.55) zone = "bottom";
    else if (pctX > 0.65) zone = "right";
    else if (pctX < 0.35) zone = "left";
    panelDragZoneRef.current = zone;
    setPanelDragZone(zone);
  }, []);

  // Ref to sync file explorer position when panels are combined (avoids forward-reference issues)
  const combinedDragSyncRef = React.useRef<((zone: PanelPosition) => void) | null>(null);

  // Drag start handler for the Terminal tab inside the combined panel.
  // Unlike the grip handle (which moves both panels together), this only moves
  // the terminal panel so it can be detached from the files panel.
  const handleTerminalTabDragStart = React.useCallback((e: React.PointerEvent) => {
    // Clear the sync ref so handlePanelDragEnd doesn't also reposition the files panel
    combinedDragSyncRef.current = null;
    handlePanelDragStart(e);
  }, [handlePanelDragStart]);

  const handlePanelDragEnd = React.useCallback(() => {
    if (!isPanelDragging.current) return;
    isPanelDragging.current = false;
    const zone = panelDragZoneRef.current;
    panelDragZoneRef.current = null;
    setPanelDragActive(false);
    setPanelDragZone(null);
    if (zone) {
      handleTerminalPositionChange(zone);
      // When panels are combined (same position), also move file explorer
      combinedDragSyncRef.current?.(zone);
    }
  }, [handleTerminalPositionChange]);

  const handleOuterPointerMove = React.useCallback((e: React.PointerEvent) => {
    handleTerminalResizeMove(e);
    handlePanelDragMove(e);
  }, [handleTerminalResizeMove, handlePanelDragMove]);

  const handleOuterPointerUp = React.useCallback(() => {
    handleTerminalResizeEnd();
    handlePanelDragEnd();
  }, [handleTerminalResizeEnd, handlePanelDragEnd]);

  // ── Combined panel tab state ──────────────────────────────────────────
  const [combinedActiveTab, setCombinedActiveTab] = React.useState<string>(() => {
    try { return localStorage.getItem("pp-combined-tab") ?? "terminal"; } catch { return "terminal"; }
  });
  const handleCombinedTabChange = React.useCallback((tab: string) => {
    setCombinedActiveTab(tab);
    try { localStorage.setItem("pp-combined-tab", tab); } catch {}
  }, []);

  // ── Lifted terminal tab state ─────────────────────────────────────────
  // Stored here (not inside TerminalManager) so tabs survive panel remounts
  // (e.g., when the panel transitions between combined and standalone layouts).
  const [terminalTabs, setTerminalTabs] = React.useState<TerminalTab[]>([]);
  const [activeTerminalId, setActiveTerminalId] = React.useState<string | null>(null);

  // Per-session last-active terminal: save/restore when switching sessions.
  const sessionActiveTerminalRef = React.useRef<Map<string | null, string | null>>(new Map());
  const prevSessionIdForTerminalRef = React.useRef<string | null>(null);
  // Stable ref so the effect doesn't need activeTerminalId in its dep array
  const activeTerminalIdRef = React.useRef<string | null>(null);
  activeTerminalIdRef.current = activeTerminalId;

  React.useEffect(() => {
    const prev = prevSessionIdForTerminalRef.current;
    if (prev === activeSessionId) return;
    prevSessionIdForTerminalRef.current = activeSessionId;

    // Save current active terminal for the outgoing session
    sessionActiveTerminalRef.current.set(prev, activeTerminalIdRef.current);

    // Restore the last-active terminal for the incoming session
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
        // Find the closest remaining tab in the same session
        const removed = prev.find((t) => t.terminalId === terminalId);
        const sameSess = next.filter((t) => t.sessionId === (removed?.sessionId ?? null));
        return sameSess.length > 0 ? sameSess[sameSess.length - 1].terminalId : null;
      });
      return next;
    });
  }, []);

  // ── File explorer panel state ─────────────────────────────────────────
  const [showFileExplorer, setShowFileExplorer] = React.useState(false);
  const [filesPosition, setFilesPosition] = React.useState<PanelPosition>(() => {
    try { return (localStorage.getItem("pp-files-position") as PanelPosition) ?? "left"; } catch { return "left"; }
  });
  const [filesWidth, setFilesWidth] = React.useState<number>(() => {
    try {
      const saved = localStorage.getItem("pp-files-width");
      if (saved) return Math.max(160, Math.min(parseInt(saved, 10), 800));
    } catch {}
    return 280;
  });
  const [filesHeight, setFilesHeight] = React.useState<number>(() => {
    try {
      const saved = localStorage.getItem("pp-files-height");
      if (saved) return Math.max(150, Math.min(parseInt(saved, 10), 800));
    } catch {}
    return 280;
  });
  const filesContainerRef = React.useRef<HTMLDivElement>(null);
  const filesResizeDir = React.useRef<"width-right" | "width-left" | "height" | null>(null);

  const handleFilesWidthLeftResizeStart = React.useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    filesResizeDir.current = "width-left";
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }, []);
  const handleFilesWidthRightResizeStart = React.useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    filesResizeDir.current = "width-right";
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }, []);
  const handleFilesHeightResizeStart = React.useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    filesResizeDir.current = "height";
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }, []);
  const handleFilesResizeMove = React.useCallback((e: React.PointerEvent) => {
    const dir = filesResizeDir.current;
    if (!dir || !filesContainerRef.current) return;
    const rect = filesContainerRef.current.getBoundingClientRect();
    if (dir === "width-right") {
      setFilesWidth(Math.max(160, Math.min(rect.right - e.clientX, rect.width - 200)));
    } else if (dir === "width-left") {
      setFilesWidth(Math.max(160, Math.min(e.clientX - rect.left, rect.width - 200)));
    } else {
      setFilesHeight(Math.max(150, Math.min(rect.bottom - e.clientY, rect.height - 100)));
    }
  }, []);
  const handleFilesResizeEnd = React.useCallback(() => {
    const dir = filesResizeDir.current;
    if (!dir) return;
    filesResizeDir.current = null;
    if (dir === "height") {
      setFilesHeight((h) => { try { localStorage.setItem("pp-files-height", String(Math.round(h))); } catch {} return h; });
    } else {
      setFilesWidth((w) => { try { localStorage.setItem("pp-files-width", String(Math.round(w))); } catch {} return w; });
    }
  }, []);

  const handleFilesPositionChange = React.useCallback((pos: PanelPosition) => {
    setFilesPosition(pos);
    try { localStorage.setItem("pp-files-position", pos); } catch {}
  }, []);

  const handleCombinedPositionChange = React.useCallback((pos: PanelPosition) => {
    handleTerminalPositionChange(pos);
    handleFilesPositionChange(pos);
  }, [handleTerminalPositionChange, handleFilesPositionChange]);

  // Keep the drag sync ref up-to-date so handlePanelDragEnd can sync file explorer
  React.useEffect(() => {
    if (showTerminal && showFileExplorer && terminalPosition === filesPosition) {
      combinedDragSyncRef.current = handleFilesPositionChange;
    } else {
      combinedDragSyncRef.current = null;
    }
  }, [showTerminal, showFileExplorer, terminalPosition, filesPosition, handleFilesPositionChange]);

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

  return {
    showTerminal,
    setShowTerminal,
    terminalPosition,
    terminalHeight,
    terminalWidth,
    terminalColumnRef,
    handleTerminalResizeStart,
    handleTerminalPositionChange,
    panelDragActive,
    panelDragZone,
    handlePanelDragStart,
    handleTerminalTabDragStart,
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
    showFileExplorer,
    setShowFileExplorer,
    filesPosition,
    filesWidth,
    filesHeight,
    filesContainerRef,
    handleFilesWidthLeftResizeStart,
    handleFilesWidthRightResizeStart,
    handleFilesHeightResizeStart,
    handleFilesPositionChange,
    filesDragActive,
    filesDragZone,
    handleFilesDragStart,
    handleFilesOuterPointerMove,
    handleFilesOuterPointerUp,
  };
}
