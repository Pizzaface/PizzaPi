import { describe, test, expect } from "bun:test";
import { contextPercent, donutColor, donutStroke } from "./ContextDonut";

describe("contextPercent", () => {
  test("returns 0 when contextWindow is 0", () => {
    expect(contextPercent({ input: 1000, output: 500, cacheRead: 0, cacheWrite: 0, cost: 0 }, 0)).toBe(0);
  });

  test("returns 0 when contextWindow is negative", () => {
    expect(contextPercent({ input: 1000, output: 500, cacheRead: 0, cacheWrite: 0, cost: 0 }, -100)).toBe(0);
  });

  test("calculates percentage correctly", () => {
    const usage = { input: 50000, output: 10000, cacheRead: 20000, cacheWrite: 5000, cost: 0.5 };
    expect(contextPercent(usage, 200000)).toBe(25);
  });

  test("clamps at 100%", () => {
    const usage = { input: 300000, output: 10000, cacheRead: 0, cacheWrite: 0, cost: 0 };
    expect(contextPercent(usage, 200000)).toBe(100);
  });

  test("handles small usage", () => {
    const usage = { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: 0 };
    expect(contextPercent(usage, 200000)).toBeCloseTo(0.05, 2);
  });
});

describe("donutColor", () => {
  test("green for low usage", () => {
    expect(donutColor(0)).toContain("emerald");
    expect(donutColor(50)).toContain("emerald");
    expect(donutColor(64)).toContain("emerald");
  });

  test("amber for medium usage", () => {
    expect(donutColor(65)).toContain("amber");
    expect(donutColor(75)).toContain("amber");
    expect(donutColor(84)).toContain("amber");
  });

  test("red for high usage", () => {
    expect(donutColor(85)).toContain("red");
    expect(donutColor(95)).toContain("red");
    expect(donutColor(100)).toContain("red");
  });
});

describe("donutStroke", () => {
  test("green stroke for low usage", () => {
    expect(donutStroke(30)).toContain("emerald");
  });

  test("amber stroke for medium usage", () => {
    expect(donutStroke(70)).toContain("amber");
  });

  test("red stroke for high usage", () => {
    expect(donutStroke(90)).toContain("red");
  });
});
