import { describe, test, expect } from "bun:test";
import { formatProviderUsage, getUsageKey, buildUsageKeyToProviderMap, normalizeUsageKeys } from "./format-usage.js";
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

describe("buildUsageKeyToProviderMap", () => {
    test("maps display providers to usage keys", () => {
        const result = buildUsageKeyToProviderMap(["google", "openai", "anthropic"]);
        expect(result).toEqual({
            "google-gemini-cli": "google",
            "openai-codex": "openai",
            anthropic: "anthropic",
        });
    });

    test("handles providers that are already usage keys", () => {
        const result = buildUsageKeyToProviderMap(["openai-codex", "google-gemini-cli"]);
        expect(result).toEqual({
            "openai-codex": "openai-codex",
            "google-gemini-cli": "google-gemini-cli",
        });
    });

    test("ignores unknown providers", () => {
        const result = buildUsageKeyToProviderMap(["azure", "anthropic"]);
        expect(result).toEqual({ anthropic: "anthropic" });
    });

    test("first display name wins when multiple map to same usage key", () => {
        // "openai" and "openai-codex" both map to "openai-codex" usage key
        const result = buildUsageKeyToProviderMap(["openai", "openai-codex"]);
        expect(result["openai-codex"]).toBe("openai");
    });
});

describe("normalizeUsageKeys", () => {
    const sampleData: ProviderUsageData = {
        windows: [{ label: "7-day", utilization: 50, resets_at: "2026-03-14T00:00:00Z" }],
        status: "ok",
    };

    test("re-keys usage data to match display provider names", () => {
        const raw = { "google-gemini-cli": sampleData, "openai-codex": sampleData };
        const result = normalizeUsageKeys(raw, ["google", "openai", "anthropic"]);
        expect(Object.keys(result).sort()).toEqual(["google", "openai"]);
        expect(result["google"]).toBe(sampleData);
        expect(result["openai"]).toBe(sampleData);
    });

    test("keeps key unchanged if no display provider maps to it", () => {
        const raw = { "some-custom-provider": sampleData };
        const result = normalizeUsageKeys(raw, ["google"]);
        expect(result["some-custom-provider"]).toBe(sampleData);
    });

    test("passes through anthropic unchanged", () => {
        const raw = { anthropic: sampleData };
        const result = normalizeUsageKeys(raw, ["anthropic"]);
        expect(result["anthropic"]).toBe(sampleData);
    });
});
