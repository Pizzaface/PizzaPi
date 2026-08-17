import { describe, test, expect } from "bun:test";
import { activeWindows, isWindowExpired, providerUsageDisplay, showsUsageIndicator, type ProviderUsageData } from "./provider-usage";

const NOW = Date.parse("2026-03-10T12:00:00Z");

describe("showsUsageIndicator", () => {
    test("hides Google providers without hiding other usage", () => {
        expect(showsUsageIndicator("google-gemini-cli")).toBe(false);
        expect(showsUsageIndicator("Google-Vertex")).toBe(false);
        expect(showsUsageIndicator("anthropic")).toBe(true);
        expect(showsUsageIndicator("openai-codex")).toBe(true);
    });
});
const FUTURE = "2026-03-10T17:00:00Z";
const PAST = "2026-03-10T07:00:00Z";

describe("isWindowExpired", () => {
    test("past resets_at is expired", () => {
        expect(isWindowExpired({ label: "5-hour", utilization: 90, resets_at: PAST }, NOW)).toBe(true);
    });

    test("future resets_at is not expired", () => {
        expect(isWindowExpired({ label: "5-hour", utilization: 90, resets_at: FUTURE }, NOW)).toBe(false);
    });

    test("unparseable resets_at fails open (kept)", () => {
        expect(isWindowExpired({ label: "5-hour", utilization: 90, resets_at: "not-a-date" }, NOW)).toBe(false);
    });
});

describe("activeWindows", () => {
    test("drops expired windows and keeps live ones", () => {
        const result = activeWindows(
            [
                { label: "5-hour", utilization: 90, resets_at: PAST },
                { label: "7-day", utilization: 20, resets_at: FUTURE },
            ],
            NOW,
        );
        expect(result.map((w) => w.label)).toEqual(["7-day"]);
    });
});

describe("providerUsageDisplay", () => {
    test("reports the most-constrained window and names it", () => {
        const data: ProviderUsageData = {
            status: "ok",
            windows: [
                { label: "5-hour", utilization: 43, resets_at: FUTURE },
                { label: "7-day", utilization: 12, resets_at: FUTURE },
            ],
        };
        expect(providerUsageDisplay(data, NOW)).toEqual({
            kind: "usage",
            usedPct: 43,
            remainingPct: 57,
            label: "5-hour",
        });
    });

    test("ignores expired windows when picking the governing one", () => {
        const data: ProviderUsageData = {
            status: "ok",
            windows: [
                { label: "5-hour", utilization: 99, resets_at: PAST },
                { label: "7-day", utilization: 30, resets_at: FUTURE },
            ],
        };
        const display = providerUsageDisplay(data, NOW);
        expect(display.usedPct).toBe(30);
        expect(display.label).toBe("7-day");
    });

    test("all windows expired reads as fully reset", () => {
        const data: ProviderUsageData = {
            status: "ok",
            windows: [{ label: "5-hour", utilization: 99, resets_at: PAST }],
        };
        expect(providerUsageDisplay(data, NOW)).toEqual({
            kind: "usage",
            usedPct: 0,
            remainingPct: 100,
            label: null,
        });
    });

    test("no windows reads as fully available", () => {
        expect(providerUsageDisplay({ status: "ok", windows: [] }, NOW)).toEqual({
            kind: "usage",
            usedPct: 0,
            remainingPct: 100,
            label: null,
        });
    });

    test("clamps utilization into 0-100", () => {
        const high = providerUsageDisplay(
            { status: "ok", windows: [{ label: "7-day", utilization: 140, resets_at: FUTURE }] },
            NOW,
        );
        expect(high.usedPct).toBe(100);
        expect(high.remainingPct).toBe(0);

        const low = providerUsageDisplay(
            { status: "ok", windows: [{ label: "7-day", utilization: -10, resets_at: FUTURE }] },
            NOW,
        );
        expect(low.usedPct).toBe(0);
        expect(low.remainingPct).toBe(100);
    });

    test("unknown status short-circuits", () => {
        expect(providerUsageDisplay({ windows: [], status: "unknown", errorCode: 403 }, NOW)).toEqual({
            kind: "unknown",
            usedPct: null,
            remainingPct: null,
            label: null,
        });
    });
});
