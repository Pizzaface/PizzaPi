import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readStoredCredential } from "@earendil-works/pi-coding-agent";
import { loadConfig, defaultAgentDir, expandHome } from "../config.js";
import { getOAuthAccessToken, getAnthropicKeychainToken } from "./usage-auth.js";
import { fetchJsonWithTimeout, isUsageRefreshCoolingDown, parseAnthropicUsageWindows, parseCodexUsageWindows, usageUnknown, withUsageFreshness } from "../extensions/provider-quota.js";
import { logInfo, logWarn } from "./logger.js";

// ── Runner-wide usage cache (shared with worker processes via file) ───────────
//
// The runner daemon is the single source of truth for provider quota data on
// a given machine.  All worker sessions inherit PIZZAPI_RUNNER_USAGE_CACHE_PATH
// and read from this file instead of each making their own API calls.

interface UsageWindow { label: string; utilization: number; resets_at: string; scope?: "global" | "unknown"; meteredFeature?: string }
interface ProviderUsageData {
    windows: UsageWindow[];
    status?: "ok" | "unknown";
    errorCode?: number;
    fetchedAt?: number;
    checkedAt?: number;
    expiresAt?: number;
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

function readRunnerUsageCacheFile(): RunnerUsageCacheFile | null {
    try {
        return JSON.parse(readFileSync(runnerUsageCacheFilePath(), "utf-8")) as RunnerUsageCacheFile;
    } catch {
        return null;
    }
}

/**
 * Returns all unique auth.json paths known to the daemon:
 * the daemon's own startup CWD first, followed by any CWD registered by active
 * worker sessions that maps to a different auth.json (e.g. a project-specific
 * agentDir override). Deduplicated so the same file is never probed twice.
 *
 * Usage fetch functions iterate this list and use the first path that
 * yields valid credentials, ensuring that sessions spawned in projects with
 * their own agentDir overrides are covered even when the daemon was started
 * from a different directory.
 */
function getKnownAuthPaths(): string[] {
    const seen = new Set<string>();
    const cwds = [process.cwd(), ..._activeSessionCwds.keys()];
    for (const cwd of cwds) {
        const config = loadConfig(cwd);
        const agentDir = config.agentDir ? expandHome(config.agentDir) : defaultAgentDir();
        seen.add(join(agentDir, "auth.json"));
    }
    return [...seen];
}

async function fetchAnthropicUsageData(existing?: ProviderUsageData | null): Promise<ProviderUsageData | null> {
    if (isUsageRefreshCoolingDown(existing ?? undefined)) return existing ?? null;
    const tokens: string[] = [];
    try {
        for (const authPath of getKnownAuthPaths()) {
            for (const provider of ["anthropic", "claude-subscription"]) {
                const token = getOAuthAccessToken(readStoredCredential(provider, authPath));
                if (token && !tokens.includes(token)) tokens.push(token);
            }
        }
        const keychainToken = getAnthropicKeychainToken();
        if (keychainToken && !tokens.includes(keychainToken)) tokens.push(keychainToken);
    } catch (err: any) {
        logWarn(`failed to get Anthropic credentials: ${err?.message ?? String(err)}`);
        return usageUnknown(existing ?? undefined);
    }
    if (tokens.length === 0) return null;

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
                return usageUnknown(existing ?? undefined, res.status);
            }
            const { windows, malformed } = parseAnthropicUsageWindows(res.json ?? {});
            return malformed || windows.length === 0 ? { windows, status: "unknown" } : { windows, status: "ok" };
        } catch (err: any) {
            logWarn(`failed to fetch Anthropic usage: ${err?.message ?? String(err)}`);
            return usageUnknown(existing ?? undefined);
        }
    }
    return usageUnknown(existing ?? undefined, 401);
}

export async function getRunnerAnthropicUsageData(opts: { force?: boolean } = {}): Promise<ProviderUsageData | null> {
    if (!_lastAnthropicUsage) {
        try {
            const cached = JSON.parse(readFileSync(runnerUsageCacheFilePath(), "utf-8")) as RunnerUsageCacheFile;
            const anthropic = cached.providers?.anthropic;
            if (anthropic?.windows) {
                const fetchedAt = typeof anthropic.fetchedAt === "number" ? anthropic.fetchedAt : cached.fetchedAt;
                _lastAnthropicUsage = { data: withUsageFreshness("anthropic", anthropic, fetchedAt), fetchedAt };
            }
        } catch {
            // No prior runner cache.
        }
    }

    const now = Date.now();
    const force = opts.force === true;

    if (!force && _lastAnthropicUsage?.data?.status === "ok" && now - _lastAnthropicUsage.fetchedAt < ANTHROPIC_USAGE_REFRESH_INTERVAL) {
        return _lastAnthropicUsage.data;
    }

    const data = await fetchAnthropicUsageData(_lastAnthropicUsage?.data ?? null);
    if (data !== null) {
        const completedAt = Date.now();
        const fresh = withUsageFreshness("anthropic", data, data.status === "ok" ? completedAt : _lastAnthropicUsage?.fetchedAt ?? completedAt);
        _lastAnthropicUsage = { data: fresh, fetchedAt: fresh.fetchedAt ?? completedAt };
        return fresh;
    }
    return null;
}

