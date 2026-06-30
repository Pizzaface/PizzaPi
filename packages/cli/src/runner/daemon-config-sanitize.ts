/**
 * Utilities for sanitizing/restoring PizzaPi config objects when they transit
 * between the daemon and the browser UI.  Extracted as pure, stateless helpers
 * so they can be unit-tested independently of the daemon's socket event loop.
 *
 * MUST be kept in sync with the sentinel-restore logic in
 * settings_update_section (daemon.ts).
 */

/** Regex matching key/header names that should be treated as sensitive secrets. */
export const SENSITIVE_NAME_RE =
    /key|token|secret|password|credential|authorization|cookie|pat|bearer/i;

/** Placeholder written in place of secret values when sending config to the UI. */
export const MASK_SENTINEL = "***";

// ── Internal helpers ──────────────────────────────────────────────────────────

/**
 * Return a shallow-copied server entry with `env` and `headers` masked.
 * Only key names matching SENSITIVE_NAME_RE get the "***" treatment.
 */
function maskServerEntry(server: Record<string, unknown>): Record<string, unknown> {
    let sanitized: Record<string, unknown> = { ...server };

    if ("env" in sanitized && sanitized.env && typeof sanitized.env === "object") {
        const rawEnv = sanitized.env as Record<string, string>;
        const maskedEnv: Record<string, string> = {};
        for (const [k, v] of Object.entries(rawEnv)) {
            maskedEnv[k] = SENSITIVE_NAME_RE.test(k) ? MASK_SENTINEL : v;
        }
        sanitized = { ...sanitized, env: maskedEnv };
    }

    if ("headers" in sanitized && sanitized.headers && typeof sanitized.headers === "object") {
        const rawHeaders = sanitized.headers as Record<string, string>;
        const maskedHeaders: Record<string, string> = {};
        for (const [k, v] of Object.entries(rawHeaders)) {
            maskedHeaders[k] = SENSITIVE_NAME_RE.test(k) ? MASK_SENTINEL : v;
        }
        sanitized = { ...sanitized, headers: maskedHeaders };
    }

    return sanitized;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Mask sensitive fields in a PizzaPi config object before sending to the UI.
 *
 * - Removes `apiKey` and `relayUrl` (not needed in UI).
 * - Replaces sensitive env/header values with MASK_SENTINEL ("***") in:
 *   - `mcpServers` (Claude Code / compatibility object format)
 *   - `mcp.servers[]` (preferred array format)
 *   - `envOverrides`
 *
 * Must be kept in sync with the sentinel-restore logic in
 * `settings_update_section` (daemon.ts).
 */
export function sanitizeConfigForUI(config: Record<string, unknown>): Record<string, unknown> {
    const sanitized: any = { ...config };
    delete sanitized.apiKey;
    delete sanitized.relayUrl;

    // ── mcpServers{} — Claude Code / compatibility object format ─────────────
    if (sanitized.mcpServers && typeof sanitized.mcpServers === "object") {
        const sanitizedMcp: Record<string, unknown> = {};
        for (const [name, server] of Object.entries(
            sanitized.mcpServers as Record<string, unknown>,
        )) {
            if (server && typeof server === "object") {
                sanitizedMcp[name] = maskServerEntry(server as Record<string, unknown>);
            } else {
                sanitizedMcp[name] = server;
            }
        }
        sanitized.mcpServers = sanitizedMcp;
    }

    // ── mcp.servers[] — preferred array format ───────────────────────────────
    if (sanitized.mcp && typeof sanitized.mcp === "object") {
        const mcp = sanitized.mcp as Record<string, unknown>;
        if (Array.isArray(mcp.servers)) {
            const sanitizedServers = mcp.servers.map((entry: unknown) => {
                if (!entry || typeof entry !== "object") return entry;
                return maskServerEntry(entry as Record<string, unknown>);
            });
            sanitized.mcp = { ...mcp, servers: sanitizedServers };
        }
    }

    // ── envOverrides ─────────────────────────────────────────────────────────
    if (sanitized.envOverrides && typeof sanitized.envOverrides === "object") {
        const rawOverrides = sanitized.envOverrides as Record<string, string>;
        const maskedOverrides: Record<string, string> = {};
        for (const [k, v] of Object.entries(rawOverrides)) {
            maskedOverrides[k] = SENSITIVE_NAME_RE.test(k) ? MASK_SENTINEL : v;
        }
        sanitized.envOverrides = maskedOverrides;
    }

    return sanitized;
}

/**
 * Restore masked sentinel values in `env`/`headers` of a single MCP server entry.
 *
 * When the UI sends back a config that was previously sanitised, placeholder
 * "***" values must NOT be written to disk — they would overwrite the real
 * secrets.  This helper substitutes the original on-disk value for every key
 * still carrying the sentinel.
 *
 * If the existing (on-disk) entry doesn't have a value for the key, the
 * sentinel is passed through as-is, which is visible-but-recoverable.
 */
export function restoreMaskedServerEntry(
    incoming: Record<string, unknown>,
    existing: Record<string, unknown> | undefined,
): Record<string, unknown> {
    if (!existing) return incoming;
    let merged: Record<string, unknown> = { ...incoming };

    if (
        "env" in merged &&
        merged.env &&
        typeof merged.env === "object" &&
        existing.env &&
        typeof existing.env === "object"
    ) {
        const incomingEnv = merged.env as Record<string, string>;
        const existingEnv = existing.env as Record<string, string>;
        const restoredEnv: Record<string, string> = { ...incomingEnv };
        for (const [k, v] of Object.entries(incomingEnv)) {
            if (v === MASK_SENTINEL && typeof existingEnv[k] === "string") {
                restoredEnv[k] = existingEnv[k];
            }
        }
        merged = { ...merged, env: restoredEnv };
    }

    if (
        "headers" in merged &&
        merged.headers &&
        typeof merged.headers === "object" &&
        existing.headers &&
        typeof existing.headers === "object"
    ) {
        const incomingHeaders = merged.headers as Record<string, string>;
        const existingHeaders = existing.headers as Record<string, string>;
        const restoredHeaders: Record<string, string> = { ...incomingHeaders };
        for (const [k, v] of Object.entries(incomingHeaders)) {
            if (v === MASK_SENTINEL && typeof existingHeaders[k] === "string") {
                restoredHeaders[k] = existingHeaders[k];
            }
        }
        merged = { ...merged, headers: restoredHeaders };
    }

    return merged;
}


/**
 * Collect env/header keys that carry the mask sentinel on the given entry.
 */
function collectSentinelKeys(entry: Record<string, unknown>): { env: string[]; headers: string[] } {
    const envKeys: string[] = [];
    const headerKeys: string[] = [];
    if (entry.env && typeof entry.env === "object") {
        for (const [k, v] of Object.entries(entry.env as Record<string, unknown>)) {
            if (v === MASK_SENTINEL) envKeys.push(k);
        }
    }
    if (entry.headers && typeof entry.headers === "object") {
        for (const [k, v] of Object.entries(entry.headers as Record<string, unknown>)) {
            if (v === MASK_SENTINEL) headerKeys.push(k);
        }
    }
    return { env: envKeys, headers: headerKeys };
}

/**
 * Tries to find a unique match for a renamed server among deleted servers.
 *
 * Strategy: match on the sentinel keys themselves. The masked keys in the
 * incoming entry came from masking the deleted entry's secrets, so the deleted
 * entry must contain those exact keys with real (non-sentinel) string values.
 * This survives the user editing `command` / `url` / `args` in the same save.
 *
 * If multiple deleted entries qualify, tiebreak by structural similarity
 * (command / url / args). If still ambiguous, return undefined.
 */
export function findRenamedServerMatch(
    incomingEntry: Record<string, unknown>,
    deletedEntries: Record<string, unknown>[]
): Record<string, unknown> | undefined {
    const { env: sentinelEnvKeys, headers: sentinelHeaderKeys } = collectSentinelKeys(incomingEntry);
    if (sentinelEnvKeys.length === 0 && sentinelHeaderKeys.length === 0) {
        return undefined;
    }

    const hasRealValue = (obj: unknown, key: string): boolean => {
        if (!obj || typeof obj !== "object") return false;
        const v = (obj as Record<string, unknown>)[key];
        return typeof v === "string" && v !== MASK_SENTINEL;
    };

    const candidates = deletedEntries.filter(deleted => {
        for (const k of sentinelEnvKeys) {
            if (!hasRealValue(deleted.env, k)) return false;
        }
        for (const k of sentinelHeaderKeys) {
            if (!hasRealValue(deleted.headers, k)) return false;
        }
        return true;
    });

    if (candidates.length === 1) return candidates[0];
    if (candidates.length === 0) return undefined;

    // Multiple candidates carry the same sentinel keys — tiebreak structurally.
    const structural = candidates.filter(deleted => {
        if (deleted.command !== incomingEntry.command) return false;
        if (deleted.url !== incomingEntry.url) return false;
        const delArgs = Array.isArray(deleted.args) ? deleted.args : [];
        const incArgs = Array.isArray(incomingEntry.args) ? incomingEntry.args : [];
        if (delArgs.length !== incArgs.length) return false;
        return delArgs.every((val, idx) => val === incArgs[idx]);
    });

    return structural.length === 1 ? structural[0] : undefined;
}
