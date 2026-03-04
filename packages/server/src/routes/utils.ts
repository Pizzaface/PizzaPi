/**
 * Shared utilities used by multiple API routers.
 *
 * Extracted from the monolithic api.ts to eliminate duplication and make
 * utilities discoverable.
 */

import { getApiKeyRateLimitConfig, getKysely } from "../auth.js";
import { getRunners } from "../ws/sio-registry.js";
import { cwdMatchesRoots } from "../security.js";

// ── JSON helpers ────────────────────────────────────────────────────────────

/** Safely parse a JSON string that should be an array. Returns `[]` on failure. */
export function parseJsonArray(value: string | null | undefined): any[] {
    if (!value) return [];
    try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

// ── Runner selection ────────────────────────────────────────────────────────

/** Pick the runner with the fewest active sessions, or `null` if none exist. */
export async function pickRunnerIdLeastLoaded(): Promise<string | null> {
    const runners = (await getRunners()).slice().sort((a, b) => a.sessionCount - b.sessionCount);
    return runners.length > 0 ? runners[0].runnerId : null;
}

/**
 * Pick a runner whose declared workspace roots contain `requestedCwd`.
 * Falls back to least-loaded if no runner declares roots at all.
 * Returns `null` when no suitable runner is found.
 */
export async function pickRunnerIdForCwd(requestedCwd?: string): Promise<string | null> {
    const cwd = requestedCwd?.trim() ? requestedCwd : undefined;
    if (!cwd) return null;

    const all = (await getRunners()).map((r) => ({
        runnerId: r.runnerId,
        sessionCount: r.sessionCount,
        roots: r.roots as string[] | undefined,
    }));

    // 1) Prefer runners that declare roots AND match the cwd.
    const rootMatched = all
        .filter((r) => Array.isArray(r.roots) && r.roots.length > 0)
        .filter((r) => cwdMatchesRoots(r.roots ?? [], cwd))
        .sort((a, b) => a.sessionCount - b.sessionCount);

    if (rootMatched.length > 0) return rootMatched[0].runnerId;

    // 2) Fallback: ONLY if no runner declared any roots.
    // In that case we have no reliable way to match a cwd to a runner, so we pick
    // least-loaded and let the runner accept/reject based on actual filesystem.
    const anyRootsDeclared = all.some((r) => Array.isArray(r.roots) && r.roots.length > 0);
    if (anyRootsDeclared) return null;

    const fallback = all.slice().sort((a, b) => a.sessionCount - b.sessionCount);
    return fallback.length > 0 ? fallback[0].runnerId : null;
}

// ── Ephemeral API keys ──────────────────────────────────────────────────────

/**
 * Mint a short-lived API key for a user. The raw key is returned; only its
 * SHA-256 hash is stored in the database (matches better-auth's defaultKeyHasher).
 */
export async function mintEphemeralApiKey(
    userId: string,
    name: string,
    ttlSeconds: number,
): Promise<string> {
    const { randomBytes } = await import("crypto");
    const key = randomBytes(32).toString("hex");

    // Hash key using SHA-256 + base64url (matches better-auth's defaultKeyHasher)
    const keyHashBuf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
    const hashedKey = btoa(String.fromCharCode(...new Uint8Array(keyHashBuf)))
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=/g, "");

    const now = new Date();
    const nowIso = now.toISOString();
    const expiresAt = new Date(now.getTime() + ttlSeconds * 1000).toISOString();

    await getKysely()
        .insertInto("apikey")
        .values({
            id: crypto.randomUUID(),
            name,
            start: key.slice(0, 8),
            prefix: null,
            key: hashedKey,
            userId,
            refillInterval: null,
            refillAmount: null,
            lastRefillAt: null,
            enabled: 1,
            rateLimitEnabled: getApiKeyRateLimitConfig().enabled ? 1 : 0,
            rateLimitTimeWindow: getApiKeyRateLimitConfig().enabled ? getApiKeyRateLimitConfig().timeWindow : null,
            rateLimitMax: getApiKeyRateLimitConfig().enabled ? getApiKeyRateLimitConfig().maxRequests : null,
            requestCount: 0,
            remaining: null,
            lastRequest: null,
            expiresAt,
            createdAt: nowIso,
            updatedAt: nowIso,
            permissions: null,
            metadata: null,
        })
        .execute();

    return key;
}
