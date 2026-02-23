import * as React from "react";
import * as ReactDOM from "react-dom";
import { WebTerminal } from "./WebTerminal";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { TerminalIcon, Plus, ChevronLeft, X, GripHorizontal, PanelBottom, PanelRight, PanelLeft } from "lucide-react";
import { cn } from "@/lib/utils";

interface RunnerInfo {
  runnerId: string;
  name?: string | null;
  roots?: string[];
  sessionCount: number;
}

export interface TerminalTab {
  terminalId: string;
  runnerId: string;
  cwd?: string;
  label: string;
  /** The relay session this terminal belongs to (null = not scoped) */
  sessionId: string | null;
}

export interface TerminalManagerProps {
  className?: string;
  /** Called when the user wants to close the entire terminal panel (used for the mobile overlay). */
  onClose?: () => void;
  /** Current docked position of the panel (desktop only). */
  position?: "bottom" | "right" | "left";
  /** Called when the user picks a new position via the topbar buttons. */
  onPositionChange?: (pos: "bottom" | "right" | "left") => void;
  /** Called when the user starts dragging the panel grip to reposition it. */
  onDragStart?: (e: React.PointerEvent) => void;
  /** When true, hides the "Terminal" label and position controls (used when inside CombinedPanel). */
  embedded?: boolean;

  // ── Session context ──────────────────────────────────────────────────────
  /** The active relay session ID — terminals are filtered to show only this session's tabs. */
  sessionId?: string | null;
  /** The runner that owns the active session (used to skip the dialog when spawning). */
  runnerId?: string | null;
  /** Default working directory for new terminals (pre-filled from the session's cwd). */
  defaultCwd?: string;

  // ── Controlled state (lifted to App so tabs survive panel remounts) ───────
  tabs: TerminalTab[];
  activeTabId: string | null;
  onActiveTabChange: (id: string) => void;
  /** Called after a new terminal is successfully spawned. */
  onTabAdd: (tab: TerminalTab) => void;
  /** Called when a tab's close button is pressed. */
  onTabClose: (terminalId: string) => void;
}

