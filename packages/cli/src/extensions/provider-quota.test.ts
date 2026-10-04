import { afterEach, describe, expect, test } from "bun:test";
import { USAGE_FAILURE_COOLDOWN_MS, fetchJsonWithTimeout, isUsageRefreshCoolingDown, parseAnthropicUsageWindows, parseCodexUsageWindows, quotaDecisionForModel, withUsageFreshness } from "./provider-quota.js";
import type { ProviderUsageData } from "./remote-types.js";

const NOW = Date.parse("2026-03-10T12:00:00Z");
const FUTURE = "2026-03-10T13:00:00Z";

function usage(data: Partial<ProviderUsageData>): ProviderUsageData {
    return { status: "ok", windows: [{ label: "5-hour", utilization: 50, resets_at: FUTURE }], ...data };
}

describe("withUsageFreshness", () => {
    test("adds fetched, checked, and expiry timestamps", () => {
        expect(withUsageFreshness("openai-codex", usage({}), NOW)).toMatchObject({
            fetchedAt: NOW,
            checkedAt: NOW,
            expiresAt: NOW + 5 * 60 * 1000,
        });
    });
});

describe("isUsageRefreshCoolingDown", () => {
    test("only cools down recent unknown checks", () => {
        expect(isUsageRefreshCoolingDown({ windows: [], status: "unknown", checkedAt: NOW }, NOW + USAGE_FAILURE_COOLDOWN_MS - 1)).toBe(true);
        expect(isUsageRefreshCoolingDown({ windows: [], status: "unknown", checkedAt: NOW }, NOW + USAGE_FAILURE_COOLDOWN_MS)).toBe(false);
        expect(isUsageRefreshCoolingDown({ windows: [], status: "ok", checkedAt: NOW }, NOW + 1)).toBe(false);
    });
});

