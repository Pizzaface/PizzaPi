/**
 * Ollama Cloud dynamic model discovery.
 *
 * Fetches the live model list from https://ollama.com/v1/models and enriches
 * each entry with metadata from https://ollama.com/api/show. Results are
 * cached in ~/.pizzapi/ollama-cloud-models-cache.json for 24 hours so startup
 * and model listing stay fast.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const OLLAMA_CLOUD_MODELS_URL = "https://ollama.com/v1/models";
const OLLAMA_CLOUD_SHOW_URL = "https://ollama.com/api/show";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

type OllamaModelInput = "text" | "image";

export interface OllamaCloudModel {
    id: string;
    name: string;
    provider: "ollama-cloud";
    api: "openai-completions";
    baseUrl: string;
    reasoning: boolean;
    input: OllamaModelInput[];
    contextWindow: number;
    maxTokens: number;
}

interface OllamaCloudCacheEntry {
    models: OllamaCloudModel[];
    fetchedAt: number;
}

interface OllamaApiShowResponse {
    capabilities?: string[];
    model_info?: Record<string, unknown>;
    details?: {
        parent_model?: string;
        parameter_size?: string;
    };
}

function homeDir(): string {
    // Prefer the runtime environment variable so tests can redirect the cache
    // directory without being pinned to the first os.homedir() result.
    return process.env.HOME || homedir();
}

function cachePath(): string {
    return join(homeDir(), ".pizzapi", "ollama-cloud-models-cache.json");
}

function readCache(): OllamaCloudCacheEntry | null {
    const path = cachePath();
    if (!existsSync(path)) return null;
    try {
        const raw = JSON.parse(readFileSync(path, "utf-8"));
        if (
            typeof raw === "object" &&
            raw !== null &&
            Array.isArray(raw.models) &&
            typeof raw.fetchedAt === "number"
        ) {
            return raw as OllamaCloudCacheEntry;
        }
    } catch {
        // ignore corrupt cache
    }
    return null;
}

function writeCache(entry: OllamaCloudCacheEntry): void {
    const dir = join(homeDir(), ".pizzapi");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(cachePath(), JSON.stringify(entry, null, 2), { mode: 0o600 });
}

async function fetchJson(url: string, options?: RequestInit): Promise<unknown> {
    const res = await fetch(url, { ...options, headers: { "Content-Type": "application/json", ...options?.headers } });
    if (!res.ok) {
        throw new Error(`Ollama Cloud API error: ${res.status} ${res.statusText} (${url})`);
    }
    return res.json();
}

export function extractContextLength(modelInfo: Record<string, unknown> | undefined): number | undefined {
    if (!modelInfo) return undefined;
    for (const [key, value] of Object.entries(modelInfo)) {
        if (key.endsWith(".context_length") && typeof value === "number") {
            return value;
        }
    }
    if (typeof modelInfo.context_length === "number") {
        return modelInfo.context_length;
    }
    return undefined;
}

export function capabilitiesInclude(caps: string[] | undefined, needle: string): boolean {
    return caps?.some((c) => c.toLowerCase() === needle.toLowerCase()) ?? false;
}

export async function fetchOllamaCloudModels({ signal }: { signal?: AbortSignal } = {}): Promise<OllamaCloudModel[]> {
    const cached = readCache();
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
        return cached.models;
    }

    const list = await fetchJson(OLLAMA_CLOUD_MODELS_URL, { signal });
    if (typeof list !== "object" || list === null || !Array.isArray((list as any).data)) {
        throw new Error("Unexpected response from Ollama Cloud /v1/models");
    }

    const entries = (list as { data: Array<{ id: string; created?: number }> }).data;

    const models = await Promise.all(
        entries.map(async (entry) => {
            const id = entry.id;
            const info = await fetchModelMetadata(id, { signal });
            return buildModel(id, info);
        }),
    );

    // Filter out any entries we couldn't enrich (e.g. transient /api/show failures)
    const valid = models.filter((m): m is OllamaCloudModel => m !== null);

    writeCache({ models: valid, fetchedAt: Date.now() });
    return valid;
}

async function fetchModelMetadata(
    id: string,
    { signal }: { signal?: AbortSignal } = {},
): Promise<OllamaApiShowResponse | null> {
    // Ollama Cloud accepts both :cloud and -cloud suffixes for /api/show.
    const suffixes = [":cloud", "-cloud"];
    for (const suffix of suffixes) {
        try {
            const body = JSON.stringify({ name: id + suffix });
            const result = await fetchJson(OLLAMA_CLOUD_SHOW_URL, {
                method: "POST",
                body,
                signal,
            });
            if (typeof result === "object" && result !== null) {
                return result as OllamaApiShowResponse;
            }
        } catch {
            // try next suffix
        }
    }
    return null;
}

function buildModel(id: string, info: OllamaApiShowResponse | null): OllamaCloudModel | null {
    const caps = info?.capabilities ?? [];
    const contextWindow = extractContextLength(info?.model_info) ?? 128000;
    const reasoning = capabilitiesInclude(caps, "thinking");
    const vision = capabilitiesInclude(caps, "vision");
    const input: OllamaModelInput[] = vision ? ["text", "image"] : ["text"];

    return {
        id,
        name: id,
        provider: "ollama-cloud",
        api: "openai-completions",
        baseUrl: "https://ollama.com/v1",
        reasoning,
        input,
        contextWindow,
        maxTokens: 32768,
    };
}
