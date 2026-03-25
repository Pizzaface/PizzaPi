import * as React from "react";
import { cn } from "@/lib/utils";
import { CombinedPanel, type CombinedPanelTab } from "@/components/CombinedPanel";

export type DockPosition = "left" | "right" | "bottom";

export interface DockedPanelGroupProps {
  position: DockPosition;
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
  const isBottom = position === "bottom";
  const isLeft = position === "left";

  const panel = (
    <div
      className={cn("hidden md:flex flex-col shrink-0", className, !isLeft && !isBottom && "order-last")}
      style={isBottom ? { height: size } : { width: size }}
    >
      <CombinedPanel
        activeTabId={activeTabId}
        onActiveTabChange={onActiveTabChange}
        position={position}
        onPositionChange={onPositionChange}
        onDragStart={onDragStart}
        className="h-full"
        tabs={tabs}
      />
    </div>
  );

  const handle = (
    <div
      className={cn(
        "hidden md:flex shrink-0 items-center justify-center group",
        isBottom ? "h-[5px] cursor-row-resize" : "w-[5px] cursor-col-resize",
        !isLeft && !isBottom && "order-last",
      )}
      onPointerDown={onResizeStart}
    >
      <div
        className={cn(
          "bg-zinc-800 group-hover:bg-blue-500/60 group-active:bg-blue-500 transition-colors",
          isBottom ? "w-full h-px" : "h-full w-px",
        )}
      />
    </div>
  );

  if (isLeft) {
    return (
      <>
        {panel}
        {handle}
      </>
    );
  }

  return (
    <>
      {handle}
      {panel}
    </>
  );
}
