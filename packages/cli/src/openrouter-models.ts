/**
 * OpenRouter live model discovery.
 *
 * pi-ai ships a static OpenRouter catalog (a build-time snapshot) and pi
 * overlays it with pi.dev's catalog — both go stale as OpenRouter adds models.
 * This fetches https://openrouter.ai/api/v1/models directly and registers it
 * as a native provider that replaces the static catalog, keeping pi-ai's
 * OpenRouter auth (env key + OAuth) and streaming untouched.
 *
 * Results are cached in ~/.pizzapi/openrouter-models-cache.json for 24h so
 * startup and model listing stay fast and offline-safe.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";

const MODELS_URL = "https://openrouter.ai/api/v1/models";
const BASE_URL = "https://openrouter.ai/api/v1";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/** Matches the compat flags pi-ai generates for every static OpenRouter model. */
const OPENROUTER_COMPAT = { supportsDeveloperRole: false, thinkingFormat: "openrouter" } as const;

type OpenRouterModel = Model<"openai-completions">;

interface CacheEntry {
    models: OpenRouterModel[];
    fetchedAt: number;
}

interface ApiModel {
    id?: unknown;
    name?: unknown;
    context_length?: unknown;
    architecture?: { input_modalities?: unknown };
    pricing?: Record<string, unknown>;
    top_provider?: { context_length?: unknown; max_completion_tokens?: unknown };
    supported_parameters?: unknown;
}

function cachePath(home = process.env.HOME || homedir()): string {
    return join(home, ".pizzapi", "openrouter-models-cache.json");
}

function readCache(home?: string): CacheEntry | null {
    try {
        const raw = JSON.parse(readFileSync(cachePath(home), "utf-8"));
        if (Array.isArray(raw?.models) && typeof raw.fetchedAt === "number") {
            const models = raw.models.filter(
                (m: any) => typeof m?.id === "string" && m?.provider === "openrouter" && typeof m?.contextWindow === "number",
            );
            if (models.length > 0) return { models, fetchedAt: raw.fetchedAt };
        }
    } catch {
        // missing or corrupt cache — fall back to the static catalog
    }
    return null;
}

function writeCache(entry: CacheEntry, home?: string): void {
    const path = cachePath(home);
    mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
    writeFileSync(path, JSON.stringify(entry), { mode: 0o600 });
}

/** OpenRouter prices per token as a decimal string; pi costs are per million tokens. */
function perMillion(price: unknown): number {
    const value = typeof price === "string" ? Number.parseFloat(price) : typeof price === "number" ? price : NaN;
    return Number.isFinite(value) ? value * 1_000_000 : 0;
}

export function toOpenRouterModel(entry: ApiModel): OpenRouterModel | null {
    if (typeof entry?.id !== "string" || !entry.id) return null;
    const params = Array.isArray(entry.supported_parameters) ? entry.supported_parameters : [];
    // Agent sessions need tool calling; pi-ai's static catalog is filtered the same way.
    if (!params.includes("tools")) return null;

    const modalities = Array.isArray(entry.architecture?.input_modalities) ? entry.architecture.input_modalities : [];
    const contextWindow =
        (typeof entry.top_provider?.context_length === "number" && entry.top_provider.context_length) ||
        (typeof entry.context_length === "number" && entry.context_length) ||
        128000;
    const maxTokens =
        typeof entry.top_provider?.max_completion_tokens === "number"
            ? entry.top_provider.max_completion_tokens
            : Math.min(32768, contextWindow);

    return {
        id: entry.id,
        name: typeof entry.name === "string" && entry.name ? entry.name : entry.id,
        api: "openai-completions",
        provider: "openrouter",
        baseUrl: BASE_URL,
        reasoning: params.includes("reasoning") || params.includes("include_reasoning"),
        input: modalities.includes("image") ? ["text", "image"] : ["text"],
        cost: {
            input: perMillion(entry.pricing?.prompt),
            output: perMillion(entry.pricing?.completion),
            cacheRead: perMillion(entry.pricing?.input_cache_read),
            cacheWrite: perMillion(entry.pricing?.input_cache_write),
        },
        contextWindow,
        maxTokens,
        compat: { ...OPENROUTER_COMPAT },
    } as OpenRouterModel;
}

export function getCachedOpenRouterModels(home?: string): OpenRouterModel[] | null {
    return readCache(home)?.models ?? null;
}

/**
 * Fetch the live catalog, honouring the 24h cache unless `force` is set.
 * Throws on network/parse failure — callers keep the static catalog.
 */
export async function fetchOpenRouterModels(
    { signal, force, home }: { signal?: AbortSignal; force?: boolean; home?: string } = {},
): Promise<OpenRouterModel[]> {
    if (!force) {
        const cached = readCache(home);
        if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached.models;
    }

    const res = await fetch(MODELS_URL, { signal, headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`OpenRouter models API error: ${res.status} ${res.statusText}`);
    const body = (await res.json()) as { data?: unknown };
    if (!Array.isArray(body?.data)) throw new Error("Unexpected response from OpenRouter /v1/models");

    const models = body.data.map(toOpenRouterModel).filter((m): m is OpenRouterModel => m !== null);
    if (models.length === 0) throw new Error("OpenRouter /v1/models returned no usable models");
    writeCache({ models, fetchedAt: Date.now() }, home);
    return models;
}

/**
 * pi-ai's OpenRouter provider with the live catalog swapped in when cached.
 * Auth, streaming, and everything else stay exactly as pi-ai defines them.
 */
export function openrouterDynamicProvider(home?: string) {
    const base = openrouterProvider();
    return {
        ...base,
        getModels: () => getCachedOpenRouterModels(home) ?? base.getModels(),
    };
}

/**
 * Replace the built-in static OpenRouter catalog on a ModelRuntime. Registering
 * natively (rather than as a config overlay) keeps pi-ai's auth/stream intact
 * while dropping pi.dev's snapshot overlay in favour of OpenRouter's own API.
 */
export function registerOpenRouterProvider(
    target: {
        // ModelRuntime exposes registerNativeProvider; the extension API takes a
        // native provider through its registerProvider(provider) overload.
        registerNativeProvider?: (...args: any[]) => void;
        registerProvider?: (...args: any[]) => void;
    },
    home?: string,
): void {
    const provider = openrouterDynamicProvider(home);
    if (typeof target.registerNativeProvider === "function") target.registerNativeProvider(provider);
    else if (typeof target.registerProvider === "function") target.registerProvider(provider);
    else throw new Error("registerOpenRouterProvider: target exposes no provider registration method");
}
