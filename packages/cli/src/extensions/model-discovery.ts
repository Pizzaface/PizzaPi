/**
 * Model Discovery Extension — fetches available models from provider APIs
 * and registers any that are missing from the built-in registry.
 *
 * Built-in providers (openai, anthropic) are scanned for new models and
 * registered additively under their real provider name.
 *
 * External providers are configured via env vars:
 *   PIZZAPI_OLLAMA_URL  — e.g. http://192.168.42.145:11434
 */
import type { ExtensionFactory } from "@mariozechner/pi-coding-agent";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";

import {
    fetchOpenAIModels,
    fetchAnthropicModels,
    fetchOllamaModels,
    fetchZAIModels,
    zaiJwtToken,
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

        // ── Built-in providers (openai, anthropic, etc.) ──────────────────────
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
                newModels = cache.providers[provider].filter((m) => !existingIds.has(m.id));
                newCache.providers[provider] = cache.providers[provider];
            } else {
                newModels = await discoverNewModels({ provider, baseUrl, apiKey, existingModelIds: existingIds });
                const allFetched = await PROVIDER_FETCHERS[provider].fetch(baseUrl, apiKey);
                newCache.providers[provider] = allFetched;
            }

            if (newModels.length === 0) continue;

            pi.registerProvider(provider, {
                apiKey,
                api: PROVIDER_FETCHERS[provider].api,
                models: buildModelDefs(newModels),
            });
        }

        // ── Ollama (PIZZAPI_OLLAMA_URL) ───────────────────────────────────────
        const ollamaUrl = process.env.PIZZAPI_OLLAMA_URL;
        if (ollamaUrl) {
            let ollamaModels: DiscoveredModel[];
            if (cache?.providers["ollama"]) {
                ollamaModels = cache.providers["ollama"];
                newCache.providers["ollama"] = ollamaModels;
            } else {
                ollamaModels = await fetchOllamaModels(ollamaUrl);
                newCache.providers["ollama"] = ollamaModels;
            }

            if (ollamaModels.length > 0) {
                pi.registerProvider("ollama", {
                    baseUrl: ollamaUrl,
                    apiKey: "ollama",
                    api: "openai-completions",
                    models: buildModelDefs(ollamaModels),
                });
            }
        }

        // ── zAI / Zhipu AI (ZAI_API_KEY) ─────────────────────────────────────
        // zAI requires JWT auth (HS256 signed from key "<id>.<secret>").
        // We generate a 1-hour token at session start and pass it as a
        // static Authorization header so the OpenAI-compatible layer works.
        const zaiKey = process.env.ZAI_API_KEY;
        if (zaiKey) {
            const zaiBaseUrl = "https://api.z.ai/api/paas";
            let zaiModels: DiscoveredModel[];
            if (cache?.providers["zai"]) {
                zaiModels = cache.providers["zai"];
                newCache.providers["zai"] = zaiModels;
            } else {
                zaiModels = await fetchZAIModels(zaiBaseUrl, zaiKey);
                newCache.providers["zai"] = zaiModels;
            }

            if (zaiModels.length > 0) {
                const jwt = await zaiJwtToken(zaiKey);
                pi.registerProvider("zai", {
                    baseUrl: `${zaiBaseUrl}/v4`,
                    apiKey: "ZAI_API_KEY",
                    api: "openai-completions",
                    headers: { Authorization: `Bearer ${jwt}` },
                    authHeader: false,
                    models: buildModelDefs(zaiModels),
                });
            }
        }

        writeCache(cachePath, newCache);
    });
};
