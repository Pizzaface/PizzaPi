/**
 * Provider usage/quota fetching and caching for the remote extension.
 *
 * Self-contained subsystem — no relay state needed. Fetches quota data from
 * Anthropic and OpenAI Codex, and caches results.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, defaultAgentDir, expandHome } from "../config.js";
import { getAnthropicKeychainToken } from "../runner/usage-auth.js";
import type { UsageWindow, ProviderUsageData } from "./remote-types.js";

const DEFAULT_USAGE_CACHE_TTL = 5 * 60 * 1000; // 5 min
const ANTHROPIC_USAGE_CACHE_TTL = 15 * 60 * 1000; // 15 min (rate-limit anthropic checks)

const usageCache = new Map<string, { data: ProviderUsageData; fetchedAt: number }>();

// When running as a runner-spawned worker the daemon is responsible for
// fetching provider quota data and writing it to a shared cache file.
const runnerUsageCachePath: string | null = process.env.PIZZAPI_RUNNER_USAGE_CACHE_PATH ?? null;

export function getOAuthToken(providerId: string): string | null {
    try {
        const config = loadConfig(process.cwd());
        const agentDir = config.agentDir
            ? expandHome(config.agentDir)
            : defaultAgentDir();
        const authPath = join(agentDir, "auth.json");
        if (!existsSync(authPath)) return null;
        const auth = JSON.parse(readFileSync(authPath, "utf-8"));
        return (auth as any)?.[providerId]?.access ?? null;
    } catch {
        return null;
    }
}

function providerUsageTtl(providerId: string): number {
    return providerId === "anthropic" ? ANTHROPIC_USAGE_CACHE_TTL : DEFAULT_USAGE_CACHE_TTL;
}

function isCached(providerId: string, opts: { force?: boolean } = {}): boolean {
    if (opts.force) return false;
    const entry = usageCache.get(providerId);
    if (!entry) return false;
    return Date.now() - entry.fetchedAt < providerUsageTtl(providerId);
}

/**
 * Drop windows whose `resets_at` has already passed — the window rolled over
 * and the cached utilization is stale (Anthropic is cached for 15 min, and
 * workers read a daemon-written snapshot that can be older still).
 * An unparseable `resets_at` is kept, so a bad timestamp can't hide real usage.
 */
export function activeUsageWindows(windows: UsageWindow[], now = Date.now()): UsageWindow[] {
    return windows.filter((w) => {
        const resetsAt = Date.parse(w.resets_at);
        return !Number.isFinite(resetsAt) || resetsAt > now;
    });
}

export function buildProviderUsage(): Record<string, ProviderUsageData> {
    const out: Record<string, ProviderUsageData> = {};
    const now = Date.now();
    for (const [id, { data }] of usageCache) {
        const windows = activeUsageWindows(data.windows, now);
        out[id] = windows.length === data.windows.length ? data : { ...data, windows };
    }
    return out;
}

/**
 * Read the runner daemon's shared usage cache file and populate the local
 * in-memory cache.
 */
async function refreshFromRunnerCache(): Promise<void> {
    if (!runnerUsageCachePath) return;
    try {
        if (!existsSync(runnerUsageCachePath)) return;
        const parsed = JSON.parse(readFileSync(runnerUsageCachePath, "utf-8")) as {
            fetchedAt: number;
            providers: Record<string, ProviderUsageData>;
        };
        const fetchedAt = typeof parsed.fetchedAt === "number" ? parsed.fetchedAt : 0;
        for (const [id, data] of Object.entries(parsed.providers ?? {})) {
            if (data && Array.isArray((data as ProviderUsageData).windows)) {
                usageCache.set(id, { data: data as ProviderUsageData, fetchedAt });
            }
        }
    } catch {
        // Non-fatal
    }
}

async function refreshAnthropicUsage(opts: { force?: boolean } = {}): Promise<void> {
    if (isCached("anthropic", opts)) return;
    // auth.json first, then Claude Code's own OAuth token (Keychain /
    // ~/.claude/.credentials.json) for users who never ran /login inside
    // pizzapi — read-only, never refreshed.
    const token = getOAuthToken("anthropic") ?? getAnthropicKeychainToken();
    if (!token) return;
    try {
        const res = await fetch("https://api.anthropic.com/api/oauth/usage", {
            headers: {
                Authorization: `Bearer ${token}`,
                "anthropic-version": "2023-06-01",
                "anthropic-beta": "oauth-2025-04-20",
            },
        });
        if (!res.ok) {
            if (res.status === 403) {
                usageCache.set("anthropic", {
                    data: { windows: [], status: "unknown", errorCode: 403 },
                    fetchedAt: Date.now(),
                });
            }
            return;
        }
        const raw = (await res.json()) as Record<string, unknown>;

        const WINDOW_LABELS: Record<string, string> = {
            five_hour: "5-hour",
            seven_day: "7-day",
            seven_day_opus: "7-day (Opus)",
            seven_day_sonnet: "7-day (Sonnet)",
            seven_day_oauth_apps: "7-day (OAuth apps)",
            seven_day_cowork: "7-day (co-work)",
        };
        const windows: UsageWindow[] = [];
        for (const [key, label] of Object.entries(WINDOW_LABELS)) {
            const w = raw[key] as { utilization: number; resets_at: string } | null | undefined;
            if (w?.resets_at != null && typeof w.utilization === "number") {
                windows.push({ label, utilization: w.utilization, resets_at: w.resets_at });
            }
        }
        if (windows.length > 0) {
            usageCache.set("anthropic", { data: { windows, status: "ok" }, fetchedAt: Date.now() });
        }
    } catch {
        // Non-fatal
    }
}

