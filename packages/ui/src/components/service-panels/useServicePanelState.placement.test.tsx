/**
 * useServicePanelState — package-declared "guaranteed placement".
 *
 * A dynamic panel that declares ServicePanelInfo.placement should dock at that
 * zone by default (instead of the generic right-middle), while a user-chosen
 * position still wins.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { PanelPosition } from "@/hooks/usePanelLayout";

const win = new Window({ url: "http://localhost/" });
(globalThis as any).window = win;
(globalThis as any).document = win.document;
(globalThis as any).localStorage = win.localStorage;

const { useServicePanelState } = await import("./ServicePanels");

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("useServicePanelState — declared placement", () => {
  test("uses the package-declared placement when the user has not moved the panel", () => {
    const placements = new Map<string, PanelPosition>([["schedules", "left-bottom"]]);
    const { result } = renderHook(() => useServicePanelState((id) => placements.get(id)));

    expect(result.current.getPanelPosition("schedules")).toBe("left-bottom");
    // No declared placement → generic default.
    expect(result.current.getPanelPosition("other")).toBe("right-middle");
  });

  test("a user-chosen position overrides the declared placement", () => {
    const placements = new Map<string, PanelPosition>([["schedules", "left-bottom"]]);
    const { result } = renderHook(() => useServicePanelState((id) => placements.get(id)));

    act(() => { result.current.setPanelPosition("schedules", "right-top"); });

    expect(result.current.getPanelPosition("schedules")).toBe("right-top");
  });
});
