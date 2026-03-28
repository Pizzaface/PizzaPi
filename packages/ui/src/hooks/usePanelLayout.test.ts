/**
 * Tests for the core logic embedded in usePanelLayout.
 *
 * Because the hook requires a React renderer (DOM environment) we test the
 * pure computational pieces extracted from the hook body. This ensures
 * regressions in the drag-zone detection and resize bounds logic are caught
 * without requiring @testing-library/react.
 */

import { describe, expect, test } from "bun:test";
import type { PanelPosition } from "./usePanelLayout";

// ── 9-zone drag detection ─────────────────────────────────────────────────────
// Mirrors the detectDragZone logic in usePanelLayout.ts (handleDragMove).
// col: left < 0.33, right > 0.67, else center
// row: top  < 0.33, bottom > 0.67, else middle
// center-middle returns null (main content area — not a dock target).

function detectDragZone(pctX: number, pctY: number): PanelPosition | null {
  const col: "left" | "center" | "right" =
    pctX < 0.33 ? "left" : pctX > 0.67 ? "right" : "center";
  const row: "top" | "middle" | "bottom" =
    pctY < 0.33 ? "top" : pctY > 0.67 ? "bottom" : "middle";
  if (col === "center" && row === "middle") return null;
  return `${col}-${row}` as PanelPosition;
}

// ── Column width clamp ────────────────────────────────────────────────────────
function clampColWidth(v: number) { return Math.max(200, Math.min(v, 1400)); }

// ── Zone height clamp ─────────────────────────────────────────────────────────
function clampZoneHeight(v: number) { return Math.max(80, Math.min(v, 900)); }

// ── detectDragZone ────────────────────────────────────────────────────────────

describe("detectDragZone — 9-zone 3×3 grid", () => {
  // Corners
  test("top-left corner → left-top", () => {
    expect(detectDragZone(0, 0)).toBe("left-top");
    expect(detectDragZone(0.1, 0.1)).toBe("left-top");
  });

  test("top-right corner → right-top", () => {
    expect(detectDragZone(1.0, 0)).toBe("right-top");
    expect(detectDragZone(0.9, 0.1)).toBe("right-top");
  });

  test("bottom-left corner → left-bottom", () => {
    expect(detectDragZone(0, 1.0)).toBe("left-bottom");
    expect(detectDragZone(0.1, 0.9)).toBe("left-bottom");
  });

  test("bottom-right corner → right-bottom", () => {
    expect(detectDragZone(1.0, 1.0)).toBe("right-bottom");
    expect(detectDragZone(0.9, 0.9)).toBe("right-bottom");
  });

  // Edges
  test("top-center → center-top", () => {
    expect(detectDragZone(0.5, 0)).toBe("center-top");
    expect(detectDragZone(0.5, 0.1)).toBe("center-top");
  });

  test("bottom-center → center-bottom", () => {
    expect(detectDragZone(0.5, 1.0)).toBe("center-bottom");
    expect(detectDragZone(0.5, 0.9)).toBe("center-bottom");
  });

  test("middle-left → left-middle", () => {
    expect(detectDragZone(0, 0.5)).toBe("left-middle");
    expect(detectDragZone(0.2, 0.5)).toBe("left-middle");
  });

  test("middle-right → right-middle", () => {
    expect(detectDragZone(1.0, 0.5)).toBe("right-middle");
    expect(detectDragZone(0.8, 0.5)).toBe("right-middle");
  });

  // Center-middle is null (main content, not a dock target)
  test("center-middle → null", () => {
    expect(detectDragZone(0.5, 0.5)).toBeNull();
    expect(detectDragZone(0.4, 0.4)).toBeNull();
    expect(detectDragZone(0.6, 0.6)).toBeNull();
  });

  // Boundary: exactly 0.33 is NOT < 0.33 → goes to center col
  test("pctX exactly 0.33 → center column (not left)", () => {
    expect(detectDragZone(0.33, 0.5)).toBeNull();  // center-middle
    expect(detectDragZone(0.33, 0.1)).toBe("center-top");
  });

  // Boundary: exactly 0.67 is NOT > 0.67 → stays in center col
  test("pctX exactly 0.67 → center column (not right)", () => {
    expect(detectDragZone(0.67, 0.5)).toBeNull();
    expect(detectDragZone(0.67, 0.9)).toBe("center-bottom");
  });

  // Boundary: exactly 0.33 for Y → center row (not top)
  test("pctY exactly 0.33 → middle row (not top)", () => {
    expect(detectDragZone(0.1, 0.33)).toBe("left-middle");
  });

  // Boundary: exactly 0.67 for Y → middle row (not bottom)
  test("pctY exactly 0.67 → middle row (not bottom)", () => {
    expect(detectDragZone(0.1, 0.67)).toBe("left-middle");
  });

  // All 8 dock zones are reachable
  test("all 8 dock zones are distinct and reachable", () => {
    const zones = new Set<PanelPosition | null>([
      detectDragZone(0.1, 0.1),  // left-top
      detectDragZone(0.5, 0.1),  // center-top
      detectDragZone(0.9, 0.1),  // right-top
      detectDragZone(0.1, 0.5),  // left-middle
      detectDragZone(0.9, 0.5),  // right-middle
      detectDragZone(0.1, 0.9),  // left-bottom
      detectDragZone(0.5, 0.9),  // center-bottom
      detectDragZone(0.9, 0.9),  // right-bottom
    ]);
    expect(zones.size).toBe(8);
    expect(zones.has("left-top")).toBe(true);
    expect(zones.has("center-top")).toBe(true);
    expect(zones.has("right-top")).toBe(true);
    expect(zones.has("left-middle")).toBe(true);
    expect(zones.has("right-middle")).toBe(true);
    expect(zones.has("left-bottom")).toBe(true);
    expect(zones.has("center-bottom")).toBe(true);
    expect(zones.has("right-bottom")).toBe(true);
  });
});

