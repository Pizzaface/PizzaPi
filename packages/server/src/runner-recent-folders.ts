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
    // path) rows from the old select-then-insert race; merge them and create
    // the unique index that backs recordRecentFolder()'s atomic upsert below
    // (both inside mergeDuplicateFolderRows() — see its docs for why they
    // must share one transaction).
    await mergeDuplicateFolderRows();
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
 * Collapse pre-existing duplicate (userId, runnerId, path) rows into one, AND
 * create the unique index that backs recordRecentFolder()'s atomic upsert —
 * both inside the SAME transaction.
 *
 * They must share one transaction: during a rolling upgrade, an older relay
 * node can still be running the pre-fix select-then-insert recordRecentFolder()
 * path. If the dedupe committed on its own and the CREATE UNIQUE INDEX ran as
 * a separate later statement (as this used to), that older node's insert
 * could land a fresh duplicate in the gap between them — the CREATE UNIQUE
 * INDEX then fails outright with "UNIQUE constraint failed" and the server
 * never finishes starting up (confirmed with an isolated SQLite interleaving
 * probe).
 *
 * Kysely's Bun SQLite dialect always issues a plain `begin` (deferred) for
 * `.transaction().execute()` — there's no isolation-level knob to ask for
 * more. A deferred transaction takes NO lock until its first write, so a
 * dupGroups SELECT that happens to find nothing to merge would run entirely
 * lock-free right up to the CREATE INDEX, leaving the exact same race even
 * with both statements nominally "in one transaction". We open the
 * transaction with raw `BEGIN IMMEDIATE` instead so the write lock is taken
 * up front, before the dupGroups SELECT ever runs — any concurrent writer
 * blocks on it (via PRAGMA busy_timeout) until we COMMIT or ROLLBACK.
 *
 * A crash (or lock contention that ends in SQLITE_BUSY after busy_timeout)
 * rolls the whole thing back and withBusyRetry() retries from a fresh BEGIN
 * IMMEDIATE — a crash can never leave the merged UPDATE committed without
 * its DELETE (re-running the merge would otherwise sum the surviving row
 * again: 2 + 3 -> 5, then 5 + 3 -> 8 on the next restart), and can never
 * leave a half-deduped table with the unique index already created.
 */
export async function mergeDuplicateFolderRows(): Promise<void> {
    await withBusyRetry(async () => {
        const db = getKysely();
        await sql`BEGIN IMMEDIATE`.execute(db);
        try {
            const dupGroups = await db
                .selectFrom("runner_recent_folder")
                .select(["userId", "runnerId", "path"])
                .groupBy(["userId", "runnerId", "path"])
                .having((eb) => eb.fn.count("id"), ">", 1)
                .execute();

            for (const group of dupGroups) {
                const rows = await db
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

                await db
                    .updateTable("runner_recent_folder")
                    .set({ usageCount: mergedUsageCount, lastUsedAt: mergedLastUsedAt })
                    .where("id", "=", keep.id)
                    .execute();
                await db
                    .deleteFrom("runner_recent_folder")
                    .where("id", "in", rest.map((r) => r.id))
                    .execute();
            }

            // Safe now: no (userId, runnerId, path) duplicates can exist, and
            // the write lock held since BEGIN IMMEDIATE means no concurrent
            // process could have inserted a fresh one since.
            await db.schema
                .createIndex("runner_recent_folder_user_runner_path_uidx")
                .unique()
                .ifNotExists()
                .on("runner_recent_folder")
                .columns(["userId", "runnerId", "path"])
                .execute();

            await sql`COMMIT`.execute(db);
        } catch (err) {
            await sql`ROLLBACK`.execute(db).catch(() => {});
            throw err;
        }
    });
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
