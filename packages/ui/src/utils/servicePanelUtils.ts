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
 * Decide which package panels to auto-open (ServicePanelInfo.defaultOpen) as the
 * set of mode-visible panels changes.
 *
 * Loop-safe: a panel is auto-opened at most once while it stays visible, so a
 * user closing it does not fight a reopen. A panel that leaves the visible set
 * is forgotten, so re-entering its mode opens it again. `isActive` prevents
 * re-opening a panel the user opened manually.
 *
 * Returns the panels to open now and the next "already auto-opened" tracking
 * set the caller should persist.
 */
export function computeAutoOpenPanels(
    modePanels: ReadonlyArray<{ serviceId: string; defaultOpen?: boolean }>,
    alreadyAutoOpened: ReadonlySet<string>,
    isActive: (serviceId: string) => boolean,
): { toOpen: string[]; nextTracked: Set<string> } {
    const visible = new Set(modePanels.map((p) => p.serviceId));
    // Forget panels no longer visible so re-entry can open them again.
    const nextTracked = new Set([...alreadyAutoOpened].filter((id) => visible.has(id)));
    const toOpen: string[] = [];
    for (const panel of modePanels) {
        if (!panel.defaultOpen) continue;
        if (nextTracked.has(panel.serviceId)) continue;
        nextTracked.add(panel.serviceId);
        if (!isActive(panel.serviceId)) toOpen.push(panel.serviceId);
    }
    return { toOpen, nextTracked };
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

/**
 * Decide what clicking an open panel's header icon should do.
 *
 * - Panel is the tab currently shown in its dock zone → "close" (toggle off).
 * - Another tab is on top of the same zone → "focus" (bring the panel forward).
 */
export function resolvePanelToggleAction(
    zoneTabIds: string[],
    combinedActiveTab: string,
    serviceId: string,
): "close" | "focus" {
    return resolveActiveTabIdFromIds(zoneTabIds, combinedActiveTab) === serviceId ? "close" : "focus";
}

/**
 * Pick which runner's panels drive the session-list launcher surface.
 *
 * Launchers live outside any session (they hang off the session list), so with
 * nothing open there is no active session and therefore no active runner —
 * `useRunnerServices` returns zero panels and every launcher disappears. Fall
 * back to the runner feed, mirroring how session modes resolve their runner.
 */
export function resolveLauncherSource<P extends { launcher?: { surface: string } }, R extends { runnerId: string; panels?: P[] }>(
    activeRunnerPanels: P[] | undefined,
    activeRunnerId: string | null | undefined,
    feedRunners: R[],
    selectedRunnerId: string | null,
): { panels: P[]; runnerId: string | null } {
    // Match on launcher panels specifically: most runners announce panels and
    // none of them are launchers, so "first runner with any panel" silently
    // picks a runner that can never render the launcher.
    const isLauncher = (p: P) => p.launcher?.surface === "session-list";
    if (activeRunnerId && (activeRunnerPanels ?? []).some(isLauncher)) {
        return { panels: activeRunnerPanels ?? [], runnerId: activeRunnerId };
    }
    const hasLauncher = (r: R) => (r.panels ?? []).some(isLauncher);
    const runner = feedRunners.find((r) => r.runnerId === selectedRunnerId && hasLauncher(r))
        ?? feedRunners.find(hasLauncher);
    return { panels: runner?.panels ?? [], runnerId: runner?.runnerId ?? null };
}
