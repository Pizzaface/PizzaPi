/**
 * External credential source integration for Claude Code OAuth credentials.
 *
 * Reads Claude Code OAuth tokens from two sources:
 *
 * 1. **macOS Keychain** — Multiple accounts are supported. Claude Code stores
 *    entries under service names matching `Claude Code-credentials*` (e.g.
 *    `Claude Code-credentials`, `Claude Code-credentials-{orgUuid}`). We
 *    enumerate all matching entries and pick the freshest valid one.
 *
 * 2. **`~/.claude/.credentials.json`** — Fallback for non-macOS platforms
 *    (Linux, Windows, Docker/headless). Same JSON shape as the Keychain
 *    payload. Used when no Keychain is available or has no valid entries.
 *
 * If the external credential is fresher than what's in auth.json, we inject
 * it into the AuthStorage so PizzaPi can piggyback on the most recently
 * refreshed credential.
 *
 * Read-only — we never write back to the Keychain or credentials file.
 */

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { AuthStorage, OAuthCredential } from "@mariozechner/pi-coding-agent";
import { logInfo, logWarn, logAuth } from "./logger.js";

// ── Credential shape (Claude Code) ─────────────────────────────────────────

export interface KeychainOAuth {
    accessToken: string;
    refreshToken: string;
    expiresAt: number; // epoch ms
    scopes?: string[];
    subscriptionType?: string;
    rateLimitTier?: string;
}

export interface KeychainCredentials {
    claudeAiOauth?: KeychainOAuth;
    organizationUuid?: string;
}

/** An external credential with metadata about where it came from. */
export interface ExternalCredential {
    credentials: KeychainCredentials;
    source: "keychain" | "credentials-file";
    /** Keychain service name or file path */
    sourceLabel: string;
}

// ── Constants ──────────────────────────────────────────────────────────────

const KEYCHAIN_SERVICE_PREFIX = "Claude Code-credentials";

/** Minimum advantage (in ms) the external token must have to justify a swap. */
const FRESHNESS_THRESHOLD_MS = 60_000; // 1 minute

/** Path to Claude Code's credentials file (cross-platform fallback). */
const CREDENTIALS_FILE_PATH = join(homedir(), ".claude", ".credentials.json");

// ── Keychain reading (macOS) ───────────────────────────────────────────────

/**
 * Read the Claude Code OAuth credential from a specific macOS Keychain
 * service entry. Returns `null` on non-macOS, missing entry, or parse failure.
 */
export function readKeychainEntry(serviceName: string): KeychainCredentials | null {
    if (process.platform !== "darwin") return null;

    try {
        const raw = execSync(
            `security find-generic-password -s ${JSON.stringify(serviceName)} -w`,
            { encoding: "utf-8", timeout: 5_000, stdio: ["pipe", "pipe", "pipe"] },
        ).trim();

        if (!raw) return null;
        return parseCredentialsJson(raw);
    } catch {
        // Missing entry, Keychain locked, timeout, bad JSON — all silently ignored.
        return null;
    }
}

/**
 * Enumerate all macOS Keychain entries whose service name starts with
 * `Claude Code-credentials`. Returns an array of `{ serviceName, credentials }`.
 *
 * On non-macOS platforms, returns an empty array.
 *
 * Implementation: `security dump-keychain` outputs all entries; we parse
 * service names matching our prefix and then read each entry individually
 * (since `dump-keychain` doesn't output passwords for generic entries).
 */
export function enumerateKeychainAccounts(): Array<{ serviceName: string; credentials: KeychainCredentials }> {
    if (process.platform !== "darwin") return [];

    try {
        // First, try the primary entry (fast path for single-account users)
        const primary = readKeychainEntry(KEYCHAIN_SERVICE_PREFIX);
        const results: Array<{ serviceName: string; credentials: KeychainCredentials }> = [];

        if (primary) {
            results.push({ serviceName: KEYCHAIN_SERVICE_PREFIX, credentials: primary });
        }

        // Enumerate additional accounts by scanning the keychain for matching service names.
        // `security dump-keychain` lists metadata (no passwords) for all entries.
        // We look for service names matching "Claude Code-credentials-*".
        try {
            const dump = execSync("security dump-keychain", {
                encoding: "utf-8",
                timeout: 10_000,
                stdio: ["pipe", "pipe", "pipe"],
            });

            // Parse service names from the dump output.
            // Format: 0x00000007 <blob>="Claude Code-credentials-orgUuid"
            // or:     "svce"<blob>="Claude Code-credentials-orgUuid"
            const serviceRegex = /(?:0x00000007|"svce")\s*<blob>="(Claude Code-credentials-[^"]+)"/g;
            const seen = new Set<string>();
            // Always mark the primary as seen to avoid duplicate reads
            seen.add(KEYCHAIN_SERVICE_PREFIX);

            let match: RegExpExecArray | null;
            while ((match = serviceRegex.exec(dump)) !== null) {
                const svcName = match[1];
                if (seen.has(svcName)) continue;
                seen.add(svcName);

                const cred = readKeychainEntry(svcName);
                if (cred) {
                    results.push({ serviceName: svcName, credentials: cred });
                }
            }
        } catch {
            // dump-keychain failed — we still have the primary entry if it worked
        }

        return results;
    } catch {
        return [];
    }
}

