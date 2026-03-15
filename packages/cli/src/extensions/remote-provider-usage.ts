/**
 * Provider usage/quota fetching and caching for the remote extension.
 *
 * Self-contained subsystem — no relay state needed. Fetches quota data from
 * Anthropic, OpenAI Codex, and Google Gemini CLI, and caches results.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { AuthStorage } from "@mariozechner/pi-coding-agent";
import { loadConfig, defaultAgentDir } from "../config.js";
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
            ? config.agentDir.replace(/^~/, homedir())
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

export function buildProviderUsage(): Record<string, ProviderUsageData> {
    const out: Record<string, ProviderUsageData> = {};
    for (const [id, { data }] of usageCache) out[id] = data;
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
    const token = getOAuthToken("anthropic");
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

async function refreshGeminiUsage(opts: { force?: boolean } = {}): Promise<void> {
    if (isCached("google-gemini-cli", opts)) return;
    let token: string;
    let projectId: string;
    try {
        const config = loadConfig(process.cwd());
        const agentDir = config.agentDir ? config.agentDir.replace(/^~/, homedir()) : defaultAgentDir();
        const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
        const raw = await authStorage.getApiKey("google-gemini-cli");
        if (!raw) return;
        const parsed = JSON.parse(raw) as { token?: string; projectId?: string };
        if (!parsed.token || !parsed.projectId) return;
        token = parsed.token;
        projectId = parsed.projectId;
    } catch {
        return;
    }

    try {
        const endpoint = process.env["CODE_ASSIST_ENDPOINT"] ?? "https://cloudcode-pa.googleapis.com";
        const version = process.env["CODE_ASSIST_API_VERSION"] ?? "v1internal";
        const res = await fetch(`${endpoint}/${version}:retrieveUserQuota`, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${token}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({ project: projectId }),
        });
        if (!res.ok) {
            if (res.status === 403) {
                usageCache.set("google-gemini-cli", {
                    data: { windows: [], status: "unknown", errorCode: 403 },
                    fetchedAt: Date.now(),
                });
            }
            return;
        }

        const raw = (await res.json()) as {
            buckets?: Array<{
                remainingAmount?: string;
                remainingFraction?: number;
                resetTime?: string;
                tokenType?: string;
                modelId?: string;
            }>;
        };

        const windows: UsageWindow[] = [];
        for (const bucket of raw.buckets ?? []) {
            if (bucket.remainingFraction == null || !bucket.resetTime) continue;
            const utilization = (1 - bucket.remainingFraction) * 100;
            const label = [bucket.tokenType, bucket.modelId].filter(Boolean).join(" / ") || "Quota";
            windows.push({ label, utilization, resets_at: bucket.resetTime });
        }
        if (windows.length > 0) {
            usageCache.set("google-gemini-cli", { data: { windows, status: "ok" }, fetchedAt: Date.now() });
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
        refreshGeminiUsage({ force }),
    ]);
}
