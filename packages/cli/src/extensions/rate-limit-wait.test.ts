import { describe, expect, test } from "bun:test";
import { currentQuotaStatus, waitForQuotaReturn } from "./rate-limit-wait.js";
import { withUsageFreshness } from "./provider-quota.js";

const NOW = Date.parse("2026-01-01T00:00:00.000Z");

describe("rate-limit wait helpers", () => {
    test("uses shared provider-quota model-specific decisions", () => {
        const windows = [
            { label: "5-hour", utilization: 10, resets_at: "2026-01-01T01:00:00.000Z" },
            { label: "7-day (Opus)", utilization: 100, resets_at: "2026-01-01T01:00:00.000Z" },
            { label: "7-day (Sonnet)", utilization: 20, resets_at: "2026-01-01T01:00:00.000Z" },
        ];
        const usage = { anthropic: withUsageFreshness("anthropic", { status: "ok", windows }, NOW) };

        expect(currentQuotaStatus({ provider: "claude-subscription", id: "claude-sonnet-4-5" } as any, usage, NOW).state).toBe("available");
        expect(currentQuotaStatus({ provider: "claude-subscription", id: "claude-opus-4-5" } as any, usage, NOW).state).toBe("limited");
    });

    test("unknown, stale, or malformed quota is never treated as available", () => {
        const model = { provider: "anthropic", id: "claude-sonnet-4-5" } as any;
        expect(currentQuotaStatus(model, { anthropic: { status: "unknown", windows: [] } }, NOW).state).toBe("unknown");
        expect(currentQuotaStatus(model, { anthropic: withUsageFreshness("anthropic", { status: "ok", windows: [] }, NOW) }, NOW).state).toBe("unknown");
        expect(currentQuotaStatus(model, {
            anthropic: withUsageFreshness("anthropic", { status: "ok", windows: [{ label: "5-hour", utilization: 50, resets_at: "soon" }] }, NOW),
        }, NOW).state).toBe("unknown");
        expect(currentQuotaStatus(model, {
            anthropic: withUsageFreshness("anthropic", { status: "ok", windows: [{ label: "5-hour", utilization: 50, resets_at: "2026-01-01T01:00:00.000Z" }] }, NOW - 16 * 60 * 1000),
        }, NOW).state).toBe("unknown");
    });

    test("does not continue when quota is healthy on first validation", async () => {
        const usage = {
            "openai-codex": withUsageFreshness("openai-codex", { status: "ok", windows: [{ label: "Primary", utilization: 10, resets_at: "2026-01-01T00:10:00.000Z" }] }, NOW),
        };

        const result = await waitForQuotaReturn(
            { provider: "openai-codex", id: "gpt-5.5" } as any,
            async () => {},
            () => usage,
            new AbortController().signal,
            { now: () => NOW, sleep: async () => { throw new Error("should not sleep"); } },
        );

        expect(result).toMatchObject({ state: "unknown", reason: "unsupported_provider" });
    });

    test("waits until the latest exhausted applicable reset and revalidates", async () => {
        const model = { provider: "openai-codex", id: "gpt-5.5" } as any;
        const sleeps: number[] = [];
        let usage = {
            "openai-codex": withUsageFreshness("openai-codex", {
                status: "ok" as const,
                windows: [
                    { label: "Primary", utilization: 100, resets_at: "2026-01-01T00:00:01.000Z" },
                    { label: "Secondary", utilization: 100, resets_at: "2026-01-01T00:00:03.000Z" },
                ],
            }, NOW),
        };

        const result = await waitForQuotaReturn(
            model,
            async () => {
                if (sleeps.length > 0) {
                    usage = { "openai-codex": withUsageFreshness("openai-codex", { status: "ok", windows: [{ label: "Primary", utilization: 10, resets_at: "2026-01-01T00:10:00.000Z" }] }, NOW) };
                }
            },
            () => usage,
            new AbortController().signal,
            {
                now: () => NOW,
                sleep: async (ms) => { sleeps.push(ms); },
            },
        );

        expect(sleeps).toEqual([4000]);
        expect(result.state).toBe("available");
    });
});
