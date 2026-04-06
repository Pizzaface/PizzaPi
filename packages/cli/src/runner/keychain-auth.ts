/**
 * macOS Keychain integration for Claude Code OAuth credentials.
 *
 * Claude Code stores its OAuth token in the macOS Keychain under the service
 * name "Claude Code-credentials".  This module reads that token and, if it's
 * fresher than what's in auth.json, injects it into the AuthStorage so PizzaPi
 * can piggyback on the most recently refreshed credential.
 *
 * Read-only — we never write back to the Keychain.
 */

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import type { AuthStorage, OAuthCredential } from "@mariozechner/pi-coding-agent";
import { logInfo, logWarn, logAuth } from "./logger.js";

// ── Keychain credential shape (Claude Code) ────────────────────────────────

interface KeychainOAuth {
    accessToken: string;
    refreshToken: string;
    expiresAt: number; // epoch ms
    scopes?: string[];
    subscriptionType?: string;
    rateLimitTier?: string;
}

interface KeychainCredentials {
    claudeAiOauth?: KeychainOAuth;
    organizationUuid?: string;
}

// ── Constants ──────────────────────────────────────────────────────────────

const KEYCHAIN_SERVICE = "Claude Code-credentials";

/** Minimum advantage (in ms) the Keychain token must have to justify a swap. */
const FRESHNESS_THRESHOLD_MS = 60_000; // 1 minute

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Read the Claude Code OAuth credential from the macOS Keychain.
 * Returns `null` on non-macOS, missing entry, or parse failure.
 */
export function readKeychainCredentials(): KeychainCredentials | null {
    if (process.platform !== "darwin") return null;

    try {
        const raw = execSync(
            `security find-generic-password -s ${JSON.stringify(KEYCHAIN_SERVICE)} -w`,
            { encoding: "utf-8", timeout: 5_000, stdio: ["pipe", "pipe", "pipe"] },
        ).trim();

        if (!raw) return null;
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
        // Missing entry, Keychain locked, timeout, bad JSON — all silently ignored.
        return null;
    }
}

/**
 * Convert a Keychain OAuth payload into the auth.json credential format
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
 * Returns `true` if the Keychain expiry is meaningfully later than the
 * auth.json expiry (by at least {@link FRESHNESS_THRESHOLD_MS}).
 */
export function isKeychainFresher(keychainExpiresAt: number, authJsonExpires: number): boolean {
    return keychainExpiresAt - authJsonExpires > FRESHNESS_THRESHOLD_MS;
}

/**
 * If the Keychain holds a fresher Anthropic OAuth token than `authStorage`,
 * inject it into the storage (in-memory only — does NOT persist to auth.json).
 *
 * Use this at worker boot for an immediate credential upgrade.
 */
export function syncKeychainToAuthStorage(authStorage: AuthStorage): boolean {
    const kc = readKeychainCredentials();
    if (!kc?.claudeAiOauth) return false;

    const current = authStorage.get("anthropic") as { type: string; expires?: number } | undefined;
    const currentExpires = current?.type === "oauth" && typeof current.expires === "number" ? current.expires : 0;

    if (!isKeychainFresher(kc.claudeAiOauth.expiresAt, currentExpires)) {
        return false;
    }

    const credential = toAuthCredential(kc.claudeAiOauth);
    authStorage.set("anthropic", credential);

    const gainMs = kc.claudeAiOauth.expiresAt - currentExpires;
    logAuth("keychain-sync", {
        action: "injected",
        gainMinutes: `${Math.round(gainMs / 60_000)}`,
        newExpiresIn: `${Math.round((kc.claudeAiOauth.expiresAt - Date.now()) / 1000)}s`,
    });

    return true;
}

/**
 * If the Keychain holds a fresher Anthropic OAuth token than what's on disk
 * in `authJsonPath`, update the file so ALL workers benefit.
 *
 * Used by the daemon's periodic sync loop.
 */
export function syncKeychainToAuthJsonFile(authJsonPath: string): boolean {
    const kc = readKeychainCredentials();
    if (!kc?.claudeAiOauth) return false;

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

    if (!isKeychainFresher(kc.claudeAiOauth.expiresAt, existingExpires)) {
        return false;
    }

    const credential = toAuthCredential(kc.claudeAiOauth);
    diskData.anthropic = credential;

    try {
        writeFileSync(authJsonPath, JSON.stringify(diskData, null, 2), { encoding: "utf-8", mode: 0o600 });
    } catch (err) {
        logWarn(`keychain sync: failed to write auth.json: ${err instanceof Error ? err.message : String(err)}`);
        return false;
    }

    const gainMs = kc.claudeAiOauth.expiresAt - existingExpires;
    logInfo(
        `keychain sync: updated auth.json anthropic token (gained ${Math.round(gainMs / 60_000)} min, expires in ${Math.round((kc.claudeAiOauth.expiresAt - Date.now()) / 60_000)} min)`,
    );
    return true;
}
