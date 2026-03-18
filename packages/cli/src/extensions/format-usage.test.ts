import { describe, test, expect } from "bun:test";
import { formatProviderUsage, getUsageKey } from "./format-usage.js";
import type { ProviderUsageData } from "./remote-types.js";

describe("formatProviderUsage", () => {
    test("returns empty array when data is undefined", () => {
        expect(formatProviderUsage(undefined)).toEqual([]);
    });

    test("returns unknown message when status is unknown", () => {
        const data: ProviderUsageData = { windows: [], status: "unknown", errorCode: 403 };
        expect(formatProviderUsage(data)).toEqual(["  Usage: unknown (access denied)"]);
    });

    test("returns empty array when no windows", () => {
        const data: ProviderUsageData = { windows: [], status: "ok" };
        expect(formatProviderUsage(data)).toEqual([]);
    });

    test("formats single window", () => {
        const data: ProviderUsageData = {
            windows: [{ label: "7-day", utilization: 62.3, resets_at: "2026-03-14T00:00:00Z" }],
            status: "ok",
        };
        expect(formatProviderUsage(data)).toEqual(["  Usage: 7-day: 62%"]);
    });

    test("formats multiple windows", () => {
        const data: ProviderUsageData = {
            windows: [
                { label: "5-hour", utilization: 25, resets_at: "2026-03-10T00:00:00Z" },
                { label: "7-day", utilization: 62, resets_at: "2026-03-14T00:00:00Z" },
            ],
            status: "ok",
        };
        expect(formatProviderUsage(data)).toEqual(["  Usage: 5-hour: 25%, 7-day: 62%"]);
    });

    test("rounds utilization to nearest integer", () => {
        const data: ProviderUsageData = {
            windows: [{ label: "7-day", utilization: 33.7, resets_at: "2026-03-14T00:00:00Z" }],
            status: "ok",
        };
        expect(formatProviderUsage(data)).toEqual(["  Usage: 7-day: 34%"]);
    });
});

describe("getUsageKey", () => {
    test("maps anthropic", () => expect(getUsageKey("anthropic")).toBe("anthropic"));
    test("maps openai-codex", () => expect(getUsageKey("openai-codex")).toBe("openai-codex"));
    test("maps openai to openai-codex", () => expect(getUsageKey("openai")).toBe("openai-codex"));
    test("maps google-gemini-cli", () => expect(getUsageKey("google-gemini-cli")).toBe("google-gemini-cli"));
    test("maps google to google-gemini-cli", () => expect(getUsageKey("google")).toBe("google-gemini-cli"));
    test("returns undefined for unknown provider", () => expect(getUsageKey("azure")).toBeUndefined());
});
