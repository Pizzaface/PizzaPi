import * as React from "react";
import { cn } from "@/lib/utils";
import { CombinedPanel, type CombinedPanelTab } from "@/components/CombinedPanel";
import type { PanelPosition } from "@/hooks/usePanelLayout";

export type DockPosition = PanelPosition;

/** Height in pixels of the tab bar — used as the collapsed size */
const TAB_BAR_HEIGHT = 32;

export interface DockedPanelGroupProps {
  position: DockPosition;
  /** Width (for left/right zones) or height (for top/bottom zones) in pixels. */
  size: number;
  tabs: CombinedPanelTab[];
  activeTabId: string;
  onActiveTabChange: (id: string) => void;
  onPositionChange: (pos: DockPosition) => void;
  onDragStart: (e: React.PointerEvent) => void;
  onResizeStart: (e: React.PointerEvent) => void;
  className?: string;
}

export function DockedPanelGroup({
  position,
  size,
  tabs,
  activeTabId,
  onActiveTabChange,
  onPositionChange,
  onDragStart,
  onResizeStart,
  className,
}: DockedPanelGroupProps) {
  // Determine orientation from position string
  const isHorizontal =
    position === "center-top" || position === "center-bottom";
  const isLeft = position.startsWith("left-");
  const isRight = position.startsWith("right-");

  // Column (left/right) panels use width; horizontal (center-top/bottom) use height.
  // In the 9-zone layout, left/right column widths are managed at the column level,
  // so individual zones in those columns are always `flex-1` — `size` is only
  // meaningful for horizontal zones (center-top / center-bottom) or when this
  // component is used standalone.
  const isSized = isHorizontal;

  const [collapsed, setCollapsed] = React.useState(false);

  // When position changes, un-collapse so the panel is usable in the new spot
  const prevPosition = React.useRef(position);
  if (prevPosition.current !== position) {
    prevPosition.current = position;
    if (collapsed) setCollapsed(false);
  }

  const handleCollapseToggle = React.useCallback(() => {
    setCollapsed((c) => !c);
  }, []);

  const effectiveSize = collapsed ? TAB_BAR_HEIGHT : size;

  // Resize handle orientation:
  //   - center-top: horizontal handle below (row-resize)
  //   - center-bottom: horizontal handle above (row-resize)
  //   - left-*/right-*: vertical handle on edge (col-resize)
  //     NOTE: in the new column layout, left/right column width handles are
  //     rendered by the parent (ZoneColumn in App.tsx), so the per-zone resize
  //     handle here is only for inter-zone height splits within a column.
  const resizeCursor = (isLeft || isRight) ? "cursor-row-resize" : "cursor-row-resize";
  // Horizontal handle always uses row-resize cursor

  const panel = (
    <div
      className={cn(
        "flex flex-col shrink-0",
        // hide on mobile (mobile uses full-screen overlay)
        "hidden md:flex",
        className,
        isSized && { height: effectiveSize },
      )}
      style={isSized ? { height: effectiveSize } : undefined}
    >
      <CombinedPanel
        activeTabId={activeTabId}
        onActiveTabChange={onActiveTabChange}
        position={position}
        onPositionChange={onPositionChange}
        onDragStart={onDragStart}
        onCollapseToggle={handleCollapseToggle}
        className="h-full"
        tabs={tabs}
      />
    </div>
  );

  // Resize handle — hidden when collapsed
  const handle = collapsed ? null : (
    <div
      className={cn(
        "hidden md:flex shrink-0 items-center justify-center group",
        "h-[5px]",
        resizeCursor,
      )}
      onPointerDown={onResizeStart}
    >
      <div className="bg-zinc-800 group-hover:bg-blue-500/60 group-active:bg-blue-500 transition-colors w-full h-px" />
    </div>
  );

  // center-top: panel then handle (handle is below, toward main content)
  // center-bottom: handle then panel (handle is above, toward main content)
  if (position === "center-top") {
    return <>{panel}{handle}</>;
  }
  if (position === "center-bottom") {
    return <>{handle}{panel}</>;
  }

  // left-* zones: handle is below the zone (handle toward next zone down)
  // right-* zones: same
  // In the column layout, the parent (App.tsx) decides handle placement,
  // so we just render the panel itself here.
  return <>{panel}</>;
}
