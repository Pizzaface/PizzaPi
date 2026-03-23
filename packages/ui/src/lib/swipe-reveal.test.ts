import { describe, expect, test } from "bun:test";

import { pruneSwipeOffsets } from "./swipe-reveal";

describe("pruneSwipeOffsets", () => {
  test("keeps only the requested sessionId", () => {
    const offsets = new Map<string, number>([
      ["a", -10],
      ["b", -198],
    ]);

    const pruned = pruneSwipeOffsets(offsets, "b");
    expect([...pruned.entries()]).toEqual([["b", -198]]);
  });

  test("returns empty when keepSessionId is null", () => {
    const offsets = new Map<string, number>([["a", -10]]);
    const pruned = pruneSwipeOffsets(offsets, null);
    expect(pruned.size).toBe(0);
  });

  test("returns empty when keepSessionId is missing", () => {
    const offsets = new Map<string, number>([["a", -10]]);
    const pruned = pruneSwipeOffsets(offsets, "missing");
    expect(pruned.size).toBe(0);
  });

  test("preserves offset value 0", () => {
    const offsets = new Map<string, number>([["a", 0]]);
    const pruned = pruneSwipeOffsets(offsets, "a");
    expect([...pruned.entries()]).toEqual([["a", 0]]);
  });
});
