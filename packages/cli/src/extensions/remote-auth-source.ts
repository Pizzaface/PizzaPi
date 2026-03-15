/**
 * Auth source detection for the remote extension.
 *
 * Determines WHERE the active API key comes from (OAuth, auth.json, env var)
 * so the UI can display this to the user.
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { getEnvApiKey } from "@mariozechner/pi-ai/dist/env-api-keys.js";
import type { AuthSource } from "./remote-types.js";

/**
 * Mirrors AuthStorage.getApiKey() priority chain to determine WHERE the
 * active API key comes from, so we can relay that to the user.
 */
export function getAuthSource(ctx: ExtensionContext | null): AuthSource {
    if (!ctx?.model) return "unknown";
    const provider = ctx.model.provider;

    // 1. Check auth.json credentials (highest priority after runtime overrides)
    const cred = ctx.modelRegistry.authStorage.get(provider);
    if (cred?.type === "oauth") return "oauth";
    if (cred?.type === "api_key") return "auth.json";

    // 2. Check environment variable
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
