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

/**
 * Generate a short-lived JWT for Zhipu AI (zAI) authentication.
 * Their API key format is "<id>.<secret>" and requires HS256 JWT.
 */
export async function zaiJwtToken(apiKey: string): Promise<string> {
    const [keyId, secret] = apiKey.split(".");
    const encode = (obj: object) =>
        btoa(JSON.stringify(obj)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
    const header = encode({ alg: "HS256", sign_type: "SIGN" });
    const payload = encode({ api_key: keyId, exp: Math.floor(Date.now() / 1000) + 3600, timestamp: Math.floor(Date.now() / 1000) });
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${header}.${payload}`));
    const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
    return `${header}.${payload}.${sigB64}`;
}

/** Fetch available models from the Zhipu AI (zAI) API. */
export async function fetchZAIModels(baseUrl: string, apiKey: string): Promise<DiscoveredModel[]> {
    try {
        const token = await zaiJwtToken(apiKey);
        const url = baseUrl.endsWith("/v4") ? `${baseUrl}/models` : `${baseUrl}/v4/models`;
        const res = await fetch(url, {
            headers: { Authorization: `Bearer ${token}` },
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
        if (!res.ok) return [];
        const body = await res.json() as { data?: Array<{ id: string }> };
        if (!Array.isArray(body?.data)) return [];
        return body.data.map((m) => ({ id: m.id, name: m.id }));
    } catch {
        return [];
    }
}

/** Fetch all models from an Ollama server's OpenAI-compatible `/v1/models` endpoint. */
export async function fetchOllamaModels(baseUrl: string): Promise<DiscoveredModel[]> {
    try {
        const url = baseUrl.endsWith("/v1") ? `${baseUrl}/models` : `${baseUrl}/v1/models`;
        const res = await fetch(url, {
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
        if (!res.ok) return [];

        const body = await res.json() as { data?: Array<{ id: string }> };
        if (!Array.isArray(body?.data)) return [];

        return body.data.map((m) => ({ id: m.id, name: m.id }));
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
