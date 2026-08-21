/**
 * Setup claim persistence.
 *
 * A "setup claim" is a short-lived token created by an unauthenticated CLI
 * during first-run setup. An authenticated browser/phone scans the QR and
 * approves the claim, which attaches a freshly created API key. The CLI polls
 * and redeems the claim to get the key.
 *
 * Security notes:
 * - Tokens are 32-byte random hex strings, single-use, and expire after 10 min.
 * - The plain API key is stored only while the claim is in `approved` status.
 *   Redemption clears the `apiKey` column atomically in the same UPDATE that
 *   marks the claim `redeemed`, so the key never persists after one-shot use.
 * - Approval requires a valid better-auth session.
 */

import { getKysely, type SetupClaimTable } from "./auth.js";
import { mintEphemeralApiKey } from "./routes/utils.js";
import { createLogger } from "@pizzapi/tools";

const log = createLogger("setup-claims");

const DEFAULT_CLAIM_TTL_MS = 10 * 60 * 1000;
// A setup claim mints a key for a persistent CLI node, so a long TTL is fine.
// Minting goes through mintEphemeralApiKey so rate-limit config is applied
// (the old inline insert hard-coded rateLimitEnabled: 0 and expiresAt: null,
// which let a leaked key escalate to a permanent, un-rate-limited one).
const SETUP_CLAIM_API_KEY_TTL_SECONDS = 365 * 24 * 60 * 60;

export type { SetupClaimTable };

export async function ensureSetupClaimsTable(): Promise<void> {
    await getKysely().schema
        .createTable("setup_claim")
        .ifNotExists()
        .addColumn("id", "text", (col) => col.primaryKey())
        .addColumn("status", "text", (col) => col.notNull())
        .addColumn("relayUrl", "text", (col) => col.notNull())
        .addColumn("apiKey", "text")
        .addColumn("userId", "text")
        .addColumn("userName", "text")
        .addColumn("createdAt", "text", (col) => col.notNull())
        .addColumn("expiresAt", "text", (col) => col.notNull())
        .addColumn("approvedAt", "text")
        .addColumn("redeemedAt", "text")
        .execute();

    // Migration: add label column for naming the runner/device being paired
    // (older rows/deployments simply have a null label).
    try {
        await getKysely().schema.alterTable("setup_claim").addColumn("label", "text").execute();
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes("duplicate column name")) {
            throw err;
        }
    }
}

function claimExpiry(): string {
    return new Date(Date.now() + DEFAULT_CLAIM_TTL_MS).toISOString();
}

function generateToken(): string {
    return crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
}

const LABEL_MAX_LENGTH = 64;
// Letters, digits, space, dash, underscore, dot. Rendered as text in the web UI
// and folded into a minted API key name, so nothing else survives.
const LABEL_SAFE_CHARS = /[^a-zA-Z0-9 _.-]/g;

/** Sanitize an attacker-controlled label: trim, strip unsafe chars, cap length. */
function sanitizeLabel(label: unknown): string | null {
    if (typeof label !== "string") return null;
    const cleaned = label.trim().replace(LABEL_SAFE_CHARS, "").slice(0, LABEL_MAX_LENGTH).trim();
    return cleaned || null;
}

export async function createSetupClaim(
    relayUrl: string,
    label?: string | null,
): Promise<{ token: string; expiresAt: string }> {
    const token = generateToken();
    const now = new Date().toISOString();
    const expiresAt = claimExpiry();
    await getKysely()
        .insertInto("setup_claim")
        .values({
            id: token,
            status: "pending",
            relayUrl,
            apiKey: null,
            userId: null,
            userName: null,
            createdAt: now,
            expiresAt,
            approvedAt: null,
            redeemedAt: null,
            label: sanitizeLabel(label),
        })
        .execute();
    return { token, expiresAt };
}

export interface SetupClaimStatus {
    status: SetupClaimTable["status"];
    relayUrl: string;
    apiKey?: string;
    label?: string;
}

/**
 * Poll a pending claim. Returns the API key exactly once (the first time the
 * approved claim is polled), after which the claim is marked redeemed.
 */