async function refreshCodexUsage(opts: { force?: boolean } = {}): Promise<void> {
    if (isCached("openai-codex", opts)) return;
    const token = getOAuthToken("openai-codex");
    if (!token) return;
    try {
        const res = await fetch("https://chatgpt.com/backend-api/wham/usage", {
            headers: {
                Authorization: `Bearer ${token}`,
            },
        });
        if (!res.ok) {
            if (res.status === 403) {
                usageCache.set("openai-codex", {
                    data: { windows: [], status: "unknown", errorCode: 403 },
                    fetchedAt: Date.now(),
                });
            }
            return;
        }
        const raw = (await res.json()) as {
            plan_type?: string;
            rate_limit?: {
                primary?: { used_percent: number; window_minutes?: number | null; resets_at?: number | null } | null;
                secondary?: { used_percent: number; window_minutes?: number | null; resets_at?: number | null } | null;
                primary_window?: { used_percent: number; limit_window_seconds?: number | null; reset_at?: number | null } | null;
                secondary_window?: { used_percent: number; limit_window_seconds?: number | null; reset_at?: number | null } | null;
            } | null;
            code_review_rate_limit?: {
                primary_window?: { used_percent: number; limit_window_seconds?: number | null; reset_at?: number | null } | null;
                secondary_window?: { used_percent: number; limit_window_seconds?: number | null; reset_at?: number | null } | null;
            } | null;
            additional_rate_limits?: Array<{
                limit_name: string;
                metered_feature?: string;
                rate_limit?: {
                    primary?: { used_percent: number; window_minutes?: number | null; resets_at?: number | null } | null;
                    primary_window?: { used_percent: number; limit_window_seconds?: number | null; reset_at?: number | null } | null;
                } | null;
            }> | null;
        };

        function windowLabel(minutes: number | null | undefined): string {
            if (!minutes) return "Usage";
            if (minutes < 60) return `${minutes}-min`;
            if (minutes < 60 * 24) return `${Math.round(minutes / 60)}-hour`;
            return `${Math.round(minutes / 60 / 24)}-day`;
        }

        function toWindow(
            w:
                | { used_percent: number; window_minutes?: number | null; resets_at?: number | null }
                | { used_percent: number; limit_window_seconds?: number | null; reset_at?: number | null }
                | null
                | undefined,
            label: string,
        ): UsageWindow | null {
            if (!w) return null;
            const used = typeof w.used_percent === "number" ? w.used_percent : null;
            const resetAt =
                "resets_at" in w
                    ? w.resets_at
                    : "reset_at" in w
                      ? w.reset_at
                      : null;
            if (used == null || resetAt == null) return null;

            const minutes =
                "window_minutes" in w
                    ? (w.window_minutes ?? undefined)
                    : "limit_window_seconds" in w && typeof w.limit_window_seconds === "number"
                      ? Math.max(1, Math.round(w.limit_window_seconds / 60))
                      : undefined;

            return {
                label: minutes ? windowLabel(minutes) : label,
                utilization: used,
                resets_at: new Date(resetAt * 1000).toISOString(),
            };
        }

        const windows: UsageWindow[] = [];
        const primary = toWindow(raw.rate_limit?.primary_window ?? raw.rate_limit?.primary, "Primary");
        if (primary) windows.push(primary);
        const secondary = toWindow(raw.rate_limit?.secondary_window ?? raw.rate_limit?.secondary, "Secondary");
        if (secondary) windows.push(secondary);

        for (const extra of raw.additional_rate_limits ?? []) {
            const w = toWindow(extra.rate_limit?.primary_window ?? extra.rate_limit?.primary, extra.limit_name);
            if (w) {
                w.label = extra.limit_name;
                windows.push(w);
            }
        }

        if (windows.length > 0) {
            usageCache.set("openai-codex", { data: { windows, status: "ok" }, fetchedAt: Date.now() });
        }
    } catch {
        // Non-fatal
    }
}

export async function refreshAllUsage(opts: { force?: boolean } = {}): Promise<void> {
    const force = opts.force === true;

    if (runnerUsageCachePath && !force) {
        await refreshFromRunnerCache();
        return;
    }

    await Promise.allSettled([
        refreshAnthropicUsage({ force }),
        refreshCodexUsage({ force }),
    ]);
}
