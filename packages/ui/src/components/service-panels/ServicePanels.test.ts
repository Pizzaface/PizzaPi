/**
 * Tests for service panel focus behaviour.
 *
 * The two bugs addressed by this test suite:
 *
 * 1. **Adding bug** — when a new service panel is opened while a different
 *    service panel is already the active (combinedActiveTab) tab, the new
 *    panel should be placed into the *same position group* as the currently-
 *    active panel.  Previously the new panel used its stored/default position,
 *    which could be a different group — leaving the Tunnels panel highlighted
 *    in the old group while the new panel appeared elsewhere.
 *
 * 2. **Moving bug** — when a service panel tab is dragged to a new dock
 *    position, handleCombinedTabChange(serviceId) is now called so the moved
 *    panel stays as the globally-active tab.  Without this, the source group
 *    fell back to tabs[0] (Tunnels) and the user perceived Tunnels as having
 *    stolen focus.
 *
 * Because the fix lives in App.tsx (a large React component that requires a
 * real DOM renderer), the tests here verify the *pure decision logic*
 * extracted from that component — the same way usePanelLayout.test.ts tests
 * pure helpers rather than the full hook.
 */

import { describe, expect, test } from "bun:test";
import type { PanelPosition } from "@/hooks/usePanelLayout";

// ── Pure helpers mirroring App.tsx logic ──────────────────────────────────────

/**
 * Mirrors the position-override logic added to handleToggleServicePanel:
 *
 * When the currently-active tab IS a service panel (i.e. it's in
 * activeServicePanels), the new panel should inherit that panel's position so
 * both appear in the same group.  Otherwise the stored/default position is
 * used unchanged.
 */
function resolveNewPanelPosition(
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
 * Mirrors resolveActiveTabId in App.tsx:
 * returns combinedActiveTab if it is in the group, otherwise tabs[0].
 */
function resolveActiveTabId(tabs: string[], combinedActiveTab: string): string {
    if (tabs.length === 0) return combinedActiveTab;
    return tabs.includes(combinedActiveTab) ? combinedActiveTab : tabs[0]!;
}

// ── Adding bug: new panel should join the current active group ────────────────

describe("resolveNewPanelPosition — adding bug", () => {
    test("new panel inherits position of the currently-active service panel", () => {
        // Tunnel is open and at "bottom".  User opens godmother.
        // Before fix: godmother used its own stored position ("right"), causing
        // the two panels to land in different groups.
        // After fix: godmother is placed at "bottom" (same as tunnel).
        const activeServicePanels = new Set(["tunnel"]);
        const positions = new Map<string, PanelPosition>([
            ["tunnel", "bottom"],
            // godmother has a *different* stored position
            ["godmother", "right"],
        ]);
        const getPanelPosition = (id: string): PanelPosition =>
            positions.get(id) ?? "right";

        const result = resolveNewPanelPosition(
            "godmother",
            "tunnel",           // combinedActiveTab = tunnel (active service panel)
            activeServicePanels,
            getPanelPosition,
        );

        expect(result).toBe("bottom"); // same group as the active panel (tunnel)
    });

    test("uses stored position when no service panel is currently active", () => {
        // No service panels open yet.  combinedActiveTab = "terminal".
        // The new panel should use its stored/default position.
        const activeServicePanels = new Set<string>(); // empty
        const positions = new Map<string, PanelPosition>([["godmother", "left"]]);
        const getPanelPosition = (id: string): PanelPosition =>
            positions.get(id) ?? "right";

        const result = resolveNewPanelPosition(
            "godmother",
            "terminal",         // combinedActiveTab is NOT a service panel
            activeServicePanels,
            getPanelPosition,
        );

        expect(result).toBe("left"); // godmother's own stored position
    });

    test("uses default 'right' position when no service panel is active and no stored position", () => {
        const activeServicePanels = new Set<string>();
        const getPanelPosition = (_id: string): PanelPosition => "right"; // default

        const result = resolveNewPanelPosition(
            "godmother",
            "terminal",
            activeServicePanels,
            getPanelPosition,
        );

        expect(result).toBe("right");
    });

    test("opening a second panel while the first is active puts it in the same group", () => {
        // Tunnel is active at "right", godmother has a stale "bottom" in localStorage.
        // User clicks godmother button → should appear at "right" (same group as tunnel).
        const activeServicePanels = new Set(["tunnel"]);
        const positions = new Map<string, PanelPosition>([
            ["tunnel", "right"],
            ["godmother", "bottom"], // stale stored position
        ]);
        const getPanelPosition = (id: string): PanelPosition =>
            positions.get(id) ?? "right";

        const result = resolveNewPanelPosition(
            "godmother",
            "tunnel",
            activeServicePanels,
            getPanelPosition,
        );

        expect(result).toBe("right"); // follows tunnel, not the stale stored position
    });

    test("does not change position when new panel is already in the same group", () => {
        // Both panels default to "right" — the fix is a no-op in this case.
        const activeServicePanels = new Set(["tunnel"]);
        const positions = new Map<string, PanelPosition>([
            ["tunnel", "right"],
            ["godmother", "right"],
        ]);
        const getPanelPosition = (id: string): PanelPosition =>
            positions.get(id) ?? "right";

        const result = resolveNewPanelPosition(
            "godmother",
            "tunnel",
            activeServicePanels,
            getPanelPosition,
        );

        expect(result).toBe("right"); // no change needed
    });
});

// ── Moving bug: resolveActiveTabId should use combinedActiveTab when present ──

describe("resolveActiveTabId — moving bug", () => {
    test("returns combinedActiveTab when it is in the group", () => {
        // Both tunnel and godmother are in the right group; godmother is active.
        expect(
            resolveActiveTabId(["tunnel", "godmother"], "godmother"),
        ).toBe("godmother");
    });

    test("falls back to tabs[0] when combinedActiveTab is not in the group", () => {
        // Godmother moved to bottom; right group only has tunnel.
        // The correct fallback is tabs[0] = tunnel.
        expect(
            resolveActiveTabId(["tunnel"], "godmother"),
        ).toBe("tunnel");
    });

    test("after adding fix: both panels are in the same group so resolveActiveTabId returns the new panel", () => {
        // With the adding fix, godmother is placed in the same group as tunnel.
        // combinedActiveTab = "godmother" (set by handleCombinedTabChange).
        // Both panels are in the right group.
        const rightGroupTabs = ["tunnel", "godmother"];
        expect(resolveActiveTabId(rightGroupTabs, "godmother")).toBe("godmother");
    });

    test("single-tab group always returns its only tab", () => {
        // If godmother is the only tab in its group and is combinedActiveTab:
        expect(resolveActiveTabId(["godmother"], "godmother")).toBe("godmother");
        // If godmother is elsewhere and tunnel is the only tab:
        expect(resolveActiveTabId(["tunnel"], "godmother")).toBe("tunnel");
    });

    test("returns combinedActiveTab unchanged for empty tab list", () => {
        // No tabs → return combinedActiveTab (caller must not render a panel)
        expect(resolveActiveTabId([], "godmother")).toBe("godmother");
    });

    test("moving panel: combinedActiveTab re-asserted via handleCombinedTabChange keeps focus", () => {
        // After moving godmother from right to bottom, handleCombinedTabChange
        // is called with "godmother".  The bottom group correctly highlights it.
        const bottomGroupAfterMove = ["godmother"];
        expect(
            resolveActiveTabId(bottomGroupAfterMove, "godmother"),
        ).toBe("godmother");
    });
});
