import * as React from "react";
import * as ReactDOM from "react-dom";
import { cn } from "@/lib/utils";
import { GripHorizontal, X } from "lucide-react";
import type { PanelPosition } from "@/hooks/usePanelLayout";
import { computePositionDropdownCoords } from "../utils/panelLayoutHelpers";

// ── 9-zone grid definition ───────────────────────────────────────────────────
// Row 0 = top, Row 1 = middle (center-middle is main content), Row 2 = bottom.
// Col 0 = left, Col 1 = center, Col 2 = right.

interface ZoneCell {
  pos: PanelPosition | null;   // null → center-middle (main content, not selectable)
  label: string;
}

const ZONE_GRID: ZoneCell[][] = [
  [
    { pos: "left-top",      label: "Left — top"    },
    { pos: "center-top",    label: "Top"           },
    { pos: "right-top",     label: "Right — top"   },
  ],
  [
    { pos: "left-middle",   label: "Left"          },
    { pos: null,            label: "Main"          },
    { pos: "right-middle",  label: "Right"         },
  ],
  [
    { pos: "left-bottom",   label: "Left — bottom" },
    { pos: "center-bottom", label: "Bottom"        },
    { pos: "right-bottom",  label: "Right — bottom"},
  ],
];

// ── Inline SVG: mini 3×3 grid icon showing active zone ──────────────────────
function PositionGridIcon({ position }: { position: PanelPosition }) {
  const colIdx = position.startsWith("left-") ? 0 : position.startsWith("right-") ? 2 : 1;
  const rowIdx = position.endsWith("-top")    ? 0 : position.endsWith("-bottom") ? 2 : 1;

  const CELL = 4;
  const GAP  = 1;
  const SIZE  = 3 * CELL + 2 * GAP; // 14

  return (
    <svg viewBox={`0 0 ${SIZE} ${SIZE}`} width="13" height="13" aria-hidden="true">
      {ZONE_GRID.map((row, r) =>
        row.map((cell, c) => {
          const isActive = c === colIdx && r === rowIdx;
          const isMain   = cell.pos === null;
          return (
            <rect
              key={`${r}-${c}`}
              x={c * (CELL + GAP)}
              y={r * (CELL + GAP)}
              width={CELL}
              height={CELL}
              rx={0.75}
              fill="currentColor"
              opacity={isActive ? 1 : isMain ? 0.12 : 0.3}
            />
          );
        })
      )}
    </svg>
  );
}

// ── Position Picker ──────────────────────────────────────────────────────────

const PositionDropdown = React.forwardRef<
  HTMLDivElement,
  {
    containerRef: React.RefObject<HTMLDivElement | null>;
    position: PanelPosition;
    onSelect: (pos: PanelPosition) => void;
  }
>(function PositionDropdown({ containerRef, position, onSelect }, ref) {
  const [coords, setCoords] = React.useState<{ top: number; left: number } | null>(null);

  React.useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    // 3 cols × 26px + 2 gaps × 2px + 8px padding
    const width = 3 * 26 + 2 * 2 + 8;
    const height = 3 * 26 + 2 * 2 + 8;
    setCoords(
      computePositionDropdownCoords(
        rect,
        { width: window.innerWidth, height: window.innerHeight },
        { width, height },
      ),
    );
  }, [containerRef]);
  if (!coords) return null;

  return (
    <div
      ref={ref}
      className="fixed rounded-lg bg-popover border border-border p-1 shadow-xl z-[9999] animate-in fade-in zoom-in-95 duration-100"
      style={{ top: coords.top, left: coords.left }}
    >
      <div className="grid grid-cols-3 gap-0.5">
        {ZONE_GRID.map((row, r) =>
          row.map((cell, c) => {
            const isActive = cell.pos === position;
            const isMain   = cell.pos === null;
            return (
              <button
                key={`${r}-${c}`}
                type="button"
                disabled={isMain}
                onClick={isMain ? undefined : () => onSelect(cell.pos!)}
                className={cn(
                  "flex items-center justify-center size-[26px] rounded text-[9px] font-medium transition-colors leading-none",
                  isMain
                    ? "text-muted-foreground/30 cursor-default"
                    : isActive
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:text-foreground hover:bg-accent",
                )}
                title={cell.label}
                aria-label={isMain ? "Main content (not a dock target)" : `Move panel to ${cell.label}`}
                aria-pressed={isActive}
              >
                {isMain ? "●" : <PositionGridIcon position={cell.pos!} />}
              </button>
            );
          })
        )}
      </div>
    </div>
  );
});

