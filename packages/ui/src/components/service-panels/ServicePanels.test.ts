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
 * The helpers under test (`resolveNewPanelPosition`, `resolveActiveTabIdFromIds`)
 * are extracted from App.tsx into `@/utils/servicePanelUtils` so that these
 * tests exercise the real production code rather than mirror copies.
 */

import { describe, expect, test } from "bun:test";
import { resolveNewPanelPosition, resolveActiveTabIdFromIds } from "../../utils/servicePanelUtils";

// ── Adding bug: new panel should join the current active group ────────────────

describe("resolveNewPanelPosition — adding bug", () => {
    test("new panel inherits position of the currently-active service panel", () => {
        // Tunnel is open and at "bottom".  User opens godmother.
        // Before fix: godmother used its own stored position ("right"), causing
        // the two panels to land in different groups.
        // After fix: godmother is placed at "bottom" (same as tunnel).
        const activeServicePanels = new Set(["tunnel"]);
        const positions = new Map([
            ["tunnel", "center-bottom"],
            // godmother has a *different* stored position
            ["godmother", "right-middle"],
        ] as const);
        const getPanelPosition = (id: string) => positions.get(id) ?? "right-middle";

        const result = resolveNewPanelPosition(
            "godmother",
            "tunnel",           // combinedActiveTab = tunnel (active service panel)
            activeServicePanels,
            getPanelPosition,
        );

        expect(result).toBe("center-bottom"); // same group as the active panel (tunnel)
    });

    test("uses stored position when no service panel is currently active", () => {
        // No service panels open yet.  combinedActiveTab = "terminal".
        // The new panel should use its stored/default position.
        const activeServicePanels = new Set<string>(); // empty
        const positions = new Map([["godmother", "left-middle"]] as const);
        const getPanelPosition = (id: string) => positions.get(id) ?? "right-middle";

        const result = resolveNewPanelPosition(
            "godmother",
            "terminal",         // combinedActiveTab is NOT a service panel
            activeServicePanels,
            getPanelPosition,
        );

        expect(result).toBe("left-middle"); // godmother's own stored position
    });

    test("uses default 'right' position when no service panel is active and no stored position", () => {
        const activeServicePanels = new Set<string>();
        const getPanelPosition = (_id: string) => "right-middle" as const; // default

        const result = resolveNewPanelPosition(
            "godmother",
            "terminal",
            activeServicePanels,
            getPanelPosition,
        );

        expect(result).toBe("right-middle");
    });

    test("opening a second panel while the first is active puts it in the same group", () => {
        // Tunnel is active at "right", godmother has a stale "bottom" in localStorage.
        // User clicks godmother button → should appear at "right" (same group as tunnel).
        const activeServicePanels = new Set(["tunnel"]);
        const positions = new Map([
            ["tunnel", "right-middle"],
            ["godmother", "center-bottom"], // stale stored position
        ] as const);
        const getPanelPosition = (id: string) => positions.get(id) ?? "right-middle";

        const result = resolveNewPanelPosition(
            "godmother",
            "tunnel",
            activeServicePanels,
            getPanelPosition,
        );

        expect(result).toBe("right-middle"); // follows tunnel, not the stale stored position
    });

    test("does not change position when new panel is already in the same group", () => {
        // Both panels default to "right" — the fix is a no-op in this case.
        const activeServicePanels = new Set(["tunnel"]);
        const positions = new Map([
            ["tunnel", "right-middle"],
            ["godmother", "right-middle"],
        ] as const);
        const getPanelPosition = (id: string) => positions.get(id) ?? "right-middle";

        const result = resolveNewPanelPosition(
            "godmother",
            "tunnel",
            activeServicePanels,
            getPanelPosition,
        );

        expect(result).toBe("right-middle"); // no change needed
    });
});

// ── Persistence bug: auto-placement must NOT overwrite saved dock position ────