export function TerminalManager({
  className,
  onClose,
  position = "bottom",
  onPositionChange,
  onDragStart,
  embedded,
  sessionId,
  runnerId,
  defaultCwd,
  tabs,
  activeTabId,
  onActiveTabChange,
  onTabAdd,
  onTabClose,
}: TerminalManagerProps) {
  // ── Dialog / spawn UI state (fully local) ──────────────────────────────
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [runners, setRunners] = React.useState<RunnerInfo[]>([]);
  const [runnersLoading, setRunnersLoading] = React.useState(false);
  const [selectedRunnerId, setSelectedRunnerId] = React.useState<string>("");
  const [cwd, setCwd] = React.useState("");
  const [spawning, setSpawning] = React.useState(false);
  const [recentFolders, setRecentFolders] = React.useState<string[]>([]);

  // Tabs visible for the active session (others stay mounted for their WS connections)
  const sessionTabs = React.useMemo(
    () => (sessionId != null ? tabs.filter((t) => t.sessionId === sessionId) : tabs),
    [tabs, sessionId],
  );

  // ── Fetch runners when dialog opens ──────────────────────────────────────
  React.useEffect(() => {
    if (!dialogOpen) return;
    let cancelled = false;
    setRunnersLoading(true);
    void fetch("/api/runners", { credentials: "include" })
      .then((res) => res.ok ? res.json() : Promise.reject())
      .then((data) => {
        if (cancelled) return;
        const list = Array.isArray((data as any)?.runners) ? (data as any).runners : [];
        const normalized = list
          .map((r: any) => ({
            runnerId: typeof r?.runnerId === "string" ? r.runnerId : "",
            name: typeof r?.name === "string" ? r.name : null,
            roots: Array.isArray(r?.roots) ? r.roots.filter((x: unknown): x is string => typeof x === "string") : [],
            sessionCount: typeof r?.sessionCount === "number" ? r.sessionCount : 0,
          }))
          .filter((r: RunnerInfo) => r.runnerId);
        setRunners(normalized);
        if (normalized.length > 0 && !selectedRunnerId) {
          setSelectedRunnerId(normalized[0].runnerId);
        }
      })
      .catch(() => { if (!cancelled) setRunners([]); })
      .finally(() => { if (!cancelled) setRunnersLoading(false); });
    return () => { cancelled = true; };
  }, [dialogOpen]);

  // ── Fetch recent folders when runner changes ──────────────────────────────
  React.useEffect(() => {
    if (!dialogOpen || !selectedRunnerId) {
      setRecentFolders([]);
      return;
    }
    let cancelled = false;
    void fetch(`/api/runners/${encodeURIComponent(selectedRunnerId)}/recent-folders`, { credentials: "include" })
      .then((res) => res.ok ? res.json() : Promise.reject())
      .then((data) => {
        if (cancelled) return;
        setRecentFolders(Array.isArray((data as any)?.folders) ? (data as any).folders : []);
      })
      .catch(() => { if (!cancelled) setRecentFolders([]); });
    return () => { cancelled = true; };
  }, [dialogOpen, selectedRunnerId]);

  // ── Spawn helpers ─────────────────────────────────────────────────────────

  /**
   * Spawn a terminal directly (no dialog) using the known runner / cwd.
   * Used when the panel is attached to an active session.
   */
  const spawnDirect = React.useCallback(async (runnerIdToUse: string, cwdToUse?: string) => {
    setSpawning(true);
    try {
      const res = await fetch("/api/runners/terminal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          runnerId: runnerIdToUse,
          cwd: cwdToUse?.trim() || undefined,
          cols: 120,
          rows: 30,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        alert((body as any)?.error || `Failed to create terminal (HTTP ${res.status})`);
        return;
      }
      const data = await res.json() as { ok: boolean; terminalId: string; runnerId: string };
      if (!data.ok || !data.terminalId) {
        alert("Failed to create terminal");
        return;
      }

      // Count existing session tabs to pick a numeric label
      const siblingCount = tabs.filter((t) => t.sessionId === (sessionId ?? null)).length;
      const baseName = cwdToUse?.trim()
        ? (cwdToUse.trim().split("/").pop() || "terminal")
        : "terminal";
      const label = siblingCount === 0 ? baseName : `${baseName} ${siblingCount + 1}`;

      onTabAdd({
        terminalId: data.terminalId,
        runnerId: data.runnerId,
        cwd: cwdToUse?.trim() || undefined,
        label,
        sessionId: sessionId ?? null,
      });
    } finally {
      setSpawning(false);
    }
  }, [tabs, sessionId, onTabAdd]);

  /**
   * Spawn from the dialog (when there's no session context or the user chose a specific runner).
   */
  const spawnFromDialog = React.useCallback(async () => {
    if (!selectedRunnerId) return;
    setSpawning(true);
    try {
      const res = await fetch("/api/runners/terminal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          runnerId: selectedRunnerId,
          cwd: cwd.trim() || undefined,
          cols: 120,
          rows: 30,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        alert((body as any)?.error || `Failed to create terminal (HTTP ${res.status})`);
        return;
      }
      const data = await res.json() as { ok: boolean; terminalId: string; runnerId: string };
      if (!data.ok || !data.terminalId) {
        alert("Failed to create terminal");
        return;
      }

      const runner = runners.find((r) => r.runnerId === selectedRunnerId);
      const label = cwd.trim()
        ? (cwd.trim().split("/").pop() || "terminal")
        : (runner?.name || "terminal");

      onTabAdd({
        terminalId: data.terminalId,
        runnerId: data.runnerId,
        cwd: cwd.trim() || undefined,
        label,
        sessionId: sessionId ?? null,
      });
      setDialogOpen(false);
      setCwd("");
    } finally {
      setSpawning(false);
    }
  }, [selectedRunnerId, cwd, runners, sessionId, onTabAdd]);

  /**
   * Handle the "+" button — direct spawn when session context is available,
   * otherwise open the dialog.
   */
  const handleAddTerminal = React.useCallback(() => {
    if (runnerId) {
      void spawnDirect(runnerId, defaultCwd);
    } else {
      setDialogOpen(true);
    }
  }, [runnerId, defaultCwd, spawnDirect]);

  return (
    <div className={cn("flex flex-col bg-zinc-950", className)}>
      {/* ── Persistent topbar ─────────────────────────────────────────────── */}
      <div className="flex items-center border-b border-zinc-800 bg-zinc-900/50 shrink-0 min-h-[36px] md:min-h-[32px]">
        {/* Mobile: back button */}
        {onClose && (
          <Button
            variant="ghost"
            size="icon"
            className="size-9 shrink-0 text-zinc-500 hover:text-zinc-100 hover:bg-zinc-800 md:hidden rounded-none"
            onClick={onClose}
            aria-label="Close terminal"
          >
            <ChevronLeft size={16} />
          </Button>
        )}

        {/* "Terminal" label — hidden when embedded in CombinedPanel */}
        {!embedded && (
          <div className="flex items-center gap-1.5 px-3 text-xs font-medium text-zinc-400 shrink-0 select-none">
            <TerminalIcon className="size-3.5" />
            <span>Terminal</span>
          </div>
        )}

        {/* Divider before tabs when there are any (and not embedded) */}
        {!embedded && sessionTabs.length > 0 && (
          <div className="w-px h-4 bg-zinc-700 shrink-0" />
        )}

        {/* Tabs — only show tabs for the active session */}
        <div className="flex items-center gap-0.5 overflow-x-auto px-1 [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden flex-1">
          {sessionTabs.map((tab) => {
            const isActive = activeTabId === tab.terminalId;
            return (
              <div
                key={tab.terminalId}
                className={cn(
                  "group flex items-center gap-1 rounded px-2 py-1 text-xs transition-colors shrink-0 cursor-pointer select-none",
                  isActive
                    ? "bg-zinc-800 text-zinc-100"
                    : "text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800/50",
                )}
                onClick={() => onActiveTabChange(tab.terminalId)}
              >
                <span className="max-w-[100px] truncate">{tab.label}</span>
                <button
                  className={cn(
                    "rounded p-0.5 transition-colors",
                    isActive
                      ? "text-zinc-400 hover:text-zinc-100 hover:bg-zinc-700"
                      : "text-transparent group-hover:text-zinc-500 hover:!text-zinc-200 hover:bg-zinc-700",
                  )}
                  onClick={(e) => { e.stopPropagation(); onTabClose(tab.terminalId); }}
                  aria-label={`Close ${tab.label}`}
                >
                  <X size={10} />
                </button>
              </div>
            );
          })}
        </div>

        {/* ── Right-side controls (desktop) ── */}
        <div className="hidden md:flex items-center gap-px shrink-0 pr-1">
          {/* Drag-to-reposition grip — hidden when embedded */}
          {!embedded && onDragStart && (
            <div
              className="flex items-center justify-center size-7 rounded cursor-grab active:cursor-grabbing text-zinc-600 hover:text-zinc-400 hover:bg-zinc-800 transition-colors touch-none select-none"
              onPointerDown={onDragStart}
              title="Drag to reposition panel"
            >
              <GripHorizontal size={13} />
            </div>
          )}

          {/* Separator */}
          {!embedded && onPositionChange && <div className="w-px h-4 bg-zinc-700 mx-1 shrink-0" />}

          {/* Position picker — hidden when embedded */}
          {!embedded && onPositionChange && (
            <>
              <PositionPicker position={position} onPositionChange={onPositionChange} />
              <div className="w-px h-4 bg-zinc-700 mx-1 shrink-0" />
            </>
          )}

          {/* Add tab */}
          <button
            onClick={handleAddTerminal}
            disabled={spawning}
            className="flex items-center justify-center size-7 rounded text-zinc-500 hover:text-zinc-100 hover:bg-zinc-800 transition-colors disabled:opacity-40"
            aria-label="New terminal"
            title={runnerId ? `New terminal in ${defaultCwd || "session directory"}` : "New terminal"}
          >
            <Plus size={13} />
          </button>
        </div>

        {/* Mobile: add button only */}
        <Button
          variant="ghost"
          size="icon"
          className="md:hidden size-9 shrink-0 text-zinc-500 hover:text-zinc-100 hover:bg-zinc-800 rounded-none"
          onClick={handleAddTerminal}
          disabled={spawning}
          aria-label="New terminal"
        >
          <Plus size={14} />
        </Button>
      </div>

      {/* ── Body ──────────────────────────────────────────────────────────── */}
      <div className="flex-1 min-h-0 relative">
        {/* All terminals always mounted (even from other sessions) to keep WS connections alive */}
        {tabs.map((tab) => (
          <div
            key={tab.terminalId}
            className={cn(
              "absolute inset-0",
              activeTabId === tab.terminalId ? "z-10" : "z-0 invisible",
            )}
          >
            <WebTerminal
              terminalId={tab.terminalId}
              onClose={() => onTabClose(tab.terminalId)}
              className="h-full rounded-none border-0"
            />
          </div>
        ))}

        {/* Empty state overlay — shown when current session has no terminals */}
        {sessionTabs.length === 0 && (
          <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-4 text-zinc-500 bg-zinc-950">
            <TerminalIcon className="size-10 opacity-20" />
            {sessionId != null ? (
              <>
                <p className="text-sm">No terminals for this session</p>
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-1.5"
                  onClick={handleAddTerminal}
                  disabled={spawning}
                >
                  <Plus className="size-3.5" />
                  {spawning ? "Opening…" : runnerId ? "Open Terminal Here" : "Open Terminal"}
                </Button>
              </>
            ) : (
              <>
                <p className="text-sm">No terminals open</p>
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-1.5"
                  onClick={handleAddTerminal}
                  disabled={spawning}
                >
                  <Plus className="size-3.5" />
                  {spawning ? "Opening…" : "Open Terminal"}
                </Button>
              </>
            )}
          </div>
        )}
      </div>

      {/* Dialog is only shown when there's no session context (no runnerId) */}
      <NewTerminalDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        runners={runners}
        runnersLoading={runnersLoading}
        selectedRunnerId={selectedRunnerId}
        onRunnerChange={setSelectedRunnerId}
        cwd={cwd}
        onCwdChange={setCwd}
        recentFolders={recentFolders}
        spawning={spawning}
        onSpawn={spawnFromDialog}
      />
    </div>
  );
}