async function fetchCodexUsageData(existing?: ProviderUsageData): Promise<ProviderUsageData | null> {
    if (isUsageRefreshCoolingDown(existing)) return existing ?? null;
    let token: string | null = null;
    try {
        for (const authPath of getKnownAuthPaths()) {
            token = getOAuthAccessToken(readStoredCredential("openai-codex", authPath));
            if (token) break;
        }
    } catch (err: any) {
        logWarn(`failed to get OpenAI Codex credentials: ${err?.message ?? String(err)}`);
        return usageUnknown(existing);
    }
    if (!token) return null;
    try {
        const res = await fetchJsonWithTimeout<Record<string, unknown>>("https://chatgpt.com/backend-api/wham/usage", {
            headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) return usageUnknown(existing, res.status);
        const { windows, malformed } = parseCodexUsageWindows(res.json ?? {});
        return malformed || windows.length === 0 ? { windows, status: "unknown" } : { windows, status: "ok" };
    } catch (err: any) {
        logWarn(`failed to fetch OpenAI Codex usage: ${err?.message ?? String(err)}`);
        return usageUnknown(existing);
    }
}

/**
 * Fetch usage from all configured providers and write the result to the shared
 * cache file so every worker on this runner node can read it without making
 * their own API calls.
 */
/**
 * Coalesce concurrent invocations of an async fn into one in-flight promise.
 * Prevents an interval tick from overlapping a slow previous fetch and
 * publishing results out of order (older data overwriting newer).
 */
export function singleFlight<A extends unknown[]>(fn: (...args: A) => Promise<void>): (...args: A) => Promise<void> {
    let inflight: Promise<void> | null = null;
    return (...args: A) => {
        if (inflight) return inflight;
        inflight = fn(...args).finally(() => {
            inflight = null;
        });
        return inflight;
    };
}

export const refreshAndWriteRunnerUsageCache = singleFlight(doRefreshAndWriteRunnerUsageCache);

async function doRefreshAndWriteRunnerUsageCache(opts: { forceAnthropic?: boolean } = {}): Promise<void> {
    const existing = readRunnerUsageCacheFile()?.providers ?? {};
    const [anthropicResult, codexResult] = await Promise.allSettled([
        getRunnerAnthropicUsageData({ force: opts.forceAnthropic === true }),
        fetchCodexUsageData(existing["openai-codex"]),
    ]);

    const providers: Record<string, ProviderUsageData> = { ...existing };
    if (anthropicResult.status === "fulfilled" && anthropicResult.value) {
        const fetchedAt = anthropicResult.value.fetchedAt ?? Date.now();
        providers.anthropic = withUsageFreshness("anthropic", anthropicResult.value, fetchedAt);
    }
    if (codexResult.status === "fulfilled" && codexResult.value) {
        providers["openai-codex"] = withUsageFreshness("openai-codex", codexResult.value, Date.now());
    }

    if (Object.keys(providers).length === 0) return; // No credentials available — skip write

    const cache: RunnerUsageCacheFile = { fetchedAt: Date.now(), providers };
    try {
        await writeUsageCacheAtomic(runnerUsageCacheFilePath(), JSON.stringify(cache, null, 2));
        logInfo(`usage cache refreshed (${Object.keys(providers).join(", ")})`);
    } catch (err: any) {
        logWarn(`failed to write usage cache: ${err?.message ?? String(err)}`);
    }
}

/**
 * Write the cache via temp-file + rename so workers never observe a
 * truncated/partial JSON file mid-write. On Windows the rename can fail
 * transiently (EPERM/EACCES/EBUSY) while a worker holds the destination open
 * for reading — retry briefly, then fall back to a direct write rather than
 * dropping the refresh entirely.
 */
async function writeUsageCacheAtomic(path: string, contents: string): Promise<void> {
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, contents, { encoding: "utf-8", mode: 0o600 });
    for (let attempt = 0; attempt < 5; attempt++) {
        try {
            renameSync(tmp, path);
            return;
        } catch (err: any) {
            const code = err?.code;
            if (code !== "EPERM" && code !== "EACCES" && code !== "EBUSY") {
                rmSync(tmp, { force: true });
                throw err;
            }
            await new Promise((r) => setTimeout(r, 50 * (attempt + 1)));
        }
    }
    writeFileSync(path, contents, { encoding: "utf-8", mode: 0o600 });
    rmSync(tmp, { force: true });
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
