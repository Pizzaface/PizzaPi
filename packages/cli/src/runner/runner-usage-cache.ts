import { writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { AuthStorage } from "@mariozechner/pi-coding-agent";
import { loadConfig, defaultAgentDir, expandHome } from "../config.js";
import { getRefreshedOAuthToken, parseGeminiQuotaCredential } from "./usage-auth.js";
import { logInfo, logWarn } from "./logger.js";

// ── Runner-wide usage cache (shared with worker processes via file) ───────────
//
// The runner daemon is the single source of truth for provider quota data on
// a given machine.  All worker sessions inherit PIZZAPI_RUNNER_USAGE_CACHE_PATH
// and read from this file instead of each making their own API calls.

interface UsageWindow { label: string; utilization: number; resets_at: string }
interface ProviderUsageData {
    windows: UsageWindow[];
    status?: "ok" | "unknown";
    errorCode?: number;
}
interface RunnerUsageCacheFile {
    fetchedAt: number;
    providers: Record<string, ProviderUsageData>;
}

/** Runner cache write cadence for provider usage snapshots. */
const RUNNER_USAGE_REFRESH_INTERVAL = 5 * 60 * 1000;
/** Anthropic usage changes slowly; poll less frequently by default. */
const ANTHROPIC_USAGE_REFRESH_INTERVAL = 15 * 60 * 1000;

let _usageRefreshTimer: ReturnType<typeof setInterval> | null = null;
let _lastAnthropicUsage: { data: ProviderUsageData | null; fetchedAt: number } | null = null;

/**
 * Tracks CWDs of active worker sessions so usage fetches can probe
 * project-local agentDir overrides when the daemon runs from a different directory.
 * Map: cwd → set of sessionIds using that cwd.
 */
const _activeSessionCwds = new Map<string, Set<string>>();

export function trackSessionCwd(sessionId: string, cwd: string): void {
    if (!_activeSessionCwds.has(cwd)) _activeSessionCwds.set(cwd, new Set());
    _activeSessionCwds.get(cwd)!.add(sessionId);
}

export function untrackSessionCwd(sessionId: string, cwd: string): void {
    const sessions = _activeSessionCwds.get(cwd);
    if (!sessions) return;
    sessions.delete(sessionId);
    if (sessions.size === 0) _activeSessionCwds.delete(cwd);
}

export function runnerUsageCacheFilePath(): string {
    return join(homedir(), ".pizzapi", "usage-cache.json");
}

/**
 * Returns all unique AuthStorage instances known to the daemon:
 * the daemon's own startup CWD first, followed by any CWD registered by active
 * worker sessions that maps to a different auth.json (e.g. a project-specific
 * agentDir override).  Results are deduplicated by resolved auth.json path so
 * the same file is never probed twice.
 *
 * Usage fetch functions iterate this list and use the first storage that
 * yields valid credentials, ensuring that sessions spawned in projects with
 * their own agentDir overrides are covered even when the daemon was started
 * from a different directory.
 */
function getKnownAuthStorages(): AuthStorage[] {
    const seen = new Set<string>();
    const result: AuthStorage[] = [];
    const cwds = [process.cwd(), ..._activeSessionCwds.keys()];
    for (const cwd of cwds) {
        const config = loadConfig(cwd);
        const agentDir = config.agentDir ? expandHome(config.agentDir) : defaultAgentDir();
        const authPath = join(agentDir, "auth.json");
        if (!seen.has(authPath)) {
            seen.add(authPath);
            result.push(AuthStorage.create(authPath));
        }
    }
    return result;
}

async function fetchAnthropicUsageData(): Promise<ProviderUsageData | null> {
    let token: string | null = null;
    try {
        for (const authStorage of getKnownAuthStorages()) {
            token = await getRefreshedOAuthToken(authStorage, "anthropic");
            if (token) break;
        }
    } catch (err: any) {
        logWarn(`failed to get Anthropic credentials: ${err?.message ?? String(err)}`);
        return null;
    }
    if (!token) return null;
    try {
        const res = await fetch("https://api.anthropic.com/api/oauth/usage", {
            headers: {
                Authorization: `Bearer ${token}`,
                "anthropic-version": "2023-06-01",
                "anthropic-beta": "oauth-2025-04-20",
            },
        });
        if (!res.ok) {
            if (res.status === 403) return { windows: [], status: "unknown", errorCode: 403 };
            return null;
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
        return windows.length > 0 ? { windows, status: "ok" } : null;
    } catch {
        return null;
    }
}

async function getRunnerAnthropicUsageData(opts: { force?: boolean } = {}): Promise<ProviderUsageData | null> {
    const now = Date.now();
    const force = opts.force === true;

    if (!force && _lastAnthropicUsage && now - _lastAnthropicUsage.fetchedAt < ANTHROPIC_USAGE_REFRESH_INTERVAL) {
        return _lastAnthropicUsage.data;
    }

    const data = await fetchAnthropicUsageData();
    // Only cache successful fetches so transient failures don't suppress
    // retries for the full 15-minute interval.
    if (data !== null) {
        _lastAnthropicUsage = { data, fetchedAt: now };
    }
    return data;
}

async function fetchGeminiUsageData(): Promise<ProviderUsageData | null> {
    let token: string | undefined;
    let projectId: string | undefined;
    try {
        for (const authStorage of getKnownAuthStorages()) {
            // AuthStorage.getApiKey handles OAuth token refresh and returns
            // JSON.stringify({ token, projectId }) via the provider's getApiKey().
            // Use parseGeminiQuotaCredential to validate the result — API-key
            // credentials return a plain string that fails JSON.parse, so we
            // must not short-circuit on the first truthy raw value; we need to
            // confirm it is a valid OAuth Gemini credential before stopping.
            const raw = await authStorage.getApiKey("google-gemini-cli");
            const cred = parseGeminiQuotaCredential(raw);
            if (cred) {
                token = cred.token;
                projectId = cred.projectId;
                break;
            }
        }
    } catch (err: any) {
        logWarn(`failed to get Google credentials: ${err?.message ?? String(err)}`);
        return null;
    }
    if (!token || !projectId) return null;
    try {
        const endpoint = process.env["CODE_ASSIST_ENDPOINT"] ?? "https://cloudcode-pa.googleapis.com";
        const version = process.env["CODE_ASSIST_API_VERSION"] ?? "v1internal";
        const res = await fetch(`${endpoint}/${version}:retrieveUserQuota`, {
            method: "POST",
            headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
            body: JSON.stringify({ project: projectId }),
        });
        if (!res.ok) {
            if (res.status === 403) return { windows: [], status: "unknown", errorCode: 403 };
            return null;
        }
        const raw = (await res.json()) as {
            buckets?: Array<{ remainingFraction?: number; resetTime?: string; tokenType?: string; modelId?: string }>;
        };
        const windows: UsageWindow[] = [];
        for (const bucket of raw.buckets ?? []) {
            if (bucket.remainingFraction == null || !bucket.resetTime) continue;
            const utilization = (1 - bucket.remainingFraction) * 100;
            const label = [bucket.tokenType, bucket.modelId].filter(Boolean).join(" / ") || "Quota";
            windows.push({ label, utilization, resets_at: bucket.resetTime });
        }
        return windows.length > 0 ? { windows, status: "ok" } : null;
    } catch {
        return null;
    }
}

async function fetchCodexUsageData(): Promise<ProviderUsageData | null> {
    let token: string | null = null;
    try {
        for (const authStorage of getKnownAuthStorages()) {
            token = await getRefreshedOAuthToken(authStorage, "openai-codex");
            if (token) break;
        }
    } catch (err: any) {
        logWarn(`failed to get OpenAI Codex credentials: ${err?.message ?? String(err)}`);
        return null;
    }
    if (!token) return null;
    try {
        const res = await fetch("https://chatgpt.com/backend-api/wham/usage", {
            headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) {
            if (res.status === 403) return { windows: [], status: "unknown", errorCode: 403 };
            return null;
        }
        const raw = (await res.json()) as any;

        function windowLabel(minutes: number | null | undefined): string {
            if (!minutes) return "Usage";
            if (minutes < 60) return `${minutes}-min`;
            if (minutes < 60 * 24) return `${Math.round(minutes / 60)}-hour`;
            return `${Math.round(minutes / 60 / 24)}-day`;
        }
        function toWin(w: any, label: string): UsageWindow | null {
            if (!w) return null;
            const used = typeof w.used_percent === "number" ? w.used_percent : null;
            const resetAt = "resets_at" in w ? w.resets_at : "reset_at" in w ? w.reset_at : null;
            if (used == null || resetAt == null) return null;
            const minutes = "window_minutes" in w
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
        const primary = toWin(raw.rate_limit?.primary_window ?? raw.rate_limit?.primary, "Primary");
        if (primary) windows.push(primary);
        const secondary = toWin(raw.rate_limit?.secondary_window ?? raw.rate_limit?.secondary, "Secondary");
        if (secondary) windows.push(secondary);
        for (const extra of raw.additional_rate_limits ?? []) {
            const w = toWin(extra.rate_limit?.primary_window ?? extra.rate_limit?.primary, extra.limit_name);
            if (w) { w.label = extra.limit_name; windows.push(w); }
        }
        return windows.length > 0 ? { windows, status: "ok" } : null;
    } catch {
        return null;
    }
}

/**
 * Fetch usage from all configured providers and write the result to the shared
 * cache file so every worker on this runner node can read it without making
 * their own API calls.
 */
async function refreshAndWriteRunnerUsageCache(opts: { forceAnthropic?: boolean } = {}): Promise<void> {
    const [anthropicResult, geminiResult, codexResult] = await Promise.allSettled([
        getRunnerAnthropicUsageData({ force: opts.forceAnthropic === true }),
        fetchGeminiUsageData(),
        fetchCodexUsageData(),
    ]);

    const providers: Record<string, ProviderUsageData> = {};
    if (anthropicResult.status === "fulfilled" && anthropicResult.value) {
        providers.anthropic = anthropicResult.value;
    }
    if (geminiResult.status === "fulfilled" && geminiResult.value) {
        providers["google-gemini-cli"] = geminiResult.value;
    }
    if (codexResult.status === "fulfilled" && codexResult.value) {
        providers["openai-codex"] = codexResult.value;
    }

    if (Object.keys(providers).length === 0) return; // No credentials available — skip write

    const cache: RunnerUsageCacheFile = { fetchedAt: Date.now(), providers };
    try {
        writeFileSync(runnerUsageCacheFilePath(), JSON.stringify(cache, null, 2), { encoding: "utf-8", mode: 0o600 });
        logInfo(`usage cache refreshed (${Object.keys(providers).join(", ")})`);
    } catch (err: any) {
        logWarn(`failed to write usage cache: ${err?.message ?? String(err)}`);
    }
}

export function startUsageRefreshLoop(): void {
    if (_usageRefreshTimer !== null) return;
    // Kick off an immediate fetch so workers spawned right after startup have data.
    void refreshAndWriteRunnerUsageCache();
    _usageRefreshTimer = setInterval(() => {
        void refreshAndWriteRunnerUsageCache();
    }, RUNNER_USAGE_REFRESH_INTERVAL);
}

export function stopUsageRefreshLoop(): void {
    if (_usageRefreshTimer !== null) {
        clearInterval(_usageRefreshTimer);
        _usageRefreshTimer = null;
    }
}