// ── Position Picker (click-and-hold dropdown) ────────────────────────────────

const POSITION_OPTIONS = [
  { pos: "left" as const, Icon: PanelLeft, label: "Left" },
  { pos: "bottom" as const, Icon: PanelBottom, label: "Bottom" },
  { pos: "right" as const, Icon: PanelRight, label: "Right" },
] as const;

const PositionDropdown = React.forwardRef<
  HTMLDivElement,
  {
    containerRef: React.RefObject<HTMLDivElement | null>;
    position: "bottom" | "right" | "left";
    onSelect: (pos: "bottom" | "right" | "left") => void;
  }
>(function PositionDropdown({ containerRef, position, onSelect }, ref) {
  const [coords, setCoords] = React.useState<{ top: number; left: number } | null>(null);

  React.useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const dropdownWidth = 3 * 28 + 2 * 2 + 8;
    setCoords({
      top: rect.top - 6 - 36,
      left: rect.left + rect.width / 2 - dropdownWidth / 2,
    });
  }, [containerRef]);

  if (!coords) return null;

  return (
    <div
      ref={ref}
      className="fixed flex items-center gap-0.5 rounded-lg bg-zinc-800 border border-zinc-700 p-1 shadow-xl z-[9999] animate-in fade-in zoom-in-95 duration-100"
      style={{ top: coords.top, left: coords.left }}
    >
      {POSITION_OPTIONS.map(({ pos, Icon, label }) => (
        <button
          key={pos}
          onClick={() => onSelect(pos)}
          className={cn(
            "flex items-center justify-center size-7 rounded transition-colors",
            position === pos
              ? "bg-zinc-600 text-zinc-100"
              : "text-zinc-400 hover:text-zinc-100 hover:bg-zinc-700",
          )}
          title={label}
          aria-label={`Move panel to ${label}`}
        >
          <Icon size={14} />
        </button>
      ))}
    </div>
  );
});

