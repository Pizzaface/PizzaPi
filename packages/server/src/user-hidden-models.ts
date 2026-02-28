import { kysely } from "./auth.js";

export async function ensureUserHiddenModelTable(): Promise<void> {
    await kysely.schema
        .createTable("user_hidden_model")
        .ifNotExists()
        .addColumn("id", "text", (col) => col.primaryKey())
        .addColumn("userId", "text", (col) => col.notNull())
        .addColumn("modelKey", "text", (col) => col.notNull())
        .addColumn("createdAt", "text", (col) => col.notNull())
        .execute();

    await kysely.schema
        .createIndex("user_hidden_model_user_idx")
        .ifNotExists()
        .on("user_hidden_model")
        .columns(["userId"])
        .execute();

    // Unique constraint: one entry per (userId, modelKey)
    await kysely.schema
        .createIndex("user_hidden_model_unique_idx")
        .ifNotExists()
        .unique()
        .on("user_hidden_model")
        .columns(["userId", "modelKey"])
        .execute();
}

/** Get all hidden model keys for a user. Returns keys like "provider/modelId". */
export async function getHiddenModels(userId: string): Promise<string[]> {
    const rows = await kysely
        .selectFrom("user_hidden_model")
        .select("modelKey")
        .where("userId", "=", userId)
        .orderBy("modelKey", "asc")
        .execute();

    return rows.map((r) => r.modelKey);
}

/**
 * Replace the full set of hidden models for a user.
 * Accepts an array of model keys like "provider/modelId".
 */
export async function setHiddenModels(userId: string, modelKeys: string[]): Promise<void> {
    const nowIso = new Date().toISOString();

    // Deduplicate and normalize
    const uniqueKeys = [...new Set(modelKeys.map((k) => k.trim()).filter(Boolean))];

    // Delete all existing hidden models for the user
    await kysely
        .deleteFrom("user_hidden_model")
        .where("userId", "=", userId)
        .execute();

    // Insert new entries
    if (uniqueKeys.length > 0) {
        await kysely
            .insertInto("user_hidden_model")
            .values(
                uniqueKeys.map((modelKey) => ({
                    id: crypto.randomUUID(),
                    userId,
                    modelKey,
                    createdAt: nowIso,
                }))
            )
            .execute();
    }
}
