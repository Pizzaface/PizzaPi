import type { PanelPosition } from "@/hooks/usePanelLayout";

export type PanelGroupMap = Record<PanelPosition, { length: number }>;

export function shouldCenterTopSpanFullWidth(groups: PanelGroupMap): boolean {
  return groups["center-top"].length > 0 && groups["left-top"].length === 0 && groups["right-top"].length === 0;
}

export function shouldCenterBottomSpanFullWidth(groups: PanelGroupMap): boolean {
  return groups["center-bottom"].length > 0 && groups["left-bottom"].length === 0 && groups["right-bottom"].length === 0;
}

export function computePositionDropdownCoords(
  anchorRect: Pick<DOMRect, "top" | "left" | "width" | "bottom">,
  viewport: { width: number; height: number },
  popupSize: { width: number; height: number },
) {
  const margin = 8;
  const gap = 6;

  const preferredTop = anchorRect.top - gap - popupSize.height;
  const belowTop = anchorRect.bottom + gap;
  const top = preferredTop >= margin
    ? preferredTop
    : Math.min(belowTop, viewport.height - popupSize.height - margin);

  const left = Math.max(
    margin,
    Math.min(
      anchorRect.left + anchorRect.width / 2 - popupSize.width / 2,
      viewport.width - popupSize.width - margin,
    ),
  );

  return { top, left };
}
