import { kysely } from "./auth.js";

const MAX_RECENT_FOLDERS = 10;

export async function ensureRunnerRecentFoldersTable(): Promise<void> {
    await kysely.schema
        .createTable("runner_recent_folder")
        .ifNotExists()
        .addColumn("id", "text", (col) => col.primaryKey())
        .addColumn("userId", "text", (col) => col.notNull())
        .addColumn("runnerId", "text", (col) => col.notNull())
        .addColumn("path", "text", (col) => col.notNull())
        .addColumn("lastUsedAt", "text", (col) => col.notNull())
        .execute();

    await kysely.schema
        .createIndex("runner_recent_folder_user_runner_idx")
        .ifNotExists()
        .on("runner_recent_folder")
        .columns(["userId", "runnerId", "lastUsedAt"])
        .execute();
}

export async function recordRecentFolder(
    userId: string,
    runnerId: string,
    path: string,
): Promise<void> {
    const normalizedPath = path.trim();
    if (!normalizedPath) return;

    const nowIso = new Date().toISOString();

    // Upsert: if this (userId, runnerId, path) triple already exists, just update lastUsedAt.
    const existing = await kysely
        .selectFrom("runner_recent_folder")
        .select("id")
        .where("userId", "=", userId)
        .where("runnerId", "=", runnerId)
        .where("path", "=", normalizedPath)
        .executeTakeFirst();

    if (existing) {
        await kysely
            .updateTable("runner_recent_folder")
            .set({ lastUsedAt: nowIso })
            .where("id", "=", existing.id)
            .execute();
        return;
    }

    // Insert new row.
    await kysely
        .insertInto("runner_recent_folder")
        .values({
            id: crypto.randomUUID(),
            userId,
            runnerId,
            path: normalizedPath,
            lastUsedAt: nowIso,
        })
        .execute();

    // Prune oldest entries beyond the cap for this (userId, runnerId) pair.
    const all = await kysely
        .selectFrom("runner_recent_folder")
        .select(["id", "lastUsedAt"])
        .where("userId", "=", userId)
        .where("runnerId", "=", runnerId)
        .orderBy("lastUsedAt", "desc")
        .execute();

    if (all.length > MAX_RECENT_FOLDERS) {
        const toDelete = all.slice(MAX_RECENT_FOLDERS).map((r) => r.id);
        await kysely
            .deleteFrom("runner_recent_folder")
            .where("id", "in", toDelete)
            .execute();
    }
}

export async function getRecentFolders(
    userId: string,
    runnerId: string,
): Promise<string[]> {
    const rows = await kysely
        .selectFrom("runner_recent_folder")
        .select("path")
        .where("userId", "=", userId)
        .where("runnerId", "=", runnerId)
        .orderBy("lastUsedAt", "desc")
        .limit(MAX_RECENT_FOLDERS)
        .execute();

    return rows.map((r) => r.path);
}
