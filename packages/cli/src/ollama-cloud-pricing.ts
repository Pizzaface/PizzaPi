/**
 * Published Ollama Cloud per-1M-token rates (USD), scraped from the model
 * pages at https://ollama.com/search?c=cloud.
 *
 * Without this, toOllamaCloudRuntimeModel() reported cost 0 for every
 * ollama-cloud model and the whole usage ledger recorded $0.00 spend.
 *
 * ponytail: hand-maintained table, not fetched. ollama.com serves prices as
 * rendered HTML with no pricing API — scraping it at runtime is more moving
 * parts than editing a line when a model launches. Unlisted models are free
 * tier and correctly resolve to 0.
 */
export interface OllamaCloudRates {
    input: number;
    output: number;
    cacheRead: number;
}

/**
 * Keyed by model family (the part before any `:tag`). Models listing Base and
 * Peak pricing use the Base rate.
 */
export const OLLAMA_CLOUD_PRICING: Record<string, OllamaCloudRates> = {
    "glm-5.3": { input: 1.4, output: 4.4, cacheRead: 0.26 },
    "glm-5.3-flash": { input: 0.15, output: 0.5, cacheRead: 0.03 },
    "glm-5.2": { input: 1.4, output: 4.4, cacheRead: 0.26 },
    "glm-5.1": { input: 1.0, output: 3.2, cacheRead: 0.2 },
    "kimi-k3": { input: 3.0, output: 15.0, cacheRead: 0.3 },
    "kimi-k2.7-code": { input: 0.95, output: 4.0, cacheRead: 0.19 },
    "kimi-k2.6": { input: 0.95, output: 4.0, cacheRead: 0.16 },
    "deepseek-v4-pro": { input: 0.66, output: 1.98, cacheRead: 0.022 },
    "deepseek-v4-flash": { input: 0.22, output: 0.66, cacheRead: 0.007 },
    "minimax-m3": { input: 0.6, output: 2.4, cacheRead: 0.12 },
    "minimax-m2.7": { input: 0.3, output: 1.2, cacheRead: 0.06 },
    "mistral-large-3": { input: 0.5, output: 1.5, cacheRead: 0 },
    "nemotron-3-ultra": { input: 0.1, output: 3.0, cacheRead: 0.1 },
};

const FREE: OllamaCloudRates = { input: 0, output: 0, cacheRead: 0 };

/** Resolve rates for a model id, falling back to its family (`family:tag`). */
export function ollamaCloudRates(modelId: string): OllamaCloudRates {
    return OLLAMA_CLOUD_PRICING[modelId] ?? OLLAMA_CLOUD_PRICING[modelId.split(":")[0]!] ?? FREE;
}
