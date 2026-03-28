import { describe, expect, test } from "bun:test";
import {
  computePositionDropdownCoords,
  shouldCenterBottomSpanFullWidth,
  shouldCenterTopSpanFullWidth,
} from "./panelLayoutHelpers";

describe("shouldCenterTopSpanFullWidth", () => {
  test("returns true only when center-top exists and no side top panels exist", () => {
    expect(
      shouldCenterTopSpanFullWidth({
        "left-top": [],
        "left-middle": [],
        "left-bottom": [],
        "center-top": [{ length: 1 } as never],
        "center-bottom": [],
        "right-top": [],
        "right-middle": [],
        "right-bottom": [],
      }),
    ).toBe(true);
  });

  test("returns false when a left or right top panel exists", () => {
    expect(
      shouldCenterTopSpanFullWidth({
        "left-top": [{ length: 1 } as never],
        "left-middle": [],
        "left-bottom": [],
        "center-top": [{ length: 1 } as never],
        "center-bottom": [],
        "right-top": [],
        "right-middle": [],
        "right-bottom": [],
      }),
    ).toBe(false);

    expect(
      shouldCenterTopSpanFullWidth({
        "left-top": [],
        "left-middle": [],
        "left-bottom": [],
        "center-top": [{ length: 1 } as never],
        "center-bottom": [],
        "right-top": [{ length: 1 } as never],
        "right-middle": [],
        "right-bottom": [],
      }),
    ).toBe(false);
  });
});

describe("shouldCenterBottomSpanFullWidth", () => {
  test("returns true only when center-bottom exists and no side bottom panels exist", () => {
    expect(
      shouldCenterBottomSpanFullWidth({
        "left-top": [],
        "left-middle": [],
        "left-bottom": [],
        "center-top": [],
        "center-bottom": [{ length: 1 } as never],
        "right-top": [],
        "right-middle": [],
        "right-bottom": [],
      }),
    ).toBe(true);
  });

  test("returns false when a left or right bottom panel exists", () => {
    expect(
      shouldCenterBottomSpanFullWidth({
        "left-top": [],
        "left-middle": [],
        "left-bottom": [{ length: 1 } as never],
        "center-top": [],
        "center-bottom": [{ length: 1 } as never],
        "right-top": [],
        "right-middle": [],
        "right-bottom": [],
      }),
    ).toBe(false);

    expect(
      shouldCenterBottomSpanFullWidth({
        "left-top": [],
        "left-middle": [],
        "left-bottom": [],
        "center-top": [],
        "center-bottom": [{ length: 1 } as never],
        "right-top": [],
        "right-middle": [],
        "right-bottom": [{ length: 1 } as never],
      }),
    ).toBe(false);
  });
});

describe("computePositionDropdownCoords", () => {
  test("prefers rendering above the anchor when there is room", () => {
    expect(
      computePositionDropdownCoords(
        { top: 200, bottom: 220, left: 100, width: 40 },
        { width: 800, height: 600 },
        { width: 100, height: 70 },
      ),
    ).toEqual({ top: 124, left: 70 });
  });

  test("flips below the anchor when there is not enough room above", () => {
    expect(
      computePositionDropdownCoords(
        { top: 20, bottom: 40, left: 100, width: 40 },
        { width: 800, height: 600 },
        { width: 100, height: 70 },
      ),
    ).toEqual({ top: 46, left: 70 });
  });

  test("clamps to the viewport when near the edges", () => {
    expect(
      computePositionDropdownCoords(
        { top: 20, bottom: 40, left: 4, width: 20 },
        { width: 180, height: 120 },
        { width: 100, height: 70 },
      ),
    ).toEqual({ top: 42, left: 8 });
  });
});
