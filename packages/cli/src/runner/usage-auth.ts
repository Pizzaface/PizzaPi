import type { AuthStorage } from "@mariozechner/pi-coding-agent";
import { logAuth } from "./logger.js";

export type RunnerAuthRecord = Record<string, unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

/**
 * Returns an OAuth bearer token from auth.json provider data.
 * Ignores API-key credentials to avoid probing subscription usage endpoints.
 *
 * NOTE: This reads the raw credential without refreshing expired OAuth tokens.
 * For long-lived processes (like the runner daemon), prefer {@link getRefreshedOAuthToken}
 * which uses `AuthStorage.getApiKey()` to auto-refresh expired tokens.
 */
export function getOAuthAccessToken(raw: unknown): string | null {
    if (!isRecord(raw)) return null;
    const type = raw.type;
    if (type === "api_key") return null;

    const access = raw.access;
    if (typeof access === "string" && access.trim().length > 0) return access;
    return null;
}

/**
 * Returns a refreshed OAuth bearer token for a provider, or null if the
 * credential is an API key or missing.
 *
 * Unlike {@link getOAuthAccessToken}, this uses `AuthStorage.getApiKey()` which
 * handles OAuth token refresh with file-locking for long-lived processes.
 */
export async function getRefreshedOAuthToken(authStorage: AuthStorage, providerId: string): Promise<string | null> {
    // Check credential type first — skip API-key credentials entirely.
    const raw = authStorage.get(providerId);
    if (!isRecord(raw)) return null;
    if (raw.type === "api_key") return null;
    if (raw.type !== "oauth") {
        // Unknown credential type — fall back to raw access token
        return getOAuthAccessToken(raw);
    }

    // Snapshot pre-refresh state for diagnostic logging
    const preExpires = typeof raw.expires === "number" ? raw.expires : 0;
    const preAccessPrefix = typeof raw.access === "string" ? raw.access.slice(0, 8) : "?";
    const wasExpired = Date.now() >= preExpires;

    // Use getApiKey() which handles OAuth token refresh + locking.
    const token = await authStorage.getApiKey(providerId);

    // Log if a refresh actually occurred (access token changed)
    const postRaw = authStorage.get(providerId);
    if (isRecord(postRaw) && postRaw.type === "oauth") {
        const postAccessPrefix = typeof postRaw.access === "string" ? postRaw.access.slice(0, 8) : "?";
        const postExpires = typeof postRaw.expires === "number" ? postRaw.expires : 0;
        if (preAccessPrefix !== postAccessPrefix) {
            logAuth("token-refreshed", {
                provider: providerId,
                wasExpired: wasExpired ? "yes" : "no",
                oldExpiresIn: `${Math.round((preExpires - Date.now()) / 1000)}s`,
                newExpiresIn: `${Math.round((postExpires - Date.now()) / 1000)}s`,
                oldTokenPrefix: preAccessPrefix,
                newTokenPrefix: postAccessPrefix,
            });
        }
    }

    return typeof token === "string" && token.trim().length > 0 ? token : null;
}

/**
 * Parse Gemini quota credential from auth.json provider data.
 * Accepts the OAuth payload format used by Gemini CLI ({ token, projectId })
 * but ignores API-key credentials.
 */
export function parseGeminiQuotaCredential(raw: unknown): { token: string; projectId: string } | null {
    if (typeof raw === "string") {
        try {
            return parseGeminiQuotaCredential(JSON.parse(raw));
        } catch {
            return null;
        }
    }

    if (!isRecord(raw)) return null;
    if (raw.type === "api_key") return null;

    const token = raw.token;
    const projectId = raw.projectId;
    if (typeof token !== "string" || typeof projectId !== "string") return null;
    if (!token.trim() || !projectId.trim()) return null;

    return { token, projectId };
}