/**
 * Read the Claude Code OAuth credential from the macOS Keychain.
 * Returns `null` on non-macOS, missing entry, or parse failure.
 *
 * When multiple accounts exist, returns the one with the freshest
 * (latest-expiring) non-expired token.
 */
export function readKeychainCredentials(): KeychainCredentials | null {
    const accounts = enumerateKeychainAccounts();
    if (accounts.length === 0) return null;
    if (accounts.length === 1) return accounts[0].credentials;

    // Pick the freshest valid credential
    return pickFreshestCredential(accounts.map((a) => a.credentials));
}

// ── Credentials file reading (cross-platform fallback) ─────────────────────

/**
 * Read Claude Code's credentials from `~/.claude/.credentials.json`.
 *
 * This is the fallback credential source for non-macOS platforms (Linux,
 * Windows, Docker, headless servers) where the macOS Keychain isn't available.
 * Also useful on macOS if the Keychain entry is missing/locked.
 *
 * @param filePath Override the default path (for testing).
 */
export function readCredentialsFile(filePath: string = CREDENTIALS_FILE_PATH): KeychainCredentials | null {
    try {
        if (!existsSync(filePath)) return null;

        const raw = readFileSync(filePath, "utf-8").trim();
        if (!raw) return null;

        return parseCredentialsJson(raw);
    } catch {
        // File unreadable, bad JSON, etc. — silently return null.
        return null;
    }
}

// ── Shared helpers ─────────────────────────────────────────────────────────

/**
 * Parse and validate a credentials JSON string.
 * Returns `null` if the JSON is invalid or missing required fields.
 */
export function parseCredentialsJson(raw: string): KeychainCredentials | null {
    try {
        const parsed = JSON.parse(raw) as KeychainCredentials;

        // Basic validation
        const oauth = parsed?.claudeAiOauth;
        if (
            !oauth ||
            typeof oauth.accessToken !== "string" ||
            typeof oauth.refreshToken !== "string" ||
            typeof oauth.expiresAt !== "number"
        ) {
            return null;
        }

        return parsed;
    } catch {
        return null;
    }
}

/**
 * Given multiple credential objects, return the one with the freshest
 * (latest-expiring) token that isn't already expired.
 * Falls back to the freshest expired one if none are valid.
 */
export function pickFreshestCredential(credentials: KeychainCredentials[]): KeychainCredentials | null {
    if (credentials.length === 0) return null;

    const now = Date.now();
    let bestValid: KeychainCredentials | null = null;
    let bestValidExpiry = 0;
    let bestExpired: KeychainCredentials | null = null;
    let bestExpiredExpiry = 0;

    for (const cred of credentials) {
        const expiry = cred.claudeAiOauth?.expiresAt ?? 0;
        if (expiry > now) {
            // Not expired
            if (expiry > bestValidExpiry) {
                bestValid = cred;
                bestValidExpiry = expiry;
            }
        } else {
            // Expired — track as fallback
            if (expiry > bestExpiredExpiry) {
                bestExpired = cred;
                bestExpiredExpiry = expiry;
            }
        }
    }

    return bestValid ?? bestExpired;
}

/**
 * Read the best available external credential from all sources.
 *
 * Priority:
 * 1. macOS Keychain (all matching accounts, pick freshest)
 * 2. `~/.claude/.credentials.json` (cross-platform fallback)
 *
 * Returns the best credential with source metadata, or `null` if none found.
 */
