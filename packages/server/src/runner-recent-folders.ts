import { sql } from "kysely";
import { getKysely } from "./auth.js";

const MAX_RECENT_FOLDERS = 50;

export async function ensureRunnerRecentFoldersTable(): Promise<void> {
    await getKysely().schema
        .createTable("runner_recent_folder")
        .ifNotExists()
        .addColumn("id", "text", (col) => col.primaryKey())
        .addColumn("userId", "text", (col) => col.notNull())
        .addColumn("runnerId", "text", (col) => col.notNull())
        .addColumn("path", "text", (col) => col.notNull())
        .addColumn("lastUsedAt", "text", (col) => col.notNull())
        .addColumn("usageCount", "integer", (col) => col.notNull().defaultTo(1))
        .execute();

    // Existing installations need the new counter without a destructive migration.
    try {
        await getKysely().schema.alterTable("runner_recent_folder")
            .addColumn("usageCount", "integer", (col) => col.notNull().defaultTo(1))
            .execute();
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();
        if (!message.includes("duplicate column name") || !message.includes("usagecount")) {
            throw err;
        }
        // Column already exists.
    }

    await getKysely().schema
        .createIndex("runner_recent_folder_user_runner_idx")
        .ifNotExists()
        .on("runner_recent_folder")
        .columns(["userId", "runnerId", "lastUsedAt"])
        .execute();

    // Existing installations may already have duplicate (userId, runnerId,
    // path) rows from the old select-then-insert race; merge them before
    // adding the unique index below, or the index creation fails outright.
    await mergeDuplicateFolderRows();

    // Unique index backs the atomic upsert in recordRecentFolder() below —
    // without it, concurrent recordRecentFolder() calls for the same triple
    // can both miss the pre-existing row and insert duplicates, splitting
    // usage counts and eating entries in the MAX_RECENT_FOLDERS cap.
    await getKysely().schema
        .createIndex("runner_recent_folder_user_runner_path_uidx")
        .unique()
        .ifNotExists()
        .on("runner_recent_folder")
        .columns(["userId", "runnerId", "path"])
        .execute();
}

/**
 * Retry a SQLite write on SQLITE_BUSY-family errors (lock contention, or a
 * stale read snapshot losing a race to a concurrent writer). PRAGMA
 * busy_timeout already waits out plain lock contention at the driver level;
 * this covers the case where that wait still ends in an error (e.g. two
 * server processes running this migration at the same moment).
 */
async function withBusyRetry<T>(fn: () => Promise<T>, attempts = 5): Promise<T> {
    for (let attempt = 1; ; attempt++) {
        try {
            return await fn();
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            if (attempt >= attempts || !/busy|locked/i.test(message)) throw err;
            await new Promise((r) => setTimeout(r, 20 * attempt));
        }
    }
}

/**
 * Collapse pre-existing duplicate (userId, runnerId, path) rows into one.
 *
 * Reads + the merged UPDATE + the duplicate DELETE all happen inside a single
 * transaction. Without that, a crash (or a second server process running this
 * same migration concurrently) could commit the UPDATE without the DELETE,
 * leaving both the merged row and its not-yet-removed duplicate behind —
 * re-running the merge would then sum them again (2 + 3 -> 5, then 5 + 3 -> 8
 * on the next restart). Wrapping it keeps each group's merge atomic and
 * idempotent: a crash mid-way rolls back to the pre-merge state instead of
 * leaving a half-applied one.
 */
