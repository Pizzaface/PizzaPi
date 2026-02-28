import * as React from "react";
import * as ReactDOM from "react-dom";
import { cn } from "@/lib/utils";
import { GripHorizontal, PanelBottom, PanelLeft, PanelRight, X } from "lucide-react";

// ── Position Picker (shared with TerminalManager / FileExplorer) ─────────────

const POSITION_OPTIONS = [
  { pos: "left" as const, Icon: PanelLeft, label: "Left" },
  { pos: "bottom" as const, Icon: PanelBottom, label: "Bottom" },
  { pos: "right" as const, Icon: PanelRight, label: "Right" },
] as const;

const PositionDropdown = React.forwardRef<
  HTMLDivElement,
  {
    containerRef: React.RefObject<HTMLDivElement | null>;
    position: "left" | "right" | "bottom";
    onSelect: (pos: "left" | "right" | "bottom") => void;
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
      className="fixed flex items-center gap-0.5 rounded-lg bg-popover border border-border p-1 shadow-xl z-[9999] animate-in fade-in zoom-in-95 duration-100"
      style={{ top: coords.top, left: coords.left }}
    >
      {POSITION_OPTIONS.map(({ pos, Icon, label }) => (
        <button
          key={pos}
          type="button"
          onClick={() => onSelect(pos)}
          className={cn(
            "flex items-center justify-center size-7 rounded transition-colors",
            position === pos
              ? "bg-accent text-foreground"
              : "text-muted-foreground hover:text-foreground hover:bg-accent",
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
  position: "left" | "right" | "bottom";
  onPositionChange: (pos: "left" | "right" | "bottom") => void;
}) {
  const [open, setOpen] = React.useState(false);
  const holdTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const containerRef = React.useRef<HTMLDivElement>(null);
  const dropdownRef = React.useRef<HTMLDivElement>(null);
  const wasHeld = React.useRef(false);

  const ActiveIcon = POSITION_OPTIONS.find((o) => o.pos === position)!.Icon;

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

  const handleSelect = (pos: "left" | "right" | "bottom") => {
    onPositionChange(pos);
    setOpen(false);
  };

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onPointerDown={handlePointerDown}
        onPointerUp={handlePointerUp}
        onPointerLeave={handlePointerLeave}
        className={cn(
          "flex items-center justify-center size-7 rounded transition-colors",
          open
            ? "bg-accent text-foreground"
            : "text-muted-foreground hover:text-foreground hover:bg-accent",
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

// ── Combined Panel ───────────────────────────────────────────────────────────

export interface CombinedPanelTab {
  id: string;
  label: string;
  icon: React.ReactNode;
  onClose?: () => void;
  /** When provided, dragging the tab triggers panel repositioning instead of tab switching */
  onDragStart?: (e: React.PointerEvent) => void;
  content: React.ReactNode;
}

export interface CombinedPanelProps {
  tabs: CombinedPanelTab[];
  activeTabId: string;
  onActiveTabChange: (id: string) => void;
  position: "left" | "right" | "bottom";
  onPositionChange?: (pos: "left" | "right" | "bottom") => void;
  onDragStart?: (e: React.PointerEvent) => void;
  className?: string;
}

export function CombinedPanel({
  tabs,
  activeTabId,
  onActiveTabChange,
  position,
  onPositionChange,
  onDragStart,
  className,
}: CombinedPanelProps) {
  // Track per-tab drag gestures so that dragging a tab detaches it
  const tabDragRef = React.useRef<{
    tabId: string;
    startX: number;
    startY: number;
    onDragStart: (e: React.PointerEvent) => void;
    pointerId: number;
    activated: boolean;
  } | null>(null);

  return (
    <div className={cn("flex flex-col bg-background text-foreground", className)}>
      {/* Tab bar */}
      <div className="flex items-center border-b border-border bg-muted/50 shrink-0 min-h-[32px]">
        <div className="flex items-center flex-1 overflow-x-auto gap-0.5 px-1">
          {tabs.map((tab) => {
            const isActive = activeTabId === tab.id;
            const hasDrag = !!tab.onDragStart;
            return (
              <div
                key={tab.id}
                className={cn(
                  "group flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium transition-colors select-none",
                  isActive
                    ? "text-foreground border-b-2 border-primary"
                    : "text-muted-foreground hover:text-foreground border-b-2 border-transparent",
                  hasDrag ? "cursor-grab active:cursor-grabbing" : "cursor-pointer",
                )}
                onClick={() => {
                  // Suppress click if this pointer-down became a drag
                  if (tabDragRef.current?.activated) {
                    tabDragRef.current = null;
                    return;
                  }
                  onActiveTabChange(tab.id);
                }}
                onPointerDown={hasDrag ? (e) => {
                  if (e.button !== 0) return;
                  tabDragRef.current = {
                    tabId: tab.id,
                    startX: e.clientX,
                    startY: e.clientY,
                    onDragStart: tab.onDragStart!,
                    pointerId: e.pointerId,
                    activated: false,
                  };
                  // Capture so move/up are reliable even if pointer leaves the tab
                  (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
                } : undefined}
                onPointerMove={hasDrag ? (e) => {
                  const drag = tabDragRef.current;
                  if (!drag || drag.tabId !== tab.id || drag.pointerId !== e.pointerId || drag.activated) return;
                  const dx = e.clientX - drag.startX;
                  const dy = e.clientY - drag.startY;
                  // 4 px threshold to distinguish drag from click
                  if (dx * dx + dy * dy > 16) {
                    drag.activated = true;
                    drag.onDragStart(e);
                  }
                } : undefined}
                onPointerUp={hasDrag ? (e) => {
                  const drag = tabDragRef.current;
                  if (!drag || drag.tabId !== tab.id || drag.pointerId !== e.pointerId) return;
                  if (!drag.activated) {
                    // Was a click — null the ref so onClick fires normally
                    tabDragRef.current = null;
                  }
                  // If activated, keep ref alive so onClick can detect and suppress it
                } : undefined}
                onPointerCancel={hasDrag ? () => {
                  tabDragRef.current = null;
                } : undefined}
              >
                {tab.icon}
                <span>{tab.label}</span>
                {tab.onClose && (
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); tab.onClose!(); }}
                    className={cn(
                      "rounded p-0.5 transition-colors ml-0.5",
                      isActive
                        ? "text-muted-foreground hover:text-foreground hover:bg-accent"
                        : "text-transparent group-hover:text-muted-foreground hover:!text-foreground hover:bg-accent",
                    )}
                    aria-label={`Close ${tab.label}`}
                  >
                    <X size={10} />
                  </button>
                )}
              </div>
            );
          })}
        </div>

        {/* Controls */}
        <div className="flex items-center gap-px pr-1 shrink-0">
          {onDragStart && (
            <div
              className="flex items-center justify-center size-7 rounded cursor-grab active:cursor-grabbing text-muted-foreground/60 hover:text-muted-foreground hover:bg-accent transition-colors touch-none select-none"
              onPointerDown={onDragStart}
              title="Drag to reposition panel"
              aria-label="Drag to reposition panel"
            >
              <GripHorizontal size={13} />
            </div>
          )}
          {onPositionChange && (
            <>
              <div className="w-px h-4 bg-border mx-1 shrink-0" />
              <PositionPicker position={position} onPositionChange={onPositionChange} />
            </>
          )}
        </div>
      </div>

      {/* Content — all panels stay mounted, only active one is visible */}
      <div className="flex-1 min-h-0 relative">
        {tabs.map((tab) => (
          <div
            key={tab.id}
            className={cn(
              "absolute inset-0",
              activeTabId === tab.id ? "z-10 visible" : "z-0 invisible",
            )}
          >
            {tab.content}
          </div>
        ))}
      </div>
    </div>
  );
}