export function readBestExternalCredential(): ExternalCredential | null {
    // Try Keychain first (macOS only, may have multiple accounts)
    const accounts = enumerateKeychainAccounts();
    if (accounts.length > 0) {
        if (accounts.length === 1) {
            return {
                credentials: accounts[0].credentials,
                source: "keychain",
                sourceLabel: accounts[0].serviceName,
            };
        }
        // Multiple accounts — pick the freshest
        const now = Date.now();
        let best: (typeof accounts)[number] | null = null;
        let bestExpiry = 0;
        for (const account of accounts) {
            const expiry = account.credentials.claudeAiOauth?.expiresAt ?? 0;
            if (expiry > bestExpiry) {
                best = account;
                bestExpiry = expiry;
            }
        }
        if (best) {
            if (accounts.length > 1) {
                logAuth("keychain-multi-account", {
                    accountCount: `${accounts.length}`,
                    selected: best.serviceName,
                    expiresIn: `${Math.round((bestExpiry - now) / 1000)}s`,
                });
            }
            return {
                credentials: best.credentials,
                source: "keychain",
                sourceLabel: best.serviceName,
            };
        }
    }

    // Fallback: credentials file
    const fileCred = readCredentialsFile();
    if (fileCred) {
        return {
            credentials: fileCred,
            source: "credentials-file",
            sourceLabel: CREDENTIALS_FILE_PATH,
        };
    }

    return null;
}

// ── Conversion helpers ─────────────────────────────────────────────────────

/**
 * Convert a Claude Code OAuth payload into the auth.json credential format
 * used by pi's AuthStorage.
 */
export function toAuthCredential(keychain: KeychainOAuth): OAuthCredential {
    return {
        type: "oauth",
        access: keychain.accessToken,
        refresh: keychain.refreshToken,
        expires: keychain.expiresAt,
    } as OAuthCredential;
}

/**
 * Returns `true` if the external expiry is meaningfully later than the
 * auth.json expiry (by at least {@link FRESHNESS_THRESHOLD_MS}).
 */
export function isKeychainFresher(externalExpiresAt: number, authJsonExpires: number): boolean {
    return externalExpiresAt - authJsonExpires > FRESHNESS_THRESHOLD_MS;
}

// ── Sync functions ─────────────────────────────────────────────────────────

/**
 * If an external source holds a fresher Anthropic OAuth token than
 * `authStorage`, inject it into the storage (in-memory only — does NOT
 * persist to auth.json).
 *
 * Use this at worker boot for an immediate credential upgrade.
 */
export function syncKeychainToAuthStorage(authStorage: AuthStorage): boolean {
    const ext = readBestExternalCredential();
    if (!ext?.credentials.claudeAiOauth) return false;

    const current = authStorage.get("anthropic") as { type: string; expires?: number } | undefined;
    const currentExpires = current?.type === "oauth" && typeof current.expires === "number" ? current.expires : 0;

    if (!isKeychainFresher(ext.credentials.claudeAiOauth.expiresAt, currentExpires)) {
        return false;
    }

    const credential = toAuthCredential(ext.credentials.claudeAiOauth);
    authStorage.set("anthropic", credential);

    const gainMs = ext.credentials.claudeAiOauth.expiresAt - currentExpires;
    logAuth("credential-sync", {
        action: "injected",
        source: ext.source,
        sourceLabel: ext.sourceLabel,
        gainMinutes: `${Math.round(gainMs / 60_000)}`,
        newExpiresIn: `${Math.round((ext.credentials.claudeAiOauth.expiresAt - Date.now()) / 1000)}s`,
    });

    return true;
}

/**
 * If an external source holds a fresher Anthropic OAuth token than what's
 * on disk in `authJsonPath`, update the file so ALL workers benefit.
 *
 * Used by the daemon's periodic sync loop.
 */
export function syncKeychainToAuthJsonFile(authJsonPath: string): boolean {
    const ext = readBestExternalCredential();
    if (!ext?.credentials.claudeAiOauth) return false;

    let diskData: Record<string, unknown> = {};
    try {
        const raw = readFileSync(authJsonPath, "utf-8");
        diskData = JSON.parse(raw);
    } catch {
        // File missing or unparseable — we'll create/overwrite the anthropic entry.
    }

    const existing = diskData.anthropic as { type?: string; expires?: number } | undefined;
    const existingExpires =
        existing?.type === "oauth" && typeof existing.expires === "number" ? existing.expires : 0;

    if (!isKeychainFresher(ext.credentials.claudeAiOauth.expiresAt, existingExpires)) {
        return false;
    }

    const credential = toAuthCredential(ext.credentials.claudeAiOauth);
    diskData.anthropic = credential;

    try {
        writeFileSync(authJsonPath, JSON.stringify(diskData, null, 2), { encoding: "utf-8", mode: 0o600 });
    } catch (err) {
        logWarn(`credential sync: failed to write auth.json: ${err instanceof Error ? err.message : String(err)}`);
        return false;
    }

    const gainMs = ext.credentials.claudeAiOauth.expiresAt - existingExpires;
    logInfo(
        `credential sync [${ext.source}]: updated auth.json anthropic token (gained ${Math.round(gainMs / 60_000)} min, expires in ${Math.round((ext.credentials.claudeAiOauth.expiresAt - Date.now()) / 60_000)} min)`,
    );
    return true;
}
