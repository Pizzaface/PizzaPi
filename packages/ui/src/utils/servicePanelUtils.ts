/**
 * Pure helpers for service panel layout decisions.
 *
 * Extracted from App.tsx so they can be imported by both the component and
 * tests.  Keeping the logic here means the tests exercise the real production
 * code rather than mirroring it, turning them into genuine regression guards.
 */

import type { PanelPosition } from "@/hooks/usePanelLayout";

/**
 * Decide which position a newly-opened service panel should occupy.
 *
 * When the currently-active tab is already a service panel, the new panel
 * inherits that panel's position so both appear in the same dock group.
 * Otherwise the new panel's own stored/default position is used.
 */
export function resolveNewPanelPosition(
    newServiceId: string,
    combinedActiveTab: string,
    activeServicePanels: Set<string>,
    getPanelPosition: (id: string) => PanelPosition,
): PanelPosition {
    if (activeServicePanels.has(combinedActiveTab)) {
        return getPanelPosition(combinedActiveTab);
    }
    return getPanelPosition(newServiceId);
}

/**
 * Given an ordered list of tab IDs in a dock group and the globally-active
 * tab ID, return which tab should be highlighted in that group.
 *
 * - If the active tab is present in the group → return it.
 * - Otherwise fall back to the first tab in the group.
 * - If the group is empty → return the active tab unchanged (caller must not
 *   render a panel for an empty group).
 */
export function resolveActiveTabIdFromIds(tabIds: string[], combinedActiveTab: string): string {
    if (tabIds.length === 0) return combinedActiveTab;
    return tabIds.includes(combinedActiveTab) ? combinedActiveTab : tabIds[0]!;
}
