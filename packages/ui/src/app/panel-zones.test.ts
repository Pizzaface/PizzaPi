import { describe, expect, test } from "bun:test";
import {
  buildColumnZones,
  createEmptyPanelGroups,
  getPanelGroupKey,
  PANEL_POSITIONS,
  resolveButtonDragZone,
  resolveDeclaredPanelPlacements,
} from "./panel-zones";

describe("resolveButtonDragZone", () => {
  const rect = { left: 100, top: 50, width: 300, height: 300 };
  const at = (fx: number, fy: number) =>
    resolveButtonDragZone(rect.left + fx * rect.width, rect.top + fy * rect.height, rect);

  test("maps each third of the rect to a slot (center → header)", () => {
    expect(at(0.1, 0.1)).toBe("left-top");
    expect(at(0.5, 0.1)).toBe("center-top");
    expect(at(0.9, 0.1)).toBe("right-top");
    expect(at(0.1, 0.5)).toBe("left-middle");
    expect(at(0.5, 0.5)).toBe("top");
    expect(at(0.9, 0.5)).toBe("right-middle");
    expect(at(0.1, 0.9)).toBe("left-bottom");
    expect(at(0.5, 0.9)).toBe("center-bottom");
    expect(at(0.9, 0.9)).toBe("right-bottom");
  });

  test("points outside the rect clamp to the nearest edge cell", () => {
    expect(at(-1, -1)).toBe("left-top");
    expect(at(2, 2)).toBe("right-bottom");
  });
});

describe("createEmptyPanelGroups", () => {
  test("has an empty list for every zone", () => {
    const groups = createEmptyPanelGroups<string>();
    expect(Object.keys(groups).sort()).toEqual([...PANEL_POSITIONS].sort());
    expect(Object.values(groups).every((g) => g.length === 0)).toBe(true);
  });
});

describe("buildColumnZones", () => {
  test("middle zone fills when present", () => {
    const groups = createEmptyPanelGroups<string>();
    groups["left-top"].push("a");
    groups["left-middle"].push("b");
    groups["left-bottom"].push("c");
    expect(buildColumnZones("left", groups, 120, 80)).toEqual([
      { pos: "left-top", tabs: ["a"], storedHeight: 120, fills: false },
      { pos: "left-middle", tabs: ["b"], storedHeight: 0, fills: true },
      { pos: "left-bottom", tabs: ["c"], storedHeight: 80, fills: false },
    ]);
  });

  test("first visible zone fills when there is no middle zone", () => {
    const groups = createEmptyPanelGroups<string>();
    groups["right-bottom"].push("x");
    groups["right-top"].push("y");
    const zones = buildColumnZones("right", groups, 10, 20);
    expect(zones.map((z) => [z.pos, z.fills])).toEqual([["right-top", true], ["right-bottom", false]]);
  });

  test("empty column yields no zones", () => {
    expect(buildColumnZones("left", createEmptyPanelGroups<string>(), 1, 1)).toEqual([]);
  });
});

describe("getPanelGroupKey", () => {
  test("is order-independent", () => {
    expect(getPanelGroupKey(["b", "a"])).toBe("a|b");
    expect(getPanelGroupKey(["a", "b"])).toBe(getPanelGroupKey(["b", "a"]));
  });
});

describe("resolveDeclaredPanelPlacements", () => {
  test("maps valid placements of non-launcher panels", () => {
    const map = resolveDeclaredPanelPlacements([
      { serviceId: "a", placement: "left-bottom" },
      { serviceId: "b", placement: "nowhere" },
      { serviceId: "c" },
      { serviceId: "d", placement: "right-top", launcher: { label: "x" } },
    ]);
    expect([...map.entries()]).toEqual([["a", "left-bottom"]]);
  });
});