function PositionPicker({
  position,
  onPositionChange,
}: {
  position: "bottom" | "right" | "left";
  onPositionChange: (pos: "bottom" | "right" | "left") => void;
}) {
  const [open, setOpen] = React.useState(false);
  const holdTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const containerRef = React.useRef<HTMLDivElement>(null);
  const dropdownRef = React.useRef<HTMLDivElement>(null);
  const wasHeld = React.useRef(false);

  const ActiveIcon = POSITION_OPTIONS.find((o) => o.pos === position)!.Icon;

  // Close on outside click
  React.useEffect(() => {
    if (!open) return;
    const handler = (e: PointerEvent) => {
      const target = e.target as Node;
      if (
        containerRef.current && !containerRef.current.contains(target) &&
        (!dropdownRef.current || !dropdownRef.current.contains(target))
      ) {
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", handler, true);
    return () => document.removeEventListener("pointerdown", handler, true);
  }, [open]);

  // Close on Escape
  React.useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open]);

  const clearHold = () => {
    if (holdTimer.current) {
      clearTimeout(holdTimer.current);
      holdTimer.current = null;
    }
  };

  const handlePointerDown = () => {
    wasHeld.current = false;
    holdTimer.current = setTimeout(() => {
      wasHeld.current = true;
      setOpen(true);
    }, 300);
  };

  const handlePointerUp = () => {
    clearHold();
    if (!wasHeld.current) {
      setOpen((v) => !v);
    }
  };

  const handlePointerLeave = () => {
    clearHold();
  };

  const handleSelect = (pos: "bottom" | "right" | "left") => {
    onPositionChange(pos);
    setOpen(false);
  };

  return (
    <div ref={containerRef} className="relative">
      <button
        onPointerDown={handlePointerDown}
        onPointerUp={handlePointerUp}
        onPointerLeave={handlePointerLeave}
        className={cn(
          "flex items-center justify-center size-7 rounded transition-colors",
          open
            ? "bg-zinc-700 text-zinc-200"
            : "text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800",
        )}
        title="Panel position"
        aria-label="Panel position"
      >
        <ActiveIcon size={13} />
      </button>

      {open && ReactDOM.createPortal(
        <PositionDropdown
          ref={dropdownRef}
          containerRef={containerRef}
          position={position}
          onSelect={handleSelect}
        />,
        document.body,
      )}
    </div>
  );
}