describe("quotaDecisionForModel", () => {
    test("never treats missing usage as available", () => {
        expect(quotaDecisionForModel({}, "anthropic", "claude-sonnet-4", NOW)).toEqual({
            state: "unknown",
            reason: "missing",
            windows: [],
        });
    });

    test("never treats stale usage as available", () => {
        const data = withUsageFreshness("anthropic", usage({}), NOW - 16 * 60 * 1000);
        expect(quotaDecisionForModel({ anthropic: data }, "claude-subscription", "claude-sonnet-4", NOW)).toMatchObject({
            state: "unknown",
            reason: "stale",
        });
    });

    test("never treats unknown provider status as available", () => {
        const data = withUsageFreshness("anthropic", usage({ status: "unknown", errorCode: 403 }), NOW);
        expect(quotaDecisionForModel({ anthropic: data }, "anthropic", "claude-sonnet-4", NOW)).toMatchObject({
            state: "unknown",
            reason: "provider_status",
        });
    });

    test("reports available only for fresh ok active windows below quota", () => {
        const data = withUsageFreshness("anthropic", usage({}), NOW);
        expect(quotaDecisionForModel({ anthropic: data }, "claude-subscription", "claude-sonnet-4", NOW)).toMatchObject({
            state: "available",
            reason: "fresh",
        });
    });

    test("reports limited with latest exhausted reset", () => {
        const data = withUsageFreshness("anthropic", usage({
            windows: [
                { label: "5-hour", utilization: 100, resets_at: "2026-03-10T15:00:00Z" },
                { label: "7-day", utilization: 100, resets_at: "2026-03-10T14:00:00Z" },
            ],
        }), NOW);
        expect(quotaDecisionForModel({ anthropic: data }, "anthropic", "claude-sonnet-4", NOW)).toEqual({
            state: "limited",
            reason: "quota_exhausted",
            resetAt: "2026-03-10T15:00:00Z",
            windows: data.windows,
        });
    });

    test("returns unknown for malformed utilization or reset data", () => {
        const badUtilization = withUsageFreshness("anthropic", usage({
            windows: [{ label: "5-hour", utilization: Number.NaN, resets_at: FUTURE }],
        }), NOW);
        expect(quotaDecisionForModel({ anthropic: badUtilization }, "anthropic", "claude-sonnet-4", NOW)).toMatchObject({
            state: "unknown",
            reason: "malformed",
        });

        const badReset = withUsageFreshness("anthropic", usage({
            windows: [{ label: "5-hour", utilization: 50, resets_at: "soon" }],
        }), NOW);
        expect(quotaDecisionForModel({ anthropic: badReset }, "anthropic", "claude-sonnet-4", NOW)).toMatchObject({
            state: "unknown",
            reason: "malformed",
        });
    });

    test("does not report available after a blocking window reset without a fresh fetch", () => {
        const data = withUsageFreshness("anthropic", usage({
            windows: [
                { label: "5-hour", utilization: 100, resets_at: "2026-03-10T11:59:00Z" },
                { label: "7-day", utilization: 40, resets_at: FUTURE },
            ],
        }), NOW);
        expect(quotaDecisionForModel({ anthropic: data }, "anthropic", "claude-sonnet-4", NOW)).toMatchObject({
            state: "unknown",
            reason: "stale",
        });
    });

    test("filters Anthropic model-specific windows", () => {
        const data = withUsageFreshness("anthropic", usage({
            windows: [
                { label: "5-hour", utilization: 20, resets_at: FUTURE },
                { label: "7-day", utilization: 20, resets_at: FUTURE },
                { label: "7-day (Opus)", utilization: 100, resets_at: FUTURE },
                { label: "7-day (Sonnet)", utilization: 40, resets_at: FUTURE },
            ],
        }), NOW);
        expect(quotaDecisionForModel({ anthropic: data }, "anthropic", "claude-sonnet-4", NOW)).toMatchObject({
            state: "available",
        });
        expect(quotaDecisionForModel({ anthropic: data }, "anthropic", "claude-opus-4", NOW)).toMatchObject({
            state: "limited",
        });
    });

    test("does not block normal Claude models on exhausted cowork or oauth-app scopes", () => {
        const parsed = parseAnthropicUsageWindows({
            five_hour: { utilization: 20, resets_at: FUTURE },
            seven_day: { utilization: 20, resets_at: FUTURE },
            seven_day_cowork: { utilization: 100, resets_at: FUTURE },
        });
        const data = withUsageFreshness("anthropic", usage({ windows: parsed.windows }), NOW);
        expect(quotaDecisionForModel({ anthropic: data }, "anthropic", "claude-sonnet-4", NOW)).toMatchObject({
            state: "unknown",
            reason: "unknown_scope",
        });
    });

    test("does not block regular Codex models on exhausted additional-rate-limit scopes", () => {
        const parsed = parseCodexUsageWindows({
            rate_limit: { primary: { used_percent: 20, resets_at: Date.parse(FUTURE) / 1000, window_minutes: 300 } },
            additional_rate_limits: [{ limit_name: "spark", metered_feature: "spark", rate_limit: { primary: { used_percent: 100, resets_at: Date.parse(FUTURE) / 1000 } } }],
        });
        const data = withUsageFreshness("openai-codex", usage({ windows: parsed.windows }), NOW);
        expect(quotaDecisionForModel({ "openai-codex": data }, "openai-codex", "gpt-5.5", NOW)).toMatchObject({
            state: "unknown",
            reason: "unknown_scope",
        });
    });

    test("unused optional windows do not invalidate known Anthropic quota", () => {
        const parsed = parseAnthropicUsageWindows({
            five_hour: { utilization: 20, resets_at: FUTURE },
            seven_day_opus: { utilization: 0, resets_at: null },
        });
        expect(parsed.malformed).toBe(false);
        expect(parsed.windows).toHaveLength(1);
    });

    test("Codex zero-utilization windows without a reset provide no recovery evidence", () => {
        const parsed = parseCodexUsageWindows({
            rate_limit: { primary: { used_percent: 0, resets_at: null, window_minutes: 300 } },
        });
        const data = withUsageFreshness("openai-codex", usage({ windows: parsed.windows, status: parsed.malformed ? "unknown" : "ok" }), NOW);
        expect(parsed.malformed).toBe(false);
        expect(quotaDecisionForModel({ "openai-codex": data }, "openai-codex", "gpt-5.5", NOW)).toMatchObject({
            state: "unknown",
        });
    });
});

describe("fetchJsonWithTimeout", () => {
    const originalFetch = globalThis.fetch;

    afterEach(() => {
        globalThis.fetch = originalFetch;
    });

    test("timeout still aborts when caller supplies a signal", async () => {
        globalThis.fetch = Object.assign(async (_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
        }), { preconnect: () => {} });

        const controller = new AbortController();
        await expect(fetchJsonWithTimeout("https://example.test", { signal: controller.signal }, 1)).rejects.toThrow();
    });

    test("timeout covers json body parsing", async () => {
        globalThis.fetch = Object.assign(async () => ({
            ok: true,
            status: 200,
            json: async () => new Promise((resolve) => setTimeout(() => resolve({ ok: true }), 50)),
        }) as Response, { preconnect: () => {} });

        await expect(fetchJsonWithTimeout("https://example.test", {}, 1)).rejects.toThrow();
    });
});
