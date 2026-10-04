import type { ProviderUsageData, UsageWindow } from "./remote-types.js";

export type QuotaDecision =
    | { state: "available"; reason: "fresh"; windows: UsageWindow[] }
    | { state: "limited"; reason: "quota_exhausted"; resetAt: string; windows: UsageWindow[] }
    | { state: "unknown"; reason: "missing" | "stale" | "provider_status" | "no_active_windows" | "malformed" | "unknown_scope" | "unsupported_provider"; windows: UsageWindow[] };

export async function fetchWithTimeout(input: RequestInfo | URL, init: RequestInit = {}, timeoutMs = 10_000): Promise<Response> {
    return withTimeout(init, timeoutMs, (signal) => fetch(input, { ...init, signal }));
}

export async function fetchJsonWithTimeout<T>(input: RequestInfo | URL, init: RequestInit = {}, timeoutMs = 10_000): Promise<{ ok: boolean; status: number; json?: T }> {
    return withTimeout(init, timeoutMs, async (signal) => {
        const res = await fetch(input, { ...init, signal });
        if (!res.ok) return { ok: false, status: res.status };
        return { ok: true, status: res.status, json: (await res.json()) as T };
    });
}

async function withTimeout<T>(init: RequestInit, timeoutMs: number, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
        timeoutId = setTimeout(() => {
            controller.abort();
            reject(new DOMException("Timed out", "TimeoutError"));
        }, timeoutMs);
    });
    const onAbort = () => controller.abort(init.signal?.reason);
    if (init.signal) {
        if (init.signal.aborted) onAbort();
        else init.signal.addEventListener("abort", onAbort, { once: true });
    }
    try {
        return await Promise.race([fn(controller.signal), timeout]);
    } finally {
        if (timeoutId) clearTimeout(timeoutId);
        init.signal?.removeEventListener("abort", onAbort);
    }
}

export function usageCacheTtl(providerId: string): number {
    return providerId === "anthropic" ? 15 * 60 * 1000 : 5 * 60 * 1000;
}

export function usageExpiresAt(providerId: string, fetchedAt: number): number {
    return fetchedAt + usageCacheTtl(providerId);
}

export const USAGE_FAILURE_COOLDOWN_MS = 60_000;

export function isUsageRefreshCoolingDown(data: ProviderUsageData | undefined, now = Date.now()): boolean {
    return data?.status === "unknown" && typeof data.checkedAt === "number" && now - data.checkedAt < USAGE_FAILURE_COOLDOWN_MS;
}

export function withUsageFreshness(providerId: string, data: ProviderUsageData, fetchedAt: number): ProviderUsageData {
    return {
        ...data,
        fetchedAt: data.fetchedAt ?? fetchedAt,
        checkedAt: data.checkedAt ?? fetchedAt,
        expiresAt: data.expiresAt ?? usageExpiresAt(providerId, fetchedAt),
    };
}

export function usageUnknown(existing: ProviderUsageData | undefined, errorCode?: number, checkedAt = Date.now()): ProviderUsageData {
    return {
        windows: existing?.windows ?? [],
        status: "unknown",
        errorCode,
        fetchedAt: existing?.fetchedAt,
        checkedAt,
        expiresAt: existing?.expiresAt,
    };
}

export function activeUsageWindows(windows: UsageWindow[], now = Date.now()): UsageWindow[] {
    return windows.filter((w) => {
        const resetsAt = Date.parse(w.resets_at);
        return !Number.isFinite(resetsAt) || resetsAt > now;
    });
}

export function quotaDecisionForModel(
    usage: Record<string, ProviderUsageData | undefined>,
    providerId: string,
    modelId: string,
    now = Date.now(),
): QuotaDecision {
    const usageKey = providerId === "claude-subscription" ? "anthropic" : providerId;
    const data = usage[usageKey];
    if (!data) return { state: "unknown", reason: "missing", windows: [] };

    const relevant = relevantWindows(usageKey, data.windows, modelId);
    const windows = activeUsageWindows(relevant, now);
    if (relevant.some((w) => !isValidUsageWindow(w))) return { state: "unknown", reason: "malformed", windows };
    if (data.status !== "ok") return { state: "unknown", reason: "provider_status", windows };
    if (typeof data.expiresAt !== "number" || !Number.isFinite(data.expiresAt) || data.expiresAt <= now) {
        return { state: "unknown", reason: "stale", windows };
    }

    const expiredExhausted = relevant.some((w) => w.utilization >= 100 && Date.parse(w.resets_at) <= now);
    if (expiredExhausted) return { state: "unknown", reason: "stale", windows };
    if (windows.length === 0) return { state: "unknown", reason: "no_active_windows", windows };
    if (windows.some((w) => w.scope === "unknown" && w.utilization >= 100)) {
        return { state: "unknown", reason: "unknown_scope", windows };
    }

    const exhausted = windows.filter((w) => w.utilization >= 100 && w.scope !== "unknown");
    if (exhausted.length > 0) {
        return { state: "limited", reason: "quota_exhausted", resetAt: latestReset(exhausted), windows };
    }
    return { state: "available", reason: "fresh", windows };
}