// ── New Terminal Dialog ───────────────────────────────────────────────────────

interface NewTerminalDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  runners: RunnerInfo[];
  runnersLoading: boolean;
  selectedRunnerId: string;
  onRunnerChange: (id: string) => void;
  cwd: string;
  onCwdChange: (cwd: string) => void;
  recentFolders: string[];
  spawning: boolean;
  onSpawn: () => void;
}

function NewTerminalDialog({
  open,
  onOpenChange,
  runners,
  runnersLoading,
  selectedRunnerId,
  onRunnerChange,
  cwd,
  onCwdChange,
  recentFolders,
  spawning,
  onSpawn,
}: NewTerminalDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <TerminalIcon className="size-4" />
            New Terminal
          </DialogTitle>
          <DialogDescription>
            Open a shell on a connected runner machine.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label>Runner</Label>
            {runnersLoading ? (
              <p className="text-xs text-zinc-500">Loading runners…</p>
            ) : runners.length === 0 ? (
              <p className="text-xs text-zinc-500">No runners connected</p>
            ) : (
              <Select value={selectedRunnerId} onValueChange={onRunnerChange}>
                <SelectTrigger>
                  <SelectValue placeholder="Select a runner" />
                </SelectTrigger>
                <SelectContent>
                  {runners.map((r) => (
                    <SelectItem key={r.runnerId} value={r.runnerId}>
                      {r.name || r.runnerId.slice(0, 8)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>

          <div className="space-y-2">
            <Label>Working Directory (optional)</Label>
            <Input
              value={cwd}
              onChange={(e) => onCwdChange(e.target.value)}
              placeholder="e.g. /home/user/project"
              onKeyDown={(e) => {
                if (e.key === "Enter" && !spawning && selectedRunnerId) {
                  e.preventDefault();
                  onSpawn();
                }
              }}
            />
            {recentFolders.length > 0 && (
              <div className="flex flex-wrap gap-1 mt-1">
                {recentFolders.slice(0, 5).map((folder) => (
                  <button
                    key={folder}
                    onClick={() => onCwdChange(folder)}
                    className="rounded bg-zinc-800 px-2 py-0.5 text-[11px] text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200 transition-colors truncate max-w-[200px]"
                  >
                    {folder.split("/").pop() || folder}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={onSpawn}
            disabled={spawning || !selectedRunnerId || runners.length === 0}
          >
            {spawning ? "Opening…" : "Open Terminal"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
