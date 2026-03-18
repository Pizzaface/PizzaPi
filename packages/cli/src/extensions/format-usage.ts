import type { ProviderUsageData } from "./remote-types.js";

/**
 * Format a single provider's usage data into human-readable lines.
 * Returns empty array if no usage data available.
 */
export function formatProviderUsage(data: ProviderUsageData | undefined): string[] {
    if (!data) return [];
    if (data.status === "unknown") return ["  Usage: unknown (access denied)"];
    if (data.windows.length === 0) return [];

    const parts = data.windows.map((w) => {
        const pct = Math.round(w.utilization);
        return `${w.label}: ${pct}%`;
    });

    return [`  Usage: ${parts.join(", ")}`];
}

/**
 * Map provider IDs from the model registry to provider IDs used by the usage system.
 * The usage system uses keys like "anthropic", "openai-codex", "google-gemini-cli"
 * while the model registry uses provider symbols/strings that may differ.
 */
const PROVIDER_USAGE_KEY_MAP: Record<string, string> = {
    anthropic: "anthropic",
    "openai-codex": "openai-codex",
    openai: "openai-codex",
    "google-gemini-cli": "google-gemini-cli",
    google: "google-gemini-cli",
};

export function getUsageKey(providerKey: string): string | undefined {
    return PROVIDER_USAGE_KEY_MAP[providerKey];
}
