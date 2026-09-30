import * as React from "react";
import type { CombinedPanelTab } from "@/components/CombinedPanel";
import { DockedPanelGroup, TAB_BAR_HEIGHT } from "@/components/DockedPanelGroup";
import type { PanelPosition } from "@/hooks/usePanelLayout";
import { cn } from "@/lib/utils";
import type { ColumnZone } from "../panel-zones";

export interface DockColumnProps {
  zones: ColumnZone<CombinedPanelTab>[];
  width: number;
  isGroupCollapsed: (tabIds: string[]) => boolean;
  setGroupCollapsed: (tabIds: string[], collapsed: boolean) => void;
  resolveActiveTabId: (tabs: CombinedPanelTab[]) => string;
  onActiveTabChange: (id: string) => void;
  onGroupPositionChange: (tabIds: string[], pos: PanelPosition) => void;
  onGroupDragStart: (tabIds: string[]) => (e: React.PointerEvent) => void;
  startZoneHeightResize: (pos: PanelPosition, e: React.PointerEvent) => void;
}

/**
 * A desktop side column of stacked docked-panel zones with row resize
 * handles between them. (The column-width resize handle is rendered by the
 * caller on the inner edge.)
 */
export function DockColumn({
  zones,
  width,
  isGroupCollapsed,
  setGroupCollapsed,
  resolveActiveTabId,
  onActiveTabChange,
  onGroupPositionChange,
  onGroupDragStart,
  startZoneHeightResize,
}: DockColumnProps) {
  return (
    /* ponytail: 40vw cap keeps the chat visible when both columns are wide on small screens; smarter viewport-aware clamping if users complain */
    <div className="hidden md:flex flex-col shrink-0 min-h-0" style={{ width, maxWidth: "40vw" }}>
      {zones.map((zone, i) => {
        const nextZone = zones[i + 1];
        const handleZonePos = nextZone
          ? (zone.fills ? nextZone.pos : zone.pos)
          : undefined;
        const zoneTabIds = zone.tabs.map((t) => t.id);
        const zoneCollapsed = isGroupCollapsed(zoneTabIds);
        return (
          <React.Fragment key={zone.pos}>
            <div
              className={cn(zoneCollapsed ? "shrink-0" : (zone.fills ? "flex-1 min-h-0" : "shrink-0"))}
              style={zoneCollapsed
                ? { height: TAB_BAR_HEIGHT }
                : !zone.fills
                  ? { height: zone.storedHeight }
                  : undefined}
            >
              <DockedPanelGroup
                position={zone.pos}
                size={zone.storedHeight}
                tabs={zone.tabs}
                activeTabId={resolveActiveTabId(zone.tabs)}
                onActiveTabChange={onActiveTabChange}
                onPositionChange={(pos) => onGroupPositionChange(zoneTabIds, pos)}
                onDragStart={onGroupDragStart(zoneTabIds)}
                onResizeStart={() => {}}
                collapsed={zoneCollapsed}
                onCollapseChange={(next) => setGroupCollapsed(zoneTabIds, next)}
                className="h-full w-full"
              />
            </div>
            {nextZone && (
              <div
                className="hidden md:flex h-[5px] cursor-row-resize shrink-0 items-center justify-center group"
                onPointerDown={handleZonePos ? (e) => startZoneHeightResize(handleZonePos, e) : undefined}
              >
                <div className="bg-zinc-800 group-hover:bg-blue-500/60 group-active:bg-blue-500 transition-colors w-full h-px" />
              </div>
            )}
          </React.Fragment>
        );
      })}
    </div>
  );
}

/** Vertical drag handle that resizes a side column's width. */
export function ColumnResizeHandle({ onPointerDown }: { onPointerDown: (e: React.PointerEvent) => void }) {
  return (
    <div
      className="hidden md:flex w-[5px] cursor-col-resize shrink-0 items-center justify-center group"
      onPointerDown={onPointerDown}
    >
      <div className="bg-zinc-800 group-hover:bg-blue-500/60 group-active:bg-blue-500 transition-colors h-full w-px" />
    </div>
  );
}
