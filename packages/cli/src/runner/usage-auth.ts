import { readBestExternalCredential } from "./keychain-auth.js";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isRecord } from "@pizzapi/protocol";

export type RunnerAuthRecord = Record<string, unknown>;

/** Read a Claude Code OAuth credential file, handling both the nested
 *  `{ claudeAiOauth: {...} }` shape and the flat `{ accessToken, ... }` shape. */
function readClaudeCodeCredentialsFile(path: string): { accessToken: string; expiresAt: number } | null {
    try {
        if (!existsSync(path)) return null;
        const raw = readFileSync(path, "utf-8").trim();
        if (!raw) return null;
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        const oauth = isRecord(parsed.claudeAiOauth) ? (parsed.claudeAiOauth as Record<string, unknown>) : parsed;
        const accessToken = oauth.accessToken;
        const expiresAt = oauth.expiresAt;
        if (typeof accessToken !== "string" || accessToken.trim().length === 0) return null;
        if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt)) return null;
        return { accessToken, expiresAt };
    } catch {
        return null;
    }
}

/** Path to minimalcc-pi's imported Claude Code OAuth credentials.
 *  When the user has run `/claude-subscription-import`, the credentials are
 *  copied here and kept refreshed by the extension. */
function minimalccPiImportedCredentialPath(): string {
    return join(homedir(), ".pizzapi", "agent", "pi-claude-subscription", "imported-credentials.json");
}

function readMinimalccPiImportedCredential(opts: { now?: number; path?: string } = {}): { accessToken: string; expiresAt: number } | null {
    const now = opts.now ?? Date.now();
    const path = opts.path ?? minimalccPiImportedCredentialPath();
    const cred = readClaudeCodeCredentialsFile(path);
    if (!cred || cred.expiresAt <= now) return null;
    return cred;
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
 * from the macOS Keychain / `~/.claude/.credentials.json`, and also from
 * minimalcc-pi's imported credential store if the user uses the
 * claude-subscription extension. This covers users who never ran /login inside
 * pizzapi and rely on Claude Code OAuth.
 *
 * Read-only — never refreshes or persists anything. An expired token is
 * treated as absent so we can't accidentally rotate credentials owned by
 * another process. (The minimalcc-pi extension keeps its imported credentials
 * refreshed independently.)
 */
export function getAnthropicKeychainToken(opts?: { now?: number; importedCredentialPath?: string }): string | null {
    const now = opts?.now ?? Date.now();
    const imported = readMinimalccPiImportedCredential({ now, path: opts?.importedCredentialPath });
    if (imported) return imported.accessToken;

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
