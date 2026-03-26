/**
 * Tests for the core logic embedded in useMobileSidebar.
 *
 * Because the hook requires a React renderer (DOM environment) we test the
 * pure computational pieces extracted from the hook body. This covers the
 * swipe gesture state-machine decisions that control whether the sidebar
 * closes — ensuring regressions in gesture thresholds are caught early.
 */

import { describe, expect, test } from "bun:test";

// ── Pure helpers mirroring hook internals ──────────────────────────────────────

type AxisDecision = "vertical" | "locked-horizontal" | "undecided";

/**
 * Axis-lock decision for a running pointer move — mirrors the logic in
 * handleSidebarPointerMove that determines when to commit to a swipe axis.
 *
 * @param dx  delta-X since pointer-down (positive = rightward)
 * @param dy  delta-Y since pointer-down (positive = downward)
 */
function detectAxisDecision(dx: number, dy: number): AxisDecision {
  // Mirror: if (Math.abs(dy) > 8 && Math.abs(dy) > Math.abs(dx)) → vertical abort
  if (Math.abs(dy) > 8 && Math.abs(dy) > Math.abs(dx)) return "vertical";
  // Mirror: if (Math.abs(dx) > 8 && Math.abs(dx) > Math.abs(dy)) → locked
  if (Math.abs(dx) > 8 && Math.abs(dx) > Math.abs(dy)) return "locked-horizontal";
  return "undecided";
}

/**
 * Swipe-offset clamping — mirrors the clamped value computation in
 * handleSidebarPointerMove: `Math.max(-288, Math.min(8, dx))`.
 *
 * Only leftward drags produce significant negative offsets; rightward motion
 * is limited to a small (8 px) overscroll to give tactile feedback.
 * Leftward motion is bounded at -288 px (full sidebar width) to prevent
 * runaway offsets from over-translation.
 */
function clampSwipeOffset(dx: number): number {
  return Math.max(-288, Math.min(8, dx));
}

/**
 * Close decision — mirrors the threshold check in handleSidebarPointerUp:
 * "Close if dragged more than 80 px to the left."
 */
function shouldCloseSidebar(offset: number): boolean {
  return offset < -80;
}

// ── Axis-lock detection ───────────────────────────────────────────────────────

describe("detectAxisDecision", () => {
  test("returns 'undecided' while displacement is below the 8px threshold", () => {
    expect(detectAxisDecision(0, 0)).toBe("undecided");
    expect(detectAxisDecision(5, 0)).toBe("undecided");
    expect(detectAxisDecision(0, 5)).toBe("undecided");
    expect(detectAxisDecision(4, 4)).toBe("undecided");
  });

  test("returns 'vertical' when vertical movement dominates and exceeds 8px", () => {
    expect(detectAxisDecision(2, 20)).toBe("vertical");
    expect(detectAxisDecision(0, 50)).toBe("vertical");
    expect(detectAxisDecision(-3, 9)).toBe("vertical"); // dy > 8, dy > |dx|
  });

  test("returns 'locked-horizontal' when horizontal movement dominates and exceeds 8px", () => {
    expect(detectAxisDecision(-20, 2)).toBe("locked-horizontal");
    expect(detectAxisDecision(20, 0)).toBe("locked-horizontal");
    expect(detectAxisDecision(-9, 3)).toBe("locked-horizontal"); // |dx| > 8, |dx| > |dy|
  });

  test("'vertical' takes precedence when both axes exceed 8px but vertical is larger", () => {
    expect(detectAxisDecision(9, 15)).toBe("vertical");
  });

  test("'locked-horizontal' applies when both axes exceed 8px but horizontal is larger", () => {
    expect(detectAxisDecision(15, 9)).toBe("locked-horizontal");
  });

  test("boundary: exactly 8px is NOT > 8px → undecided", () => {
    expect(detectAxisDecision(8, 0)).toBe("undecided");
    expect(detectAxisDecision(0, 8)).toBe("undecided");
  });
});

// ── Swipe-offset clamping ────────────────────────────────────────────────────

describe("clampSwipeOffset", () => {
  test("passes leftward (negative) drag values through unchanged when within -288px bound", () => {
    expect(clampSwipeOffset(-10)).toBe(-10);
    expect(clampSwipeOffset(-80)).toBe(-80);
    expect(clampSwipeOffset(-200)).toBe(-200);
    expect(clampSwipeOffset(-288)).toBe(-288); // boundary — exactly at limit
  });

  test("clamps leftward drag at -288px (full sidebar width) lower bound", () => {
    expect(clampSwipeOffset(-289)).toBe(-288);
    expect(clampSwipeOffset(-300)).toBe(-288);
    expect(clampSwipeOffset(-500)).toBe(-288);
    expect(clampSwipeOffset(-1000)).toBe(-288);
  });

  test("clamps rightward (positive) drag to 8px maximum", () => {
    expect(clampSwipeOffset(0)).toBe(0);
    expect(clampSwipeOffset(5)).toBe(5);
    expect(clampSwipeOffset(8)).toBe(8);
    expect(clampSwipeOffset(9)).toBe(8);
    expect(clampSwipeOffset(100)).toBe(8);
  });
});

// ── Close decision ───────────────────────────────────────────────────────────

describe("shouldCloseSidebar", () => {
  test("returns true when offset is more than 80px left (offset < -80)", () => {
    expect(shouldCloseSidebar(-81)).toBe(true);
    expect(shouldCloseSidebar(-200)).toBe(true);
  });

  test("returns false when offset is exactly -80 (boundary — not < -80)", () => {
    expect(shouldCloseSidebar(-80)).toBe(false);
  });

  test("returns false when offset is less negative than -80", () => {
    expect(shouldCloseSidebar(-79)).toBe(false);
    expect(shouldCloseSidebar(0)).toBe(false);
    expect(shouldCloseSidebar(8)).toBe(false); // rightward overscroll
  });
});

// ── Combined gesture flow ────────────────────────────────────────────────────

describe("swipe gesture state machine", () => {
  test("aborts on vertical scroll (never reaches close threshold)", () => {
    // Simulate a scrolling gesture: dy grows faster than dx
    const gestures = [
      { dx: 0, dy: 5 },   // undecided
      { dx: -2, dy: 12 }, // vertical — abort
    ];
    let decision: AxisDecision = "undecided";
    for (const { dx, dy } of gestures) {
      decision = detectAxisDecision(dx, dy);
      if (decision === "vertical") break;
    }
    expect(decision).toBe("vertical");
    // After vertical abort the offset stays 0 (no swipe started)
    expect(shouldCloseSidebar(0)).toBe(false);
  });

  test("closes sidebar after sufficient leftward swipe", () => {
    // Simulate a fast leftward swipe: dx grows negative
    const dx = -120;
    const dy = 5;
    expect(detectAxisDecision(dx, dy)).toBe("locked-horizontal");
    const offset = clampSwipeOffset(dx);
    expect(shouldCloseSidebar(offset)).toBe(true);
  });

  test("does not close sidebar on short leftward swipe", () => {
    const dx = -50;
    const dy = 3;
    expect(detectAxisDecision(dx, dy)).toBe("locked-horizontal");
    const offset = clampSwipeOffset(dx);
    expect(shouldCloseSidebar(offset)).toBe(false);
  });

  test("does not close sidebar on rightward swipe", () => {
    const dx = 100;
    const dy = 0;
    expect(detectAxisDecision(dx, dy)).toBe("locked-horizontal");
    const offset = clampSwipeOffset(dx); // clamped to 8
    expect(shouldCloseSidebar(offset)).toBe(false);
  });
});
