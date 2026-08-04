/**
 * Headless auto-pairing for `pizza runner`.
 *
 * When a container boots with no usable credential, prompting is impossible
 * (no stdin), so this mints one automatically via the same device-claim flow
 * `pizza setup --scan` uses \u2014 print an approval URL + QR, wait, persist the
 * key on approval. Runs in the supervisor, before the daemon (and its
 * runner.json pid lock) exist, so pairing-pending state lives in its own
 * small file rather than runner.json (see pairingStatusPath).
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { loadGlobalConfig, saveConfigAt } from "../config.js";
import { toHttpRelayUrl } from "../relay-url.js";
import { requestHeadlessPairing } from "../setup.js";
import { logError, logInfo, logWarn } from "./logger.js";

const PAIRING_STATUS_FILENAME = "pairing-pending.json";

export interface PairingStatus {
    claimUrl: string;
    expiresAt?: string;
    relayUrl: string;
    startedAt: string;
}

export function pairingStatusPath(agentDir: string): string {
    return join(agentDir, PAIRING_STATUS_FILENAME);
}

export function readPairingStatus(path: string): PairingStatus | null {
    if (!existsSync(path)) return null;
    try {
        return JSON.parse(readFileSync(path, "utf-8"));
    } catch {
        return null;
    }
}

function writePairingStatus(path: string, status: PairingStatus): void {
    try {
        mkdirSync(join(path, ".."), { recursive: true });
        writeFileSync(path, JSON.stringify(status, null, 2), { encoding: "utf-8", mode: 0o600 });
    } catch (err) {
        logWarn(`Failed to write pairing status: ${err instanceof Error ? err.message : String(err)}`);
    }
}

export function clearPairingStatus(path: string): void {
    try { rmSync(path, { force: true }); } catch {}
}

export interface PairingTriggerInput {
    hasApiKey: boolean;
    hasToken: boolean;
    relayUrl?: string;
    pairingDisabled: boolean;
}

/** Pure predicate: should `pizza runner` auto-pair on this boot? */
export function shouldAutoPair(input: PairingTriggerInput): boolean {
    if (input.pairingDisabled) return false;
    if (input.hasApiKey || input.hasToken) return false;
    return Boolean(input.relayUrl);
}

/** Mirrors the priority chain daemon.ts uses to resolve a usable API key. */
export function resolveExistingApiKey(configApiKey?: string): string | undefined {
    return (
        process.env.PIZZAPI_RUNNER_API_KEY ??
        process.env.PIZZAPI_API_KEY ??
        process.env.PIZZAPI_API_TOKEN ??
        configApiKey
    );
}

/**
 * Relay URL known from env or config, with no "localhost" default \u2014 unlike
 * the daemon's own resolution, auto-pairing can't silently fall back to a
 * default relay: if there isn't an explicit one, we can't prompt for it.
 */
export function resolveKnownRelayUrl(configRelayUrl?: string): string | undefined {
    const raw = (process.env.PIZZAPI_RELAY_URL || configRelayUrl || "").trim();
    if (!raw || raw === "off") return undefined;
    return raw.replace(/\/$/, "");
}

/**
 * Runs before the daemon subprocess starts. If credentials are already
 * present (or pairing is explicitly disabled), returns immediately. Otherwise
 * pairs headlessly, persists the key into `<agentDir>/config.json`, and sets
 * process.env so the daemon \u2014 spawned with `env: process.env` \u2014 picks it up
 * without a restart.
 *
 * Returns an exit code when startup should abort, or null to continue.
 */
export async function ensureRunnerCredentials(agentDir: string): Promise<number | null> {
    const config = loadGlobalConfig();
    const hasApiKey = Boolean(resolveExistingApiKey(config.apiKey));
    const hasToken = Boolean(process.env.PIZZAPI_RUNNER_TOKEN);
    const pairingDisabled = process.env.PIZZAPI_PAIRING === "0";
    const relayUrl = resolveKnownRelayUrl(config.relayUrl);

    if (!shouldAutoPair({ hasApiKey, hasToken, relayUrl, pairingDisabled })) {
        if (!hasApiKey && !hasToken && !pairingDisabled) {
            // Nothing to pair against and no explicit opt-out — the daemon
            // would just fail with the same "no credential" message, but we
            // can't prompt, so fail here with the actionable fix.
            logError(
                "No API key configured and no relay URL to auto-pair against. " +
                    "Set PIZZAPI_RELAY_URL to pair automatically, or set PIZZAPI_API_KEY directly.",
            );
            return 1;
        }
        return null; // credentials already present, or pairing explicitly disabled
    }

    const label = process.env.PIZZAPI_RUNNER_NAME?.trim() || hostname();
    const statusPath = pairingStatusPath(agentDir);
    logInfo(`no credentials found — pairing with ${relayUrl} as "${label}"…`);

    // The setup-claim REST endpoints need http(s) — but `relayUrl` here may
    // already be the ws(s) form a *previous* pairing left in config.json
    // (apiKey cleared without also clearing relayUrl). See relay-url.ts.
    const claimRelayUrl = toHttpRelayUrl(relayUrl!);
    const result = await requestHeadlessPairing(claimRelayUrl, {
        label,
        onClaim: (info) =>
            writePairingStatus(statusPath, {
                claimUrl: info.claimUrl,
                expiresAt: info.expiresAt,
                relayUrl: claimRelayUrl,
                startedAt: new Date().toISOString(),
            }),
    });

    clearPairingStatus(statusPath);

    if ("error" in result) {
        logError(`Pairing failed: ${result.error}. Set PIZZAPI_API_KEY manually, or retry.`);
        return 1;
    }

    saveConfigAt(agentDir, { apiKey: result.apiKey, relayUrl: result.relayUrl });
    process.env.PIZZAPI_API_KEY = result.apiKey;
    process.env.PIZZAPI_RELAY_URL = result.relayUrl;
    logInfo(`paired — API key saved to ${join(agentDir, "config.json")}. Starting runner…`);
    return null;
}