function relevantWindows(providerId: string, windows: UsageWindow[], modelId: string): UsageWindow[] {
    if (providerId !== "anthropic") return windows;
    const model = modelId.toLowerCase();
    if (model.includes("opus")) return windows.filter((w) => isAnthropicGlobalWindow(w) || isUnknownScope(w) || /opus/i.test(w.label));
    if (model.includes("sonnet")) return windows.filter((w) => isAnthropicGlobalWindow(w) || isUnknownScope(w) || /sonnet/i.test(w.label));
    return windows.filter((w) => isAnthropicGlobalWindow(w) || isUnknownScope(w));
}

function isAnthropicGlobalWindow(w: UsageWindow): boolean {
    return /^(5-hour|7-day)$/i.test(w.label);
}

function isUnknownScope(w: UsageWindow): boolean {
    return w.scope === "unknown";
}

function isValidUsageWindow(w: UsageWindow): boolean {
    return typeof w.label === "string" && Number.isFinite(w.utilization) && Number.isFinite(Date.parse(w.resets_at));
}

export function parseAnthropicUsageWindows(raw: Record<string, unknown>): { windows: UsageWindow[]; malformed: boolean } {
    const labels: Record<string, string> = {
        five_hour: "5-hour",
        seven_day: "7-day",
        seven_day_opus: "7-day (Opus)",
        seven_day_sonnet: "7-day (Sonnet)",
        seven_day_oauth_apps: "7-day (OAuth apps)",
        seven_day_cowork: "7-day (co-work)",
    };
    const windows: UsageWindow[] = [];
    let malformed = false;
    for (const [key, label] of Object.entries(labels)) {
        const w = raw[key];
        if (w == null) continue;
        if (typeof w !== "object") { malformed = true; continue; }
        const record = w as Record<string, unknown>;
        if (record.utilization === 0 && record.resets_at == null) continue;
        if (typeof record.utilization !== "number" || typeof record.resets_at !== "string" || !Number.isFinite(Date.parse(record.resets_at))) {
            malformed = true;
            continue;
        }
        windows.push({
            label,
            utilization: record.utilization,
            resets_at: record.resets_at,
            scope: key === "seven_day_oauth_apps" || key === "seven_day_cowork" ? "unknown" : undefined,
        });
    }
    return { windows, malformed };
}

type CodexWindow =
    | { used_percent?: unknown; window_minutes?: unknown; resets_at?: unknown }
    | { used_percent?: unknown; limit_window_seconds?: unknown; reset_at?: unknown };

export function parseCodexUsageWindows(raw: {
    rate_limit?: {
        primary?: CodexWindow | null;
        secondary?: CodexWindow | null;
        primary_window?: CodexWindow | null;
        secondary_window?: CodexWindow | null;
    } | null;
    additional_rate_limits?: Array<{
        limit_name?: unknown;
        metered_feature?: unknown;
        rate_limit?: { primary?: CodexWindow | null; primary_window?: CodexWindow | null } | null;
    }> | null;
}): { windows: UsageWindow[]; malformed: boolean } {
    function windowLabel(minutes: number | null | undefined): string {
        if (!minutes) return "Usage";
        if (minutes < 60) return `${minutes}-min`;
        if (minutes < 60 * 24) return `${Math.round(minutes / 60)}-hour`;
        return `${Math.round(minutes / 60 / 24)}-day`;
    }

    let malformed = false;
    function toWindow(w: CodexWindow | null | undefined, label: string): UsageWindow | null {
        if (!w) return null;
        const used = typeof w.used_percent === "number" ? w.used_percent : null;
        const resetAt = "resets_at" in w ? w.resets_at : "reset_at" in w ? w.reset_at : null;
        if (used === 0 && resetAt == null) return null;
        if (used == null || typeof resetAt !== "number" || !Number.isFinite(resetAt)) {
            malformed = true;
            return null;
        }
        const minutes = "window_minutes" in w && typeof w.window_minutes === "number"
            ? w.window_minutes
            : "limit_window_seconds" in w && typeof w.limit_window_seconds === "number"
              ? Math.max(1, Math.round(w.limit_window_seconds / 60))
              : undefined;
        return { label: minutes ? windowLabel(minutes) : label, utilization: used, resets_at: new Date(resetAt * 1000).toISOString() };
    }

    const windows: UsageWindow[] = [];
    const primary = toWindow(raw.rate_limit?.primary_window ?? raw.rate_limit?.primary, "Primary");
    if (primary) windows.push(primary);
    const secondary = toWindow(raw.rate_limit?.secondary_window ?? raw.rate_limit?.secondary, "Secondary");
    if (secondary) windows.push(secondary);
    for (const extra of raw.additional_rate_limits ?? []) {
        const name = typeof extra.limit_name === "string" && extra.limit_name ? extra.limit_name : "Additional";
        const w = toWindow(extra.rate_limit?.primary_window ?? extra.rate_limit?.primary, name);
        if (w) {
            w.label = name;
            w.scope = "unknown";
            if (typeof extra.metered_feature === "string") w.meteredFeature = extra.metered_feature;
            windows.push(w);
        }
    }
    return { windows, malformed };
}

function latestReset(windows: UsageWindow[]): string {
    let best = windows[0]?.resets_at ?? new Date(0).toISOString();
    let bestTime = Date.parse(best);
    for (const w of windows.slice(1)) {
        const time = Date.parse(w.resets_at);
        if (time > bestTime) {
            best = w.resets_at;
            bestTime = time;
        }
    }
    return best;
}
