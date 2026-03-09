import { describe, expect, test } from "bun:test";
import { providerUsageDisplay, type ProviderUsageData } from "../lib/provider-usage";

describe("providerUsageDisplay", () => {
  test("returns unknown when provider status is unknown", () => {
    const data: ProviderUsageData = {
      windows: [],
      status: "unknown",
      errorCode: 403,
    };

    expect(providerUsageDisplay(data)).toEqual({
      kind: "unknown",
      usedPct: null,
      remainingPct: null,
    });
  });

  test("uses max utilization window and computes remaining", () => {
    const data: ProviderUsageData = {
      windows: [
        { label: "5-hour", utilization: 25, resets_at: "2026-03-10T00:00:00.000Z" },
        { label: "7-day", utilization: 62, resets_at: "2026-03-14T00:00:00.000Z" },
      ],
      status: "ok",
    };

    expect(providerUsageDisplay(data)).toEqual({
      kind: "usage",
      usedPct: 62,
      remainingPct: 38,
    });
  });

  test("clamps utilization to 0-100", () => {
    const high: ProviderUsageData = {
      windows: [{ label: "7-day", utilization: 140, resets_at: "2026-03-14T00:00:00.000Z" }],
    };
    const low: ProviderUsageData = {
      windows: [{ label: "7-day", utilization: -10, resets_at: "2026-03-14T00:00:00.000Z" }],
    };

    expect(providerUsageDisplay(high)).toEqual({ kind: "usage", usedPct: 100, remainingPct: 0 });
    expect(providerUsageDisplay(low)).toEqual({ kind: "usage", usedPct: 0, remainingPct: 100 });
  });
});
