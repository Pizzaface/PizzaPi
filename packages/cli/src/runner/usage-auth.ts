import { readBestExternalCredential } from "./keychain-auth.js";

export type RunnerAuthRecord = Record<string, unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

/**
 * Returns an OAuth bearer token from auth.json provider data.
 * Ignores API-key credentials to avoid probing subscription usage endpoints.
 *
 * This reads the raw credential without refreshing expired OAuth tokens.
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
 * Fallback Anthropic usage-check token: reads Claude Code's own OAuth token
 * straight from the macOS Keychain / `~/.claude/.credentials.json` (same
 * read-only lookup `readBestExternalCredential` already does) for users who
 * only ever logged into Claude Code directly and have no `anthropic` entry
 * in auth.json.
 *
 * Never refreshes or persists anything — an expired token is simply treated
 * as absent so we can't accidentally rotate Claude Code's own credentials.
 */
export function getAnthropicKeychainToken(now = Date.now()): string | null {
    const oauth = readBestExternalCredential()?.credentials.claudeAiOauth;
    if (!oauth || oauth.expiresAt <= now) return null;
    return oauth.accessToken;
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
