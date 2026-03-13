/**
 * Model Discovery Extension — fetches available models from provider APIs
 * and registers any that are missing from the built-in registry.
 *
 * Discovered models are registered under synthetic provider names
 * (e.g., "openai-discovered") to avoid replacing curated built-in models.
 */
import type { ExtensionFactory } from "@mariozechner/pi-coding-agent";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";

import {
    fetchOpenAIModels,
    fetchAnthropicModels,
    type DiscoveredModel,
} from "./model-discovery-providers.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface DiscoveryCache {
    timestamp: number;
    providers: Record<string, DiscoveredModel[]>;
}

export interface DiscoverOptions {
    provider: string;
    baseUrl: string;
    apiKey: string;
    existingModelIds: Set<string>;
}

// ── Constants ────────────────────────────────────────────────────────────────

export const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

const CACHE_FILENAME = "discovered-models-cache.json";

type FetchFn = (baseUrl: string, apiKey: string) => Promise<DiscoveredModel[]>;

const PROVIDER_FETCHERS: Record<string, { fetch: FetchFn; api: string }> = {
    openai: { fetch: fetchOpenAIModels, api: "openai-responses" },
    "openai-codex": { fetch: fetchOpenAIModels, api: "openai-responses" },
    anthropic: { fetch: fetchAnthropicModels, api: "anthropic-messages" },
};

// ── Cache helpers ────────────────────────────────────────────────────────────

export function readCache(cachePath: string): DiscoveryCache | null {
    try {
        if (!existsSync(cachePath)) return null;
        const raw = readFileSync(cachePath, "utf-8");
        const cache = JSON.parse(raw) as DiscoveryCache;
        if (typeof cache.timestamp !== "number" || !cache.providers) return null;
        if (Date.now() - cache.timestamp > CACHE_TTL_MS) return null;
        return cache;
    } catch {
        return null;
    }
}

export function writeCache(cachePath: string, cache: DiscoveryCache): void {
    try {
        mkdirSync(dirname(cachePath), { recursive: true });
        writeFileSync(cachePath, JSON.stringify(cache));
    } catch {
        // Non-fatal — discovery still works without caching
    }
}

// ── Discovery logic ──────────────────────────────────────────────────────────

export async function discoverNewModels(opts: DiscoverOptions): Promise<DiscoveredModel[]> {
    const fetcher = PROVIDER_FETCHERS[opts.provider];
    if (!fetcher) return [];

    const models = await fetcher.fetch(opts.baseUrl, opts.apiKey);
    return models.filter((m) => !opts.existingModelIds.has(m.id));
}

// ── Default model properties for discovered models ───────────────────────────

const DEFAULT_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

function buildModelDefs(models: DiscoveredModel[]) {
    return models.map((m) => ({
        id: m.id,
        name: m.name,
        reasoning: false,
        input: ["text" as const, "image" as const],
        cost: DEFAULT_COST,
        contextWindow: 128_000,
        maxTokens: 16_384,
    }));
}

// ── Extension factory ────────────────────────────────────────────────────────

export const modelDiscoveryExtension: ExtensionFactory = (pi) => {
    let fired = false;

    pi.on("session_start", async (_event, ctx) => {
        if (fired) return;
        fired = true;

        const cachePath = join(homedir(), ".pizzapi", CACHE_FILENAME);
        const cache = readCache(cachePath);
        const allModels = ctx.modelRegistry.getAll();
        const existingIds = new Set(allModels.map((m) => m.id));
        const newCache: DiscoveryCache = { timestamp: Date.now(), providers: {} };

        // Collect unique providers that have a known fetcher
        const providerBaseUrls = new Map<string, string>();
        for (const model of allModels) {
            if (PROVIDER_FETCHERS[model.provider] && !providerBaseUrls.has(model.provider)) {
                providerBaseUrls.set(model.provider, model.baseUrl ?? "");
            }
        }

        for (const [provider, baseUrl] of providerBaseUrls) {
            if (!baseUrl) continue;

            const apiKey = await ctx.modelRegistry.getApiKeyForProvider(provider);
            if (!apiKey) continue;

            let newModels: DiscoveredModel[];
            if (cache?.providers[provider]) {
                // Use cached discovery, still filter against current registry
                newModels = cache.providers[provider].filter((m) => !existingIds.has(m.id));
                newCache.providers[provider] = cache.providers[provider];
            } else {
                newModels = await discoverNewModels({ provider, baseUrl, apiKey, existingModelIds: existingIds });
                // Store ALL fetched models in cache (before filtering)
                const allFetched = await PROVIDER_FETCHERS[provider].fetch(baseUrl, apiKey);
                newCache.providers[provider] = allFetched;
            }

            if (newModels.length === 0) continue;

            const fetcher = PROVIDER_FETCHERS[provider];

            // Use the real provider name — the patched ModelRegistry merges
            // additively rather than replacing, and falls back to the existing
            // model's baseUrl so we don't need to repeat it here.
            pi.registerProvider(provider, {
                apiKey,
                api: fetcher.api,
                models: buildModelDefs(newModels),
            });
        }

        writeCache(cachePath, newCache);
    });
};