describe("resolveNewPanelPosition — persistence safety", () => {
    test("auto-placed position differs from the panel's own stored preference — persisting would corrupt it", () => {
        // Repro: godmother saved at "right". Tunnel is active at "bottom".
        // Auto-placement returns "bottom" (inherits from tunnel).
        // This confirms the computed position diverges from the stored preference,
        // so calling setServicePanelPosition with it would corrupt the saved value.
        // The fix: use setEphemeralPanelPosition (non-persisted) in this case.
        const activeServicePanels = new Set(["tunnel"]);
        const positions = new Map([
            ["tunnel", "center-bottom"],
            ["godmother", "right-middle"], // godmother's OWN saved preference
        ] as const);
        const getPanelPosition = (id: string) => positions.get(id) ?? "right-middle";

        const autoPlacedPosition = resolveNewPanelPosition(
            "godmother",
            "tunnel",           // active service panel → auto-placement triggered
            activeServicePanels,
            getPanelPosition,
        );

        // Auto-placement correctly returns "center-bottom" (same group as tunnel)…
        expect(autoPlacedPosition).toBe("center-bottom");
        // …but this DIFFERS from godmother's own stored preference ("right-middle"),
        // so persisting it would permanently corrupt the saved dock position.
        expect(autoPlacedPosition).not.toBe(getPanelPosition("godmother"));
    });

    test("non-auto-placement returns panel's own stored position — identical, safe to skip persistence", () => {
        // When the active tab is NOT a service panel, resolveNewPanelPosition
        // returns the panel's own stored preference, making any persist call a no-op.
        // The fix: skip the setServicePanelPosition call entirely in this path.
        const activeServicePanels = new Set<string>();
        const positions = new Map([["godmother", "left-middle"]] as const);
        const getPanelPosition = (id: string) => positions.get(id) ?? "right-middle";

        const position = resolveNewPanelPosition(
            "godmother",
            "terminal",         // NOT a service panel → no auto-placement
            activeServicePanels,
            getPanelPosition,
        );

        expect(position).toBe("left-middle");
        // Position equals the panel's own stored preference — no corruption possible.
        expect(position).toBe(getPanelPosition("godmother"));
    });

    test("reopening after auto-placement should still use stored position (ephemeral cleared on close)", () => {
        // Verifies the conceptual contract: after a panel is closed, its next
        // open (without auto-placement context) should use the stored preference,
        // not the stale transient position from the previous open.
        // The ephemeral override must be cleared on panel close.
        //
        // Scenario: godmother stored at "right". Opened next to tunnel ("bottom")
        // → auto-placed ephemeral="bottom". Closed. Opened again standalone.
        // Expected: uses stored "right", NOT the stale "bottom".
        const positions = new Map([["godmother", "right-middle"]] as const);
        const getPanelPosition = (id: string) => positions.get(id) ?? "right-middle";

        // Second open: active tab is NOT a service panel (tunnel closed)
        const activeServicePanels = new Set<string>();
        const position = resolveNewPanelPosition(
            "godmother",
            "terminal",
            activeServicePanels,
            getPanelPosition,
        );
        // Returns stored preference, not any stale ephemeral value
        expect(position).toBe("right-middle");
    });
});

// ── Moving bug: resolveActiveTabIdFromIds should use combinedActiveTab when present ──

describe("resolveActiveTabIdFromIds — moving bug", () => {
    test("returns combinedActiveTab when it is in the group", () => {
        // Both tunnel and godmother are in the right group; godmother is active.
        expect(
            resolveActiveTabIdFromIds(["tunnel", "godmother"], "godmother"),
        ).toBe("godmother");
    });

    test("falls back to tabs[0] when combinedActiveTab is not in the group", () => {
        // Godmother moved to bottom; right group only has tunnel.
        // The correct fallback is tabs[0] = tunnel.
        expect(
            resolveActiveTabIdFromIds(["tunnel"], "godmother"),
        ).toBe("tunnel");
    });

    test("after adding fix: both panels are in the same group so resolveActiveTabIdFromIds returns the new panel", () => {
        // With the adding fix, godmother is placed in the same group as tunnel.
        // combinedActiveTab = "godmother" (set by handleCombinedTabChange).
        // Both panels are in the right group.
        const rightGroupTabs = ["tunnel", "godmother"];
        expect(resolveActiveTabIdFromIds(rightGroupTabs, "godmother")).toBe("godmother");
    });

    test("single-tab group always returns its only tab", () => {
        // If godmother is the only tab in its group and is combinedActiveTab:
        expect(resolveActiveTabIdFromIds(["godmother"], "godmother")).toBe("godmother");
        // If godmother is elsewhere and tunnel is the only tab:
        expect(resolveActiveTabIdFromIds(["tunnel"], "godmother")).toBe("tunnel");
    });

    test("returns combinedActiveTab unchanged for empty tab list", () => {
        // No tabs → return combinedActiveTab (caller must not render a panel)
        expect(resolveActiveTabIdFromIds([], "godmother")).toBe("godmother");
    });

    test("moving panel: combinedActiveTab re-asserted via handleCombinedTabChange keeps focus", () => {
        // After moving godmother from right to bottom, handleCombinedTabChange
        // is called with "godmother".  The bottom group correctly highlights it.
        const bottomGroupAfterMove = ["godmother"];
        expect(
            resolveActiveTabIdFromIds(bottomGroupAfterMove, "godmother"),
        ).toBe("godmother");
    });
});
