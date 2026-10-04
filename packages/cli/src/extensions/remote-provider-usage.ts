/**
 * Provider usage/quota fetching and caching for the remote extension.
 *
 * Self-contained subsystem — no relay state needed. Fetches quota data from
 * Anthropic and OpenAI Codex, and caches results.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readStoredCredential } from "@earendil-works/pi-coding-agent";
import { loadConfig, defaultAgentDir, expandHome } from "../config.js";
import { getAnthropicKeychainToken, getOAuthAccessToken } from "../runner/usage-auth.js";
import type { ProviderUsageData } from "./remote-types.js";
import { fetchJsonWithTimeout, isUsageRefreshCoolingDown, parseAnthropicUsageWindows, parseCodexUsageWindows, usageCacheTtl, usageUnknown, withUsageFreshness } from "./provider-quota.js";

const usageCache = new Map<string, { data: ProviderUsageData; fetchedAt: number }>();

// When running as a runner-spawned worker the daemon is responsible for
// fetching provider quota data and writing it to a shared cache file.
const runnerUsageCachePath: string | null = process.env.PIZZAPI_RUNNER_USAGE_CACHE_PATH ?? null;

// ── Runner-daemon IPC for forced usage refreshes ─────────────────────────────
//
// The daemon is the single source of truth for provider quota on a runner
// node. When the web UI asks for a forced refresh, ask the daemon to update
// its shared cache file rather than every worker hammering the provider APIs
// independently.

const pendingRefreshRequests = new Map<string, () => void>();

function isRefreshCompleteMessage(msg: unknown): msg is { type: "refresh_usage_complete"; requestId: string } {
    return (
        typeof msg === "object" && msg !== null &&
        (msg as Record<string, unknown>).type === "refresh_usage_complete" &&
        typeof (msg as Record<string, unknown>).requestId === "string"
    );
}

if (typeof process !== "undefined" && typeof process.send === "function") {
    process.on("message", (msg: unknown) => {
        if (!isRefreshCompleteMessage(msg)) return;
        const resolve = pendingRefreshRequests.get(msg.requestId);
        if (!resolve) return;
        resolve();
        pendingRefreshRequests.delete(msg.requestId);
    });
}

function requestRunnerUsageRefresh(timeoutMs = 5000): Promise<boolean> {
    if (typeof process.send !== "function") return Promise.resolve(false);
    const requestId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    return new Promise((resolve) => {
        const timer = setTimeout(() => {
            pendingRefreshRequests.delete(requestId);
            resolve(false);
        }, timeoutMs);
        pendingRefreshRequests.set(requestId, () => {
            clearTimeout(timer);
            resolve(true);
        });
        try {
            process.send!({ type: "refresh_usage_request", requestId });
        } catch {
            clearTimeout(timer);
            pendingRefreshRequests.delete(requestId);
            resolve(false);
        }
    });
}

export function getOAuthToken(providerId: string): string | null {
    return getOAuthTokens([providerId])[0] ?? null;
}

function getOAuthTokens(providerIds: string[]): string[] {
    try {
        const config = loadConfig(process.cwd());
        const agentDir = config.agentDir
            ? expandHome(config.agentDir)
            : defaultAgentDir();
        const authPath = join(agentDir, "auth.json");
        const tokens: string[] = [];
        for (const providerId of providerIds) {
            const token = getOAuthAccessToken(readStoredCredential(providerId, authPath));
            if (token && !tokens.includes(token)) tokens.push(token);
        }
        return tokens;
    } catch {
        return [];
    }
}

function isProviderUsageData(value: unknown): value is ProviderUsageData {
    if (typeof value !== "object" || value === null || !Array.isArray((value as ProviderUsageData).windows)) return false;
    return (value as ProviderUsageData).windows.every((w) => (
        typeof w === "object" &&
        w !== null &&
        typeof w.label === "string" &&
        typeof w.utilization === "number" &&
        typeof w.resets_at === "string"
    ));
}

function isCached(providerId: string, opts: { force?: boolean } = {}): boolean {
    if (opts.force) return false;
    const entry = usageCache.get(providerId);
    if (!entry) return false;
    const now = Date.now();
    return entry.data.status === "unknown"
        ? isUsageRefreshCoolingDown(entry.data, now)
        : now - entry.fetchedAt < usageCacheTtl(providerId);
}

export function buildProviderUsage(): Record<string, ProviderUsageData> {
    const out: Record<string, ProviderUsageData> = {};
    const now = Date.now();
    for (const [id, { data }] of usageCache) {
        out[id] = typeof data.expiresAt === "number" && data.expiresAt <= now
            ? { ...data, status: "unknown" }
            : data;
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
            if (isProviderUsageData(data)) {
                const providerFetchedAt = typeof data.fetchedAt === "number" ? data.fetchedAt : fetchedAt;
                usageCache.set(id, { data: withUsageFreshness(id, data, providerFetchedAt), fetchedAt: providerFetchedAt });
            }
        }
    } catch {
        // Non-fatal
    }
}

/** Preserve existing usage windows when a provider auth/rate-limit error occurs. */
export function preserveUsageWindowsOnError(
    existing: ProviderUsageData | undefined,
    status: number,
    checkedAt = Date.now(),
): ProviderUsageData {
    return usageUnknown(existing, status, checkedAt);
}

