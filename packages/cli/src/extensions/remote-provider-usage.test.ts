import { describe, expect, test } from "bun:test";
import { activeUsageWindows, preserveUsageWindowsOnError } from "./remote-provider-usage.js";

const NOW = Date.parse("2026-03-10T12:00:00Z");

describe("activeUsageWindows", () => {
    test("drops windows whose reset time has passed", () => {
        const result = activeUsageWindows(
            [
                { label: "5-hour", utilization: 90, resets_at: "2026-03-10T07:00:00Z" },
                { label: "7-day", utilization: 20, resets_at: "2026-03-14T00:00:00Z" },
            ],
            NOW,
        );
        expect(result.map((w) => w.label)).toEqual(["7-day"]);
    });

    test("keeps a window that resets exactly now-ish but in the future", () => {
        const result = activeUsageWindows(
            [{ label: "5-hour", utilization: 90, resets_at: new Date(NOW + 1).toISOString() }],
            NOW,
        );
        expect(result).toHaveLength(1);
    });

    test("keeps windows with an unparseable reset time", () => {
        const result = activeUsageWindows([{ label: "7-day", utilization: 50, resets_at: "whenever" }], NOW);
        expect(result).toHaveLength(1);
    });

    test("returns an empty list when everything has expired", () => {
        const result = activeUsageWindows(
            [{ label: "5-hour", utilization: 99, resets_at: "2026-03-01T00:00:00Z" }],
            NOW,
        );
        expect(result).toEqual([]);
    });
});

describe("preserveUsageWindowsOnError", () => {
    test("preserves existing windows and marks unknown with error code", () => {
        const existing = {
            windows: [{ label: "5-hour", utilization: 42, resets_at: "2026-12-31T23:59:59Z" }],
            status: "ok" as const,
        };
        expect(preserveUsageWindowsOnError(existing, 403)).toEqual({
            windows: existing.windows,
            status: "unknown",
            errorCode: 403,
        });
    });

    test("uses empty windows when no cached data exists", () => {
        expect(preserveUsageWindowsOnError(undefined, 429)).toEqual({
            windows: [],
            status: "unknown",
            errorCode: 429,
        });
    });

    test("does not drop existing windows on 401", () => {
        const existing = {
            windows: [
                { label: "5-hour", utilization: 88, resets_at: "2026-12-31T23:59:59Z" },
                { label: "7-day", utilization: 15, resets_at: "2026-12-31T23:59:59Z" },
            ],
            status: "ok" as const,
        };
        expect(preserveUsageWindowsOnError(existing, 401)).toEqual({
            windows: existing.windows,
            status: "unknown",
            errorCode: 401,
        });
    });
});
