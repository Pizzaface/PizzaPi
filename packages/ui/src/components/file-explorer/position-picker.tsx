import * as React from "react";
import * as ReactDOM from "react-dom";
import { cn } from "@/lib/utils";
import { POSITION_OPTIONS } from "./utils";

// ── Position Picker (click-and-hold dropdown) ────────────────────────────────

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

export function PositionPicker({
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
