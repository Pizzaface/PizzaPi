import { getKysely, type MobileLinkTable } from "./auth.js";
import { mintEphemeralApiKey } from "./routes/utils.js";

const DEFAULT_MOBILE_LINK_TTL_MS = 10 * 60 * 1000;
// Mobile app API key lives as long as a typical remembered session. Short enough
// to be reissued if leaked, long enough that users aren't re-approving weekly.
const MOBILE_API_KEY_TTL_SECONDS = 90 * 24 * 60 * 60;

export type { MobileLinkTable };

export async function ensureMobileLinkTable(): Promise<void> {
    await getKysely().schema
        .createTable("mobile_link")
        .ifNotExists()
        .addColumn("id", "text", (col) => col.primaryKey())
        .addColumn("status", "text", (col) => col.notNull())
        .addColumn("relayUrl", "text", (col) => col.notNull())
        .addColumn("userId", "text", (col) => col.notNull())
        .addColumn("userName", "text")
        .addColumn("verificationToken", "text")
        .addColumn("deviceName", "text")
        .addColumn("scannedUrl", "text")
        .addColumn("createdAt", "text", (col) => col.notNull())
        .addColumn("expiresAt", "text", (col) => col.notNull())
        .addColumn("scannedAt", "text")
        .addColumn("approvedAt", "text")
        .execute();

    // Migration: add apiKey column for post-approval mobile app auth.
    try {
        await getKysely().schema.alterTable("mobile_link").addColumn("apiKey", "text").execute();
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes("duplicate column name")) {
            throw err;
        }
    }
}

function expiry(): string {
    return new Date(Date.now() + DEFAULT_MOBILE_LINK_TTL_MS).toISOString();
}

function token(): string {
    return crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
}

export interface MobileLinkStatus {
    id: string;
    status: MobileLinkTable["status"];
    relayUrl: string;
    verificationToken?: string;
    deviceName?: string;
    scannedUrl?: string;
    expiresAt: string;
    apiKey?: string;
}

function toStatus(row: MobileLinkTable): MobileLinkStatus {
    return {
        id: row.id,
        status: row.status,
        relayUrl: row.relayUrl,
        verificationToken: row.verificationToken ?? undefined,
        deviceName: row.deviceName ?? undefined,
        scannedUrl: row.scannedUrl ?? undefined,
        expiresAt: row.expiresAt,
    };
}

async function expireIfNeeded(row: MobileLinkTable): Promise<MobileLinkTable> {
    if (row.status !== "approved" && row.status !== "expired" && new Date(row.expiresAt) < new Date()) {
        await getKysely().updateTable("mobile_link").set({ status: "expired" }).where("id", "=", row.id).execute();
        return { ...row, status: "expired" };
    }
    return row;
}

export async function createMobileLink(relayUrl: string, userId: string, userName: string | null): Promise<MobileLinkStatus> {
    const id = token();
    const now = new Date().toISOString();
    const row: MobileLinkTable = {
        id,
        status: "pending",
        relayUrl,
        userId,
        userName,
        verificationToken: null,
        deviceName: null,
        scannedUrl: null,
        apiKey: null,
        createdAt: now,
        expiresAt: expiry(),
        scannedAt: null,
        approvedAt: null,
    };
    await getKysely().insertInto("mobile_link").values(row).execute();
    return toStatus(row);
}

export async function getMobileLink(id: string, userId?: string): Promise<MobileLinkStatus | null> {
    let query = getKysely().selectFrom("mobile_link").selectAll().where("id", "=", id);
    if (userId) query = query.where("userId", "=", userId);
    const row = await query.executeTakeFirst();
    if (!row) return null;
    return toStatus(await expireIfNeeded(row));
}

export async function scanMobileLink(
    id: string,
    input: { verificationToken: string; deviceName?: string; scannedUrl?: string },
): Promise<MobileLinkStatus | null> {
    const row = await getKysely().selectFrom("mobile_link").selectAll().where("id", "=", id).executeTakeFirst();
    if (!row) return null;
    const current = await expireIfNeeded(row);
    // Single-shot: only a pending link may be scanned. Once scanned, the
    // verification token is frozen so an attacker who learns the id cannot
    // re-scan (swapping deviceName/token) between the user's visual check and
    // their approve click.
    if (current.status !== "pending") return toStatus(current);

    const now = new Date().toISOString();
    await getKysely()
        .updateTable("mobile_link")
        .set({
            status: "scanned",
            verificationToken: input.verificationToken,
            deviceName: input.deviceName ?? null,
            scannedUrl: input.scannedUrl ?? null,
            scannedAt: now,
        })
        .where("id", "=", id)
        .execute();

    return getMobileLink(id);
}

export async function approveMobileLink(
    id: string,
    userId: string,
    expectedVerificationToken: string,
): Promise<MobileLinkStatus | null> {
    const row = await getKysely()
        .selectFrom("mobile_link")
        .selectAll()
        .where("id", "=", id)
        .where("userId", "=", userId)
        .executeTakeFirst();
    if (!row) return null;
    const current = await expireIfNeeded(row);
    if (current.status !== "scanned") return null;
    // Reject unless the approver confirmed the code that is currently stored.
    // This closes the TOCTOU window: if the stored token changed (or the caller
    // never saw it), approval fails instead of blessing an attacker's device.
    if (!current.verificationToken || current.verificationToken !== expectedVerificationToken) return null;

    const apiKey = await mintEphemeralApiKey(userId, `mobile-link-${id.slice(0, 8)}`, MOBILE_API_KEY_TTL_SECONDS);

    await getKysely()
        .updateTable("mobile_link")
        .set({ status: "approved", approvedAt: new Date().toISOString(), apiKey })
        .where("id", "=", id)
        .where("userId", "=", userId)
        .execute();

    return getMobileLink(id, userId);
}

/**
 * Redeem an approved mobile link for the API key. Returns the key exactly once,
 * then clears it from the claim so it cannot be leaked by later polls.
 */
export async function redeemMobileLink(id: string): Promise<MobileLinkStatus | null> {
    const row = await getKysely()
        .selectFrom("mobile_link")
        .selectAll()
        .where("id", "=", id)
        .executeTakeFirst();
    if (!row) return null;

    const current = await expireIfNeeded(row);
    if (current.status !== "approved") {
        return toStatus(current);
    }

    const status: MobileLinkStatus = {
        ...toStatus(current),
        apiKey: current.apiKey ?? undefined,
    };

    if (current.apiKey) {
        await getKysely()
            .updateTable("mobile_link")
            .set({ apiKey: null })
            .where("id", "=", id)
            .execute();
    }

    return status;
}

/** Delete expired mobile links. Safe to call periodically. */
export async function sweepExpiredMobileLinks(): Promise<number> {
    const now = new Date().toISOString();
    const result = await getKysely()
        .deleteFrom("mobile_link")
        .where("expiresAt", "<", now)
        .execute();
    return Number(result[0]?.numDeletedRows ?? 0);
}