export async function mergeDuplicateFolderRows(): Promise<void> {
    await withBusyRetry(() =>
        getKysely().transaction().execute(async (trx) => {
            const dupGroups = await trx
                .selectFrom("runner_recent_folder")
                .select(["userId", "runnerId", "path"])
                .groupBy(["userId", "runnerId", "path"])
                .having((eb) => eb.fn.count("id"), ">", 1)
                .execute();

            for (const group of dupGroups) {
                const rows = await trx
                    .selectFrom("runner_recent_folder")
                    .select(["id", "lastUsedAt", "usageCount"])
                    .where("userId", "=", group.userId)
                    .where("runnerId", "=", group.runnerId)
                    .where("path", "=", group.path)
                    .orderBy("id", "asc")
                    .execute();
                if (rows.length < 2) continue;

                const [keep, ...rest] = rows;
                const mergedUsageCount = rows.reduce((sum, r) => sum + r.usageCount, 0);
                const mergedLastUsedAt = rows.reduce(
                    (max, r) => (r.lastUsedAt > max ? r.lastUsedAt : max),
                    keep.lastUsedAt,
                );

                await trx
                    .updateTable("runner_recent_folder")
                    .set({ usageCount: mergedUsageCount, lastUsedAt: mergedLastUsedAt })
                    .where("id", "=", keep.id)
                    .execute();
                await trx
                    .deleteFrom("runner_recent_folder")
                    .where("id", "in", rest.map((r) => r.id))
                    .execute();
            }
        }),
    );
}

export async function recordRecentFolder(
    userId: string,
    runnerId: string,
    path: string,
): Promise<void> {
    const normalizedPath = path.trim();
    if (!normalizedPath) return;

    const nowIso = new Date().toISOString();

    // Atomic upsert: the unique index on (userId, runnerId, path) makes this
    // a single statement instead of select-then-insert, so concurrent calls
    // for the same triple can never both miss the existing row and insert a
    // duplicate.
    await getKysely()
        .insertInto("runner_recent_folder")
        .values({
            id: crypto.randomUUID(),
            userId,
            runnerId,
            path: normalizedPath,
            lastUsedAt: nowIso,
            usageCount: 1,
        })
        .onConflict((oc) =>
            oc.columns(["userId", "runnerId", "path"]).doUpdateSet({
                lastUsedAt: nowIso,
                usageCount: sql`usageCount + 1`,
            }),
        )
        .execute();

    // Prune oldest entries beyond the cap for this (userId, runnerId) pair.
    const all = await getKysely()
        .selectFrom("runner_recent_folder")
        .select(["id", "lastUsedAt", "usageCount"])
        .where("userId", "=", userId)
        .where("runnerId", "=", runnerId)
        .orderBy("usageCount", "desc")
        .orderBy("lastUsedAt", "desc")
        // id tie-break: ISO-ms timestamps collide when writes are fast (WAL) 2014
        // without this, which tied row survives pruning is arbitrary.
        .orderBy("id", "desc")
        .execute();

    if (all.length > MAX_RECENT_FOLDERS) {
        const toDelete = all.slice(MAX_RECENT_FOLDERS).map((r) => r.id);
        await getKysely()
            .deleteFrom("runner_recent_folder")
            .where("id", "in", toDelete)
            .execute();
    }
}

export async function deleteRecentFolder(
    userId: string,
    runnerId: string,
    path: string,
): Promise<boolean> {
    const normalizedPath = path.trim();
    if (!normalizedPath) return false;

    const result = await getKysely()
        .deleteFrom("runner_recent_folder")
        .where("userId", "=", userId)
        .where("runnerId", "=", runnerId)
        .where("path", "=", normalizedPath)
        .executeTakeFirst();

    return (result.numDeletedRows ?? 0n) > 0n;
}

export async function getRecentFolders(
    userId: string,
    runnerId: string,
): Promise<string[]> {
    const rows = await getKysely()
        .selectFrom("runner_recent_folder")
        .select("path")
        .where("userId", "=", userId)
        .where("runnerId", "=", runnerId)
        .orderBy("usageCount", "desc")
        .orderBy("lastUsedAt", "desc")
        // id tie-break: ISO-ms timestamps collide when writes are fast (WAL) 2014
        // without this, which tied row survives pruning is arbitrary.
        .orderBy("id", "desc")
        .limit(MAX_RECENT_FOLDERS)
        .execute();

    return rows.map((r) => r.path);
}
