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

/**
 * Build a reverse map from usage keys back to display provider names.
 * Given a set of provider names seen in the model registry, returns a map
 * from internal usage key → display provider key.
 *
 * Example: given providers {"google", "openai", "anthropic"}, returns
 * { "google-gemini-cli": "google", "openai-codex": "openai", "anthropic": "anthropic" }
 */
export function buildUsageKeyToProviderMap(providerNames: Iterable<string>): Record<string, string> {
    const reverse: Record<string, string> = {};
    for (const name of providerNames) {
        const usageKey = PROVIDER_USAGE_KEY_MAP[name];
        if (usageKey && !reverse[usageKey]) {
            reverse[usageKey] = name;
        }
    }
    return reverse;
}

/**
 * Re-key a providerUsage record so that keys match the provider names
 * seen in the model registry (e.g. "google" instead of "google-gemini-cli").
 */
export function normalizeUsageKeys(
    raw: Record<string, import("./remote-types.js").ProviderUsageData>,
    providerNames: Iterable<string>,
): Record<string, import("./remote-types.js").ProviderUsageData> {
    const keyMap = buildUsageKeyToProviderMap(providerNames);
    const out: Record<string, import("./remote-types.js").ProviderUsageData> = {};
    for (const [usageKey, data] of Object.entries(raw)) {
        const displayKey = keyMap[usageKey] ?? usageKey;
        out[displayKey] = data;
    }
    return out;
}
