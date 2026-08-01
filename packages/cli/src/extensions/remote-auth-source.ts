/**
 * Auth source detection for the remote extension.
 *
 * Determines WHERE the active API key comes from (OAuth, auth.json, env var)
 * so the UI can display this to the user.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getEnvApiKey } from "@earendil-works/pi-ai/compat";
import type { AuthSource } from "./remote-types.js";

/**
 * Mirrors the auth-resolution priority chain to determine WHERE the
 * active API key comes from, so we can relay that to the user.
 */
export function getAuthSource(ctx: ExtensionContext | null): AuthSource {
    if (!ctx?.model) return "unknown";
    const provider = ctx.model.provider;

    // 1. OAuth takes priority when active
    if (ctx.modelRegistry.isUsingOAuth(ctx.model)) return "oauth";

    // 2. Stored auth.json credential vs. environment variable
    const status = ctx.modelRegistry.getProviderAuthStatus(provider);
    if (status.configured && status.source === "stored") return "auth.json";
    if (status.configured && status.source === "environment") return "env";

    // 3. Fallback: raw environment variable check
    if (getEnvApiKey(provider)) return "env";

    return "unknown";
}

export function authSourceLabel(source: AuthSource): string {
    switch (source) {
        case "auth.json": return "API key";
        case "env": return "env var";
        default: return "";
    }
}
