import type { Model } from "@earendil-works/pi-ai";
import type { ProviderUsageData } from "./remote-types.js";
import { quotaDecisionForModel, type QuotaDecision } from "./provider-quota.js";
import { getUsageKey } from "./format-usage.js";

export type QuotaWaitStatus = QuotaDecision;

export interface QuotaWaitDeps {
    now?: () => number;
    sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

const DEFAULT_RESET_SLOP_MS = 1000;
const MAX_RESET_WAITS = 3;

export function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.reject(new DOMException("Aborted", "AbortError"));
    return new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, ms);
        signal.addEventListener(
            "abort",
            () => {
                clearTimeout(timer);
                reject(new DOMException("Aborted", "AbortError"));
            },
            { once: true },
        );
    });
}

function modelUsageData(
    model: Pick<Model<any>, "provider" | "id"> | undefined,
    usage: Record<string, ProviderUsageData | undefined>,
): ProviderUsageData | undefined {
    if (!model) return undefined;
    const usageKey = getUsageKey(model.provider) ?? model.provider;
    return usage[usageKey] ?? usage[model.provider];
}

export function currentQuotaStatus(
    model: Pick<Model<any>, "provider" | "id"> | undefined,
    usage: Record<string, ProviderUsageData | undefined>,
    now = Date.now(),
    minFetchedAt?: number,
): QuotaDecision {
    if (!model) return { state: "unknown", reason: "missing", windows: [] };
    const decision = quotaDecisionForModel(usage, model.provider, model.id, now);
    if (decision.state !== "unknown" && minFetchedAt !== undefined) {
        const data = modelUsageData(model, usage);
        if (typeof data?.fetchedAt !== "number" || data.fetchedAt < minFetchedAt) {
            return { state: "unknown", reason: "stale", windows: decision.windows };
        }
    }
    return decision;
}

async function refreshUnlessAborted(refresh: (opts: { force: true }) => Promise<void>, signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    let onAbort!: () => void;
    const aborted = new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(new DOMException("Aborted", "AbortError"));
        signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
        // The runner refresh may serve other sessions; abandon this wait, not their request.
        await Promise.race([refresh({ force: true }), aborted]);
    } finally {
        signal.removeEventListener("abort", onAbort);
    }
}

export async function waitForQuotaReturn(
    model: Pick<Model<any>, "provider" | "id"> | undefined,
    refreshUsage: (opts: { force: true }) => Promise<void>,
    readUsage: () => Record<string, ProviderUsageData | undefined>,
    signal: AbortSignal,
    deps: QuotaWaitDeps = {},
): Promise<QuotaDecision> {
    const now = deps.now ?? Date.now;
    const sleep = deps.sleep ?? defaultSleep;

    const firstRefreshStartedAt = now();
    await refreshUnlessAborted(refreshUsage, signal);
    const first = currentQuotaStatus(model, readUsage(), now(), firstRefreshStartedAt);
    if (first.state !== "limited") {
        return first.state === "available"
            ? { state: "unknown", reason: "unsupported_provider", windows: first.windows }
            : first;
    }

    let result: QuotaDecision = first;
    for (let attempt = 0; attempt < MAX_RESET_WAITS && result.state === "limited"; attempt++) {
        const resetAt = Date.parse(result.resetAt);
        if (!Number.isFinite(resetAt)) return { state: "unknown", reason: "malformed", windows: result.windows };
        await sleep(Math.max(0, resetAt - now() + DEFAULT_RESET_SLOP_MS), signal);
        const refreshStartedAt = now();
        await refreshUnlessAborted(refreshUsage, signal);
        result = currentQuotaStatus(model, readUsage(), now(), refreshStartedAt);
    }
    return result;
}
