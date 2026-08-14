import { describe, expect, test } from "bun:test";
import { resetStaleBaselineOnVisibilityChange } from "./lib/viewer-connection";

describe("stale connection visibility baseline", () => {
  test("resets an old hidden-tab event baseline when returning visible", () => {
    const now = 1_000_000;
    const oldHiddenEvent = now - 180_000;
    const baseline = resetStaleBaselineOnVisibilityChange("visible", oldHiddenEvent, now);

    expect(now - baseline).toBe(0);
    expect(now - baseline).toBeLessThan(30_000);
  });

  test("keeps the baseline unchanged while hidden", () => {
    const oldHiddenEvent = 820_000;

    expect(resetStaleBaselineOnVisibilityChange("hidden", oldHiddenEvent, 1_000_000)).toBe(oldHiddenEvent);
  });
});
