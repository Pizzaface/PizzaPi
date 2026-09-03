/**
 * Durable runner ownership (runnerId → userId).
 *
 * Runner state lives in Redis with a TTL and is deleted on disconnect —
 * which made spawn routes and session routes referencing an offline runner
 * impossible to manage (ownership "unresolvable" → 404 on DELETE). This tiny
 * SQLite record is the durable fallback: recorded at every successful
 * registration, read when live runner state is gone.
 */

import { getKysely } from "./auth.js";
import { createLogger } from "@pizzapi/tools";

const log = createLogger("runner-owner");
const TABLE = "runner_owner" as const;

export async function ensureRunnerOwnerTable(): Promise<void> {
    await getKysely().schema
        .createTable(TABLE)
        .ifNotExists()
        .addColumn("runnerId", "text", (col) => col.primaryKey())
        .addColumn("userId", "text", (col) => col.notNull())
        .addColumn("updatedAt", "text", (col) => col.notNull())
        .execute();
    // Liveness for dead-runner cleanup: refreshed on every registration.
    try {
        await getKysely().schema.alterTable(TABLE).addColumn("lastSeenAt", "text").execute();
    } catch {
        // Column already exists on upgraded databases.
    }
}

/** Refresh the runner's liveness stamp (every registration/reconnect). Best-effort. */
export async function touchRunnerSeen(runnerId: string): Promise<void> {
    try {
        await getKysely()
            .updateTable(TABLE)
            .set({ lastSeenAt: new Date().toISOString() })
            .where("runnerId", "=", runnerId)
            .execute();
    } catch (err) {
        log.warn(`Failed to touch lastSeenAt for runner ${runnerId}:`, err);
    }
}

export interface RunnerOwnerRow {
    runnerId: string;
    userId: string;
    lastSeenAt: string | null;
}

/** Every durable runner record (dead-runner sweep input). */
export async function listRunnerOwners(): Promise<RunnerOwnerRow[]> {
    try {
        return await getKysely().selectFrom(TABLE).select(["runnerId", "userId", "lastSeenAt"]).execute();
    } catch (err) {
        log.error("runner_owner list failed:", err);
        return [];
    }
}

/** Last registration time; null when never stamped. */
export async function getRunnerLastSeen(runnerId: string): Promise<string | null> {
    const row = await getKysely()
        .selectFrom(TABLE)
        .select("lastSeenAt")
        .where("runnerId", "=", runnerId)
        .executeTakeFirst()
        .catch(() => undefined);
    return row?.lastSeenAt ?? null;
}

/** Upsert the durable owner. Best-effort: a record failure must never fail registration. */
export async function rememberRunnerOwner(runnerId: string, userId: string | null | undefined): Promise<void> {
    if (!userId) return;
    try {
        const nowIso = new Date().toISOString();
        await getKysely()
            .insertInto(TABLE)
            .values({ runnerId, userId, updatedAt: nowIso, lastSeenAt: nowIso })
            .onConflict((oc) => oc.column("runnerId").doUpdateSet({ userId, updatedAt: nowIso, lastSeenAt: nowIso }))
            .execute();
    } catch (err) {
        log.warn(`Failed to record runner owner for ${runnerId}:`, err);
    }
}

/** Durable owner lookup; null when the runner never registered since this table landed. */
export async function getRunnerOwner(runnerId: string): Promise<string | null> {
    const row = await getKysely()
        .selectFrom(TABLE)
        .select("userId")
        .where("runnerId", "=", runnerId)
        .executeTakeFirst()
        .catch((err: unknown) => {
            log.error("runner_owner lookup failed:", err);
            return undefined;
        });
    return row?.userId ?? null;
}