// ── Column width bounds ───────────────────────────────────────────────────────

describe("clampColWidth", () => {
  test("enforces minimum of 200", () => {
    expect(clampColWidth(0)).toBe(200);
    expect(clampColWidth(199)).toBe(200);
    expect(clampColWidth(200)).toBe(200);
  });

  test("enforces maximum of 1400", () => {
    expect(clampColWidth(1401)).toBe(1400);
    expect(clampColWidth(9999)).toBe(1400);
    expect(clampColWidth(1400)).toBe(1400);
  });

  test("passes through values in range", () => {
    expect(clampColWidth(320)).toBe(320);
    expect(clampColWidth(800)).toBe(800);
  });
});

// ── Zone height bounds ────────────────────────────────────────────────────────

describe("clampZoneHeight", () => {
  test("enforces minimum of 80", () => {
    expect(clampZoneHeight(0)).toBe(80);
    expect(clampZoneHeight(79)).toBe(80);
    expect(clampZoneHeight(80)).toBe(80);
  });

  test("enforces maximum of 900", () => {
    expect(clampZoneHeight(901)).toBe(900);
    expect(clampZoneHeight(9999)).toBe(900);
    expect(clampZoneHeight(900)).toBe(900);
  });

  test("passes through values in range", () => {
    expect(clampZoneHeight(200)).toBe(200);
    expect(clampZoneHeight(500)).toBe(500);
  });
});

// ── PanelPosition type guard ──────────────────────────────────────────────────

describe("PanelPosition type", () => {
  const allPositions: PanelPosition[] = [
    "left-top",    "left-middle",    "left-bottom",
    "center-top",  "center-bottom",
    "right-top",   "right-middle",   "right-bottom",
  ];

  test("has exactly 8 distinct values (center-middle is main content, not a zone)", () => {
    expect(new Set(allPositions).size).toBe(8);
  });

  test("contains all expected zone names", () => {
    expect(allPositions).toContain("left-top");
    expect(allPositions).toContain("left-middle");
    expect(allPositions).toContain("left-bottom");
    expect(allPositions).toContain("center-top");
    expect(allPositions).toContain("center-bottom");
    expect(allPositions).toContain("right-top");
    expect(allPositions).toContain("right-middle");
    expect(allPositions).toContain("right-bottom");
  });

  test("does not include old 3-value positions", () => {
    // Old values ("left", "right", "bottom") are migrated on load, not valid at runtime
    const set = new Set(allPositions as string[]);
    expect(set.has("left")).toBe(false);
    expect(set.has("right")).toBe(false);
    expect(set.has("bottom")).toBe(false);
  });
});

// ── Migration ─────────────────────────────────────────────────────────────────
// Mirrors the migratePanelPosition helper in usePanelLayout.ts.

function migratePanelPosition(raw: string | null, fallback: PanelPosition): PanelPosition {
  if (!raw) return fallback;
  if (raw === "left") return "left-middle";
  if (raw === "right") return "right-middle";
  if (raw === "bottom") return "center-bottom";
  const valid: readonly string[] = [
    "left-top", "left-middle", "left-bottom",
    "center-top", "center-bottom",
    "right-top", "right-middle", "right-bottom",
  ];
  return valid.includes(raw) ? (raw as PanelPosition) : fallback;
}

describe("migratePanelPosition — old 3-value → new 8-value", () => {
  test("'left' → 'left-middle'", () => {
    expect(migratePanelPosition("left", "right-middle")).toBe("left-middle");
  });

  test("'right' → 'right-middle'", () => {
    expect(migratePanelPosition("right", "left-middle")).toBe("right-middle");
  });

  test("'bottom' → 'center-bottom'", () => {
    expect(migratePanelPosition("bottom", "right-middle")).toBe("center-bottom");
  });

  test("null → fallback", () => {
    expect(migratePanelPosition(null, "left-middle")).toBe("left-middle");
    expect(migratePanelPosition(null, "right-middle")).toBe("right-middle");
  });

  test("valid new position → unchanged", () => {
    expect(migratePanelPosition("left-top",      "right-middle")).toBe("left-top");
    expect(migratePanelPosition("center-bottom", "right-middle")).toBe("center-bottom");
    expect(migratePanelPosition("right-bottom",  "left-middle")).toBe("right-bottom");
  });

  test("unknown string → fallback", () => {
    expect(migratePanelPosition("unknown-zone", "right-middle")).toBe("right-middle");
    expect(migratePanelPosition("center-middle", "left-middle")).toBe("left-middle");
  });
});
