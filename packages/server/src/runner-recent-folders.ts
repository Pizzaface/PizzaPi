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

/** Collapse pre-existing duplicate (userId, runnerId, path) rows into one. */
async function mergeDuplicateFolderRows(): Promise<void> {
    const dupGroups = await getKysely()
        .selectFrom("runner_recent_folder")
        .select(["userId", "runnerId", "path"])
        .groupBy(["userId", "runnerId", "path"])
        .having((eb) => eb.fn.count("id"), ">", 1)
        .execute();

    for (const group of dupGroups) {
        const rows = await getKysely()
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
        const mergedLastUsedAt = rows.reduce((max, r) => (r.lastUsedAt > max ? r.lastUsedAt : max), keep.lastUsedAt);

        await getKysely()
            .updateTable("runner_recent_folder")
            .set({ usageCount: mergedUsageCount, lastUsedAt: mergedLastUsedAt })
            .where("id", "=", keep.id)
            .execute();
        await getKysely()
            .deleteFrom("runner_recent_folder")
            .where("id", "in", rest.map((r) => r.id))
            .execute();
    }
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