function PositionPicker({
  position,
  onPositionChange,
}: {
  position: PanelPosition;
  onPositionChange: (pos: PanelPosition) => void;
}) {
  const [open, setOpen] = React.useState(false);
  const holdTimer    = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const containerRef = React.useRef<HTMLDivElement>(null);
  const dropdownRef  = React.useRef<HTMLDivElement>(null);
  const wasHeld      = React.useRef(false);

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
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open]);

  const clearHold = () => {
    if (holdTimer.current) { clearTimeout(holdTimer.current); holdTimer.current = null; }
  };

  const handlePointerDown = () => {
    wasHeld.current = false;
    holdTimer.current = setTimeout(() => { wasHeld.current = true; setOpen(true); }, 300);
  };
  const handlePointerUp = () => {
    clearHold();
    if (!wasHeld.current) setOpen((v) => !v);
  };
  const handlePointerLeave = () => clearHold();

  const handleSelect = (pos: PanelPosition) => {
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
        aria-expanded={open}
      >
        <PositionGridIcon position={position} />
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
  /** Keep this tab mounted even while inactive (e.g. to preserve terminal connections). */
  keepMountedWhenInactive?: boolean;
  content: React.ReactNode;
}

export interface CombinedPanelProps {
  tabs: CombinedPanelTab[];
  activeTabId: string;
  onActiveTabChange: (id: string) => void;
  position: PanelPosition;
  onPositionChange?: (pos: PanelPosition) => void;
  onDragStart?: (e: React.PointerEvent) => void;
  /** Called when a tab is double-clicked — typically used to toggle panel collapse */
  onCollapseToggle?: () => void;
  className?: string;
}

export function CombinedPanel({
  tabs,
  activeTabId,
  onActiveTabChange,
  position,
  onPositionChange,
  onDragStart,
  onCollapseToggle,
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

  const activeTab = tabs.find((t) => t.id === activeTabId) ?? tabs[0] ?? null;
  const mountedTabs = tabs.filter((tab) => tab.id === activeTab?.id || tab.keepMountedWhenInactive);

  return (
    <div className={cn("flex flex-col bg-background text-foreground", className)}>
      {/* Tab bar */}
      <div className="flex items-center border-b border-border bg-muted/50 shrink-0 min-h-[32px] overflow-hidden">
        <div className="flex items-center flex-1 min-w-0 overflow-x-auto gap-0.5 px-1 [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden">
          {tabs.map((tab) => {
            const isActive = activeTabId === tab.id;
            const hasDrag  = !!tab.onDragStart;
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
                  if (tabDragRef.current?.activated) { tabDragRef.current = null; return; }
                  onActiveTabChange(tab.id);
                }}
                onDoubleClick={() => onCollapseToggle?.()}
                onMouseDown={(e) => {
                  // Middle-click to close
                  if (e.button === 1) { e.preventDefault(); tab.onClose?.(); }
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
                  (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
                } : undefined}
                onPointerMove={hasDrag ? (e) => {
                  const drag = tabDragRef.current;
                  if (!drag || drag.tabId !== tab.id || drag.pointerId !== e.pointerId || drag.activated) return;
                  const dx = e.clientX - drag.startX;
                  const dy = e.clientY - drag.startY;
                  if (dx * dx + dy * dy > 16) { drag.activated = true; drag.onDragStart(e); }
                } : undefined}
                onPointerUp={hasDrag ? (e) => {
                  const drag = tabDragRef.current;
                  if (!drag || drag.tabId !== tab.id || drag.pointerId !== e.pointerId) return;
                  if (!drag.activated) tabDragRef.current = null;
                } : undefined}
                onPointerCancel={hasDrag ? () => { tabDragRef.current = null; } : undefined}
              >
                {tab.icon}
                <span>{tab.label}</span>
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
          {/* Close button for the active tab */}
          {activeTab?.onClose && (
            <>
              <div className="w-px h-4 bg-border mx-1 shrink-0" />
              <button
                type="button"
                onClick={() => activeTab.onClose!()}
                className="flex items-center justify-center size-7 rounded text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
                aria-label={`Close ${activeTab.label}`}
                title={`Close ${activeTab.label}`}
              >
                <X size={13} />
              </button>
            </>
          )}
        </div>
      </div>

      {/* Content — inactive panels unmount by default so hidden tabs do not
          continue reacting to viewport/layout changes (e.g. DevTools resize).
          Specific tabs can opt into staying mounted while hidden. */}
      <div className="flex-1 min-h-0 relative">
        {mountedTabs.map((tab) => {
          const isActive = tab.id === activeTab?.id;
          return (
            <div
              key={tab.id}
              className={cn("absolute inset-0", !isActive && "hidden")}
              aria-hidden={!isActive}
            >
              {tab.content}
            </div>
          );
        })}
      </div>
    </div>
  );
}