export async function pollSetupClaim(token: string): Promise<SetupClaimStatus | null> {
    const row = await getKysely()
        .selectFrom("setup_claim")
        .selectAll()
        .where("id", "=", token)
        .executeTakeFirst();

    if (!row) return null;

    if (new Date(row.expiresAt) < new Date()) {
        if (row.status !== "expired") {
            await getKysely()
                .updateTable("setup_claim")
                .set({ status: "expired" })
                .where("id", "=", token)
                .execute();
        }
        return { status: "expired", relayUrl: row.relayUrl, label: row.label ?? undefined };
    }

    if (row.status === "approved" && row.apiKey) {
        // One-shot redeem: flip status AND clear the stored key in the same
        // atomic UPDATE, guarded on the still-approved status so a concurrent
        // second poll loses the race instead of re-serving the key.
        const result = await getKysely()
            .updateTable("setup_claim")
            .set({ status: "redeemed", redeemedAt: new Date().toISOString(), apiKey: null })
            .where("id", "=", token)
            .where("status", "=", "approved")
            .execute();
        if (Number(result[0]?.numUpdatedRows ?? 0) === 0) {
            // Lost the race (or claim expired mid-flight): re-read and report
            // the current status — never serve the key twice.
            const current = await getKysely()
                .selectFrom("setup_claim")
                .select(["status", "relayUrl", "label"])
                .where("id", "=", token)
                .executeTakeFirst();
            if (!current) return null;
            return { status: current.status, relayUrl: current.relayUrl, label: current.label ?? undefined };
        }
        return { status: "approved", relayUrl: row.relayUrl, apiKey: row.apiKey, label: row.label ?? undefined };
    }

    return { status: row.status, relayUrl: row.relayUrl, label: row.label ?? undefined };
}

export interface SetupClaimInfo {
    status: SetupClaimTable["status"] | "expired";
    label?: string;
}

/**
 * Non-consuming read of a claim's status/label, for the web approval UI to
 * show "what am I approving" before the user clicks. Unlike `pollSetupClaim`
 * (the CLI's one-shot redeem), this NEVER mutates the row and NEVER returns
 * the API key — it's safe to call any number of times, including after the
 * claim has been approved, without disturbing the CLI's pending redemption.
 */
export async function getSetupClaimInfo(token: string): Promise<SetupClaimInfo | null> {
    const row = await getKysely()
        .selectFrom("setup_claim")
        .select(["status", "expiresAt", "label"])
        .where("id", "=", token)
        .executeTakeFirst();

    if (!row) return null;

    const expired = row.status !== "redeemed" && new Date(row.expiresAt) < new Date();
    return { status: expired ? "expired" : row.status, label: row.label ?? undefined };
}

/**
 * Approve a pending claim. Creates an API key for the approving user and stores
 * it on the claim so the polling CLI can redeem it.
 *
 * Returns `null` when the claim does not exist or is no longer pending.
 */
export async function approveSetupClaim(
    token: string,
    userId: string,
    userName: string,
    maxTtlSeconds?: number | null,
): Promise<{ ok: true; apiKey: string } | null> {
    const row = await getKysely()
        .selectFrom("setup_claim")
        .selectAll()
        .where("id", "=", token)
        .executeTakeFirst();

    if (!row) return null;
    if (row.status !== "pending") return null;
    if (new Date(row.expiresAt) < new Date()) return null;

    // Never let the CLI key outlive the credential that approved it.
    const ttl = maxTtlSeconds == null
        ? SETUP_CLAIM_API_KEY_TTL_SECONDS
        : Math.min(SETUP_CLAIM_API_KEY_TTL_SECONDS, maxTtlSeconds);
    const keyName = row.label ? `runner-${row.label}`.slice(0, LABEL_MAX_LENGTH + 7) : `setup-claim-${token.slice(0, 8)}`;
    const apiKey = await mintEphemeralApiKey(userId, keyName, ttl);

    await getKysely()
        .updateTable("setup_claim")
        .set({
            status: "approved",
            apiKey,
            userId,
            userName,
            approvedAt: new Date().toISOString(),
        })
        .where("id", "=", token)
        .execute();

    return { ok: true, apiKey };
}

/**
 * Delete expired setup claims. Safe to call periodically; mostly used by tests
 * and future sweeps.
 */
export async function sweepExpiredSetupClaims(): Promise<number> {
    const now = new Date().toISOString();
    const result = await getKysely()
        .deleteFrom("setup_claim")
        .where("expiresAt", "<", now)
        .execute();
    return Number(result[0]?.numDeletedRows ?? 0);
}
