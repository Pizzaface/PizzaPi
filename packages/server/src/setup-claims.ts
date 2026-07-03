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
 *   Once the CLI redeems it, the claim moves to `redeemed` and no longer
 *   exposes the key.
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
}

function claimExpiry(): string {
    return new Date(Date.now() + DEFAULT_CLAIM_TTL_MS).toISOString();
}

function generateToken(): string {
    return crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
}

export async function createSetupClaim(relayUrl: string): Promise<{ token: string; expiresAt: string }> {
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
        })
        .execute();
    return { token, expiresAt };
}

export interface SetupClaimStatus {
    status: SetupClaimTable["status"];
    relayUrl: string;
    apiKey?: string;
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
        return { status: "expired", relayUrl: row.relayUrl };
    }

    if (row.status === "approved" && row.apiKey) {
        await getKysely()
            .updateTable("setup_claim")
            .set({ status: "redeemed", redeemedAt: new Date().toISOString() })
            .where("id", "=", token)
            .execute();
        return { status: "approved", relayUrl: row.relayUrl, apiKey: row.apiKey };
    }

    return { status: row.status, relayUrl: row.relayUrl };
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
    const apiKey = await mintEphemeralApiKey(userId, `setup-claim-${token.slice(0, 8)}`, ttl);

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
