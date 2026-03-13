/**
 * Provider-specific model fetchers for dynamic model discovery.
 *
 * Each function queries a provider's models API and returns a normalized list.
 * On any error (network, auth, malformed response), returns an empty array
 * so the caller can continue with other providers.
 */

export interface DiscoveredModel {
    id: string;
    name: string;
}

const FETCH_TIMEOUT_MS = 10_000;

/** Fetch available models from an OpenAI-compatible `/v1/models` endpoint. */
export async function fetchOpenAIModels(baseUrl: string, apiKey: string): Promise<DiscoveredModel[]> {
    try {
        const url = baseUrl.endsWith("/v1") ? `${baseUrl}/models` : `${baseUrl}/v1/models`;
        const res = await fetch(url, {
            headers: { Authorization: `Bearer ${apiKey}` },
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
        if (!res.ok) return [];

        const body = await res.json() as { data?: Array<{ id: string; owned_by?: string }> };
        if (!Array.isArray(body?.data)) return [];

        return body.data
            .filter((m) => {
                const owner = m.owned_by ?? "";
                return owner === "openai" || owner === "system";
            })
            .map((m) => ({ id: m.id, name: m.id }));
    } catch {
        return [];
    }
}

/** Fetch available models from the Anthropic `/v1/models` endpoint. */
export async function fetchAnthropicModels(baseUrl: string, apiKey: string): Promise<DiscoveredModel[]> {
    try {
        const anthropicUrl = baseUrl.endsWith("/v1") ? `${baseUrl}/models` : `${baseUrl}/v1/models`;
        const res = await fetch(anthropicUrl, {
            headers: {
                "x-api-key": apiKey,
                "anthropic-version": "2023-06-01",
            },
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
        if (!res.ok) return [];

        const body = await res.json() as { data?: Array<{ id: string; display_name?: string }> };
        if (!Array.isArray(body?.data)) return [];

        return body.data.map((m) => ({
            id: m.id,
            name: m.display_name ?? m.id,
        }));
    } catch {
        return [];
    }
}
