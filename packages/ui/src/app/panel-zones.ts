/**
 * Pure layout helpers for the docked-panel shell: 3×3 drop-zone hit testing,
 * per-zone tab grouping, and side-column zone derivation.
 */
import type { ButtonSlot } from "@/hooks/useButtonPosition";
import type { PanelPosition } from "@/hooks/usePanelLayout";

/**
 * Map a pointer position inside `rect` to one of the 3×3 toolbar button
 * slots. The center cell maps to the header ("top").
 */
export function resolveButtonDragZone(
  clientX: number,
  clientY: number,
  rect: { left: number; top: number; width: number; height: number },
): ButtonSlot {
  const pctX = (clientX - rect.left) / rect.width;
  const pctY = (clientY - rect.top) / rect.height;
  const col = pctX < 1 / 3 ? "left" : pctX > 2 / 3 ? "right" : "center";
  const row = pctY < 1 / 3 ? "top" : pctY > 2 / 3 ? "bottom" : "middle";
  let zone: ButtonSlot;
  if (col === "left" && row === "top") zone = "left-top";
  else if (col === "center" && row === "top") zone = "center-top";
  else if (col === "right" && row === "top") zone = "right-top";
  else if (col === "left" && row === "middle") zone = "left-middle";
  else if (col === "center" && row === "middle") zone = "top";
  else if (col === "right" && row === "middle") zone = "right-middle";
  else if (col === "left" && row === "bottom") zone = "left-bottom";
  else if (col === "center" && row === "bottom") zone = "center-bottom";
  else zone = "right-bottom";
  return zone;
}

/** Every dockable zone, in canonical order. */
export const PANEL_POSITIONS: readonly PanelPosition[] = [
  "left-top", "left-middle", "left-bottom",
  "center-top", "center-bottom",
  "right-top", "right-middle", "right-bottom",
];

/** An empty tab list for every zone. */
export function createEmptyPanelGroups<T>(): Record<PanelPosition, T[]> {
  return {
    "left-top": [], "left-middle": [], "left-bottom": [],
    "center-top": [], "center-bottom": [],
    "right-top": [], "right-middle": [], "right-bottom": [],
  };
}

export interface ColumnZone<T> {
  pos: PanelPosition;
  tabs: T[];
  storedHeight: number;
  /** True for the zone that fills the remaining vertical space. */
  fills: boolean;
}

/**
 * Derive the visible zones of a side column, ordered top→middle→bottom. The
 * middle zone fills the remaining vertical space; if absent, the first visible
 * zone fills.
 */
export function buildColumnZones<T>(
  side: "left" | "right",
  groups: Record<PanelPosition, T[]>,
  topHeight: number,
  bottomHeight: number,
): ColumnZone<T>[] {
  const top = `${side}-top` as PanelPosition;
  const middle = `${side}-middle` as PanelPosition;
  const bottom = `${side}-bottom` as PanelPosition;
  const candidates = [
    { pos: top, tabs: groups[top], storedHeight: topHeight },
    { pos: middle, tabs: groups[middle], storedHeight: 0 },
    { pos: bottom, tabs: groups[bottom], storedHeight: bottomHeight },
  ].filter((z) => z.tabs.length > 0);
  const midIdx = candidates.findIndex((z) => z.pos === middle);
  const fillIdx = midIdx >= 0 ? midIdx : 0;
  return candidates.map((z, i) => ({ ...z, fills: i === fillIdx }));
}

/** Order-independent key for a set of tab ids (used for collapse state). */
export function getPanelGroupKey(tabIds: string[]): string {
  return [...tabIds].sort().join("|");
}

/**
 * Package-declared "guaranteed placement" map (serviceId → dock zone) for
 * non-launcher dynamic panels whose `placement` names a valid zone.
 */
export function resolveDeclaredPanelPlacements(
  panels: ReadonlyArray<{ serviceId: string; launcher?: unknown; placement?: string }>,
): Map<string, PanelPosition> {
  const zones = new Set<string>(PANEL_POSITIONS);
  const map = new Map<string, PanelPosition>();
  for (const p of panels) {
    if (p.launcher) continue;
    if (p.placement && zones.has(p.placement)) map.set(p.serviceId, p.placement as PanelPosition);
  }
  return map;
}
