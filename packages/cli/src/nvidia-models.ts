/**
 * NVIDIA (build.nvidia.com) live model discovery.
 *
 * pi-ai ships a static NVIDIA catalog (a build-time snapshot) and pi overlays
 * it with pi.dev's catalog — both go stale: the snapshot still advertises
 * models NVIDIA has delisted and misses newly launched ones. This fetches
 * https://integrate.api.nvidia.com/v1/models directly and registers it as a
 * native provider that replaces the static catalog, keeping pi-ai's NVIDIA
 * auth (NVIDIA_API_KEY) and streaming untouched.
 *
 * Results are cached in ~/.pizzapi/nvidia-models-cache.json for 24h so startup
 * and model listing stay fast and offline-safe.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import { nvidiaProvider } from "@earendil-works/pi-ai/providers/nvidia";

const MODELS_URL = "https://integrate.api.nvidia.com/v1/models";
const BASE_URL = "https://integrate.api.nvidia.com/v1";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/** Matches the headers/compat flags pi-ai generates for every static NVIDIA model. */
const NVIDIA_HEADERS = { "NVCF-POLL-SECONDS": "3600" } as const;
const NVIDIA_COMPAT = {
    supportsStore: false,
    supportsDeveloperRole: false,
    supportsReasoningEffort: false,
    maxTokensField: "max_tokens",
    supportsStrictMode: false,
    supportsLongCacheRetention: false,
} as const;

/**
 * ponytail: NVIDIA's /v1/models lists every hosted NIM — embeddings, rerankers,
 * safety classifiers, OCR/vision-only endpoints — with no capability field to
 * filter on. Substring denylist; add ids here if a non-chat model slips through.
 */
const NON_CHAT = [
    "embed",
    "rerank",
    "retriever",
    "clip",
    "reward",
    "guard",
    "safety",
    "parse",
    "detector",
    "deplot",
    "kosmos",
    "fuyu",
    "neva",
    "vila",
];

type NvidiaModel = Model<"openai-completions">;

interface CacheEntry {
    models: NvidiaModel[];
    fetchedAt: number;
}

interface ApiModel {
    id?: unknown;
}

function cachePath(home = process.env.HOME || homedir()): string {
    return join(home, ".pizzapi", "nvidia-models-cache.json");
}

function readCache(home?: string): CacheEntry | null {
    try {
        const raw = JSON.parse(readFileSync(cachePath(home), "utf-8"));
        if (Array.isArray(raw?.models) && typeof raw.fetchedAt === "number") {
            const models = raw.models.filter(
                (m: any) => typeof m?.id === "string" && m?.provider === "nvidia" && typeof m?.contextWindow === "number",
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
    const dir = join(path, "..");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(path, JSON.stringify(entry), { mode: 0o600 });
}

function isChatModel(id: string): boolean {
    const lower = id.toLowerCase();
    return !NON_CHAT.some((needle) => lower.includes(needle));
}

/**
 * The live endpoint returns ids only, so curated metadata (name, context
 * window, cost, modalities) comes from pi-ai's static entry when the id is
 * known and from conservative defaults when it isn't.
 */
export function toNvidiaModel(entry: ApiModel, staticModels: readonly NvidiaModel[]): NvidiaModel | null {
    if (typeof entry?.id !== "string" || !entry.id) return null;
    if (!isChatModel(entry.id)) return null;

    const known = staticModels.find((model) => model.id === entry.id);
    if (known) return known;

    return {
        id: entry.id,
        name: entry.id,
        api: "openai-completions",
        provider: "nvidia",
        baseUrl: BASE_URL,
        headers: { ...NVIDIA_HEADERS },
        reasoning: /reason|think/i.test(entry.id),
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 4096,
        compat: { ...NVIDIA_COMPAT },
    } as NvidiaModel;
}

export function getCachedNvidiaModels(home?: string): NvidiaModel[] | null {
    return readCache(home)?.models ?? null;
}

/**
 * Fetch the live catalog, honouring the 24h cache unless `force` is set.
 * Throws on network/parse failure — callers keep the static catalog.
 */
export async function fetchNvidiaModels(
    { signal, force, home }: { signal?: AbortSignal; force?: boolean; home?: string } = {},
): Promise<NvidiaModel[]> {
    if (!force) {
        const cached = readCache(home);
        if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached.models;
    }

    const res = await fetch(MODELS_URL, { signal, headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`NVIDIA models API error: ${res.status} ${res.statusText}`);
    const body = (await res.json()) as { data?: unknown };
    if (!Array.isArray(body?.data)) throw new Error("Unexpected response from NVIDIA /v1/models");

    const staticModels = nvidiaProvider().getModels() as NvidiaModel[];
    const live = body.data
        .map((entry) => toNvidiaModel(entry as ApiModel, staticModels))
        .filter((m): m is NvidiaModel => m !== null);
    if (live.length === 0) throw new Error("NVIDIA /v1/models returned no usable models");

    // ponytail: union, not replace — /v1/models omits NIMs that still serve
    // traffic (glm-5.2, nemotron-super-49b), so replacing would break working
    // models. Stale package entries linger; that's today's behaviour anyway.
    const seen = new Set(staticModels.map((model) => model.id));
    const models = [...staticModels, ...live.filter((model) => !seen.has(model.id))];
    writeCache({ models, fetchedAt: Date.now() }, home);
    return models;
}

/**
 * pi-ai's NVIDIA provider with the live catalog swapped in when cached.
 * Auth, streaming, and everything else stay exactly as pi-ai defines them.
 */
export function nvidiaDynamicProvider(home?: string) {
    const base = nvidiaProvider();
    return {
        ...base,
        getModels: () => getCachedNvidiaModels(home) ?? base.getModels(),
    };
}

/**
 * Replace the built-in static NVIDIA catalog on a ModelRuntime. Registering
 * natively (rather than as a config overlay) keeps pi-ai's auth/stream intact
 * while dropping pi.dev's snapshot overlay in favour of NVIDIA's own API.
 */
export function registerNvidiaProvider(
    target: {
        // ModelRuntime exposes registerNativeProvider; the extension API takes a
        // native provider through its registerProvider(provider) overload.
        registerNativeProvider?: (...args: any[]) => void;
        registerProvider?: (...args: any[]) => void;
    },
    home?: string,
): void {
    const provider = nvidiaDynamicProvider(home);
    if (typeof target.registerNativeProvider === "function") target.registerNativeProvider(provider);
    else if (typeof target.registerProvider === "function") target.registerProvider(provider);
    else throw new Error("registerNvidiaProvider: target exposes no provider registration method");
}