async function refreshAnthropicUsage(opts: { force?: boolean } = {}): Promise<void> {
    if (isUsageRefreshCoolingDown(usageCache.get("anthropic")?.data) || isCached("anthropic", opts)) return;
    // auth.json first, then Claude Code's own OAuth token (Keychain /
    // ~/.claude/.credentials.json) for users who never ran /login inside
    // pizzapi — read-only, never refreshed.
    const tokens = getOAuthTokens(["anthropic", "claude-subscription"]);
    const keychainToken = getAnthropicKeychainToken();
    if (keychainToken && !tokens.includes(keychainToken)) tokens.push(keychainToken);
    if (tokens.length === 0) return;
    for (const token of tokens) {
        try {
            const res = await fetchJsonWithTimeout<Record<string, unknown>>("https://api.anthropic.com/api/oauth/usage", {
                headers: {
                    Authorization: `Bearer ${token}`,
                    "anthropic-version": "2023-06-01",
                    "anthropic-beta": "oauth-2025-04-20",
                },
            });
            if (!res.ok) {
                if (res.status === 401 || res.status === 403) continue;
                const checkedAt = Date.now();
                usageCache.set("anthropic", {
                    data: preserveUsageWindowsOnError(usageCache.get("anthropic")?.data, res.status, checkedAt),
                    fetchedAt: checkedAt,
                });
                return;
            }
            const { windows, malformed } = parseAnthropicUsageWindows(res.json ?? {});
            const fetchedAt = Date.now();
            usageCache.set("anthropic", {
                data: withUsageFreshness("anthropic", malformed || windows.length === 0 ? { windows, status: "unknown" } : { windows, status: "ok" }, fetchedAt),
                fetchedAt,
            });
            return;
        } catch {
            const checkedAt = Date.now();
            usageCache.set("anthropic", { data: usageUnknown(usageCache.get("anthropic")?.data, undefined, checkedAt), fetchedAt: checkedAt });
            return;
        }
    }
    const checkedAt = Date.now();
    usageCache.set("anthropic", { data: preserveUsageWindowsOnError(usageCache.get("anthropic")?.data, 401, checkedAt), fetchedAt: checkedAt });
}

async function refreshCodexUsage(opts: { force?: boolean } = {}): Promise<void> {
    if (isUsageRefreshCoolingDown(usageCache.get("openai-codex")?.data) || isCached("openai-codex", opts)) return;
    const token = getOAuthToken("openai-codex");
    if (!token) return;
    try {
        const res = await fetchJsonWithTimeout<{
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
        }>("https://chatgpt.com/backend-api/wham/usage", {
            headers: {
                Authorization: `Bearer ${token}`,
            },
        });
        if (!res.ok) {
            const checkedAt = Date.now();
            usageCache.set("openai-codex", {
                data: preserveUsageWindowsOnError(usageCache.get("openai-codex")?.data, res.status, checkedAt),
                fetchedAt: checkedAt,
            });
            return;
        }
        const { windows, malformed } = parseCodexUsageWindows(res.json ?? {});
        const fetchedAt = Date.now();
        usageCache.set("openai-codex", {
            data: withUsageFreshness("openai-codex", malformed || windows.length === 0 ? { windows, status: "unknown" } : { windows, status: "ok" }, fetchedAt),
            fetchedAt,
        });
    } catch {
        const checkedAt = Date.now();
        usageCache.set("openai-codex", { data: usageUnknown(usageCache.get("openai-codex")?.data, undefined, checkedAt), fetchedAt: checkedAt });
    }
}

export async function refreshAllUsage(opts: { force?: boolean } = {}): Promise<void> {
    const force = opts.force === true;

    if (runnerUsageCachePath && !force) {
        await refreshFromRunnerCache();
        return;
    }

    // When running under a runner daemon, ask it to force-refresh the shared
    // cache rather than every worker hitting the provider APIs. If IPC is slow
    // or unavailable, keep the runner-owned snapshot and let quota decisions
    // treat stale/unknown data conservatively instead of fanning out provider calls.
    if (runnerUsageCachePath && force) {
        await requestRunnerUsageRefresh(12_000);
        await refreshFromRunnerCache();
        return;
    }

    await Promise.allSettled([
        refreshAnthropicUsage({ force }),
        refreshCodexUsage({ force }),
    ]);
}
