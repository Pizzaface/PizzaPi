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
      className="fixed flex items-center gap-0.5 rounded-lg bg-zinc-800 border border-zinc-700 p-1 shadow-xl z-[9999] animate-in fade-in zoom-in-95 duration-100"
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

// ── Combined Panel ───────────────────────────────────────────────────────────

export interface CombinedPanelTab {
  id: string;
  label: string;
  icon: React.ReactNode;
  onClose?: () => void;
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
  return (
    <div className={cn("flex flex-col bg-zinc-950 text-zinc-100", className)}>
      {/* Tab bar */}
      <div className="flex items-center border-b border-zinc-800 bg-zinc-900/50 shrink-0 min-h-[32px]">
        <div className="flex items-center flex-1 overflow-x-auto gap-0.5 px-1">
          {tabs.map((tab) => {
            const isActive = activeTabId === tab.id;
            return (
              <div
                key={tab.id}
                className={cn(
                  "group flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium transition-colors cursor-pointer select-none",
                  isActive
                    ? "text-zinc-100 border-b-2 border-primary"
                    : "text-zinc-500 hover:text-zinc-300 border-b-2 border-transparent",
                )}
                onClick={() => onActiveTabChange(tab.id)}
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
                        ? "text-zinc-400 hover:text-zinc-100 hover:bg-zinc-700"
                        : "text-transparent group-hover:text-zinc-500 hover:!text-zinc-200 hover:bg-zinc-700",
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
              className="flex items-center justify-center size-7 rounded cursor-grab active:cursor-grabbing text-zinc-600 hover:text-zinc-400 hover:bg-zinc-800 transition-colors touch-none select-none"
              onPointerDown={onDragStart}
              title="Drag to reposition panel"
            >
              <GripHorizontal size={13} />
            </div>
          )}
          {onPositionChange && (
            <>
              <div className="w-px h-4 bg-zinc-700 mx-1 shrink-0" />
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
