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
 * Parse a Gemini quota credential out of an auth.json provider entry.
 *
 * Two shapes exist in the wild:
 *  - `{ type: "oauth", access, refresh, expires }` — what a real `/login` writes.
 *  - `{ type: "api_key", key: '{"token":...,"projectId":...}' }` — legacy wrapper.
 *
 * `projectId` is null for the oauth shape; `:retrieveUserQuota` resolves the
 * caller's Code Assist project from the token when `project` is omitted, so
 * there is nothing to look up.
 *
 * Read-only: an expired `access` token is returned as-is and simply 401s at the
 * quota endpoint. ponytail: no refresh here, since refreshing would rotate
 * credentials another process owns — add one only if usage must survive an
 * idle provider.
 */
export function parseGeminiQuotaCredential(raw: unknown): { token: string; projectId: string | null } | null {
    if (typeof raw === "string") {
        try {
            return parseGeminiQuotaCredential(JSON.parse(raw));
        } catch {
            return null;
        }
    }

    if (!isRecord(raw)) return null;

    // OAuth credential: bearer token lives in `access`.
    if (typeof raw.access === "string" && raw.access.trim()) {
        const projectId = raw.projectId;
        return {
            token: raw.access,
            projectId: typeof projectId === "string" && projectId.trim() ? projectId : null,
        };
    }

    // Legacy: api_key credential whose `key` is JSON.stringify({ token, projectId }).
    // A genuine API key (e.g. "AIza...") fails the nested parse and yields null.
    if (raw.type === "api_key") {
        return typeof raw.key === "string" ? parseGeminiQuotaCredential(raw.key) : null;
    }

    const token = raw.token;
    const projectId = raw.projectId;
    if (typeof token !== "string" || typeof projectId !== "string") return null;
    if (!token.trim() || !projectId.trim()) return null;

    return { token, projectId };
}
