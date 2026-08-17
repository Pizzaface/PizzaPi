/**
 * Generic per-user preference store (key/value strings).
 *
 * First consumer: "subagent-model" — the default model for subagent/workflow
 * fan-out when an agent() call doesn't pin one. Kept generic so the next
 * one-line preference doesn't need another table.
 */
import { getKysely } from "./auth.js";

export async function ensureUserPreferenceTable(): Promise<void> {
    await getKysely().schema
        .createTable("user_preference")
        .ifNotExists()
        .addColumn("id", "text", (col) => col.primaryKey())
        .addColumn("userId", "text", (col) => col.notNull())
        .addColumn("key", "text", (col) => col.notNull())
        .addColumn("value", "text", (col) => col.notNull())
        .addColumn("updatedAt", "text", (col) => col.notNull())
        .execute();

    await getKysely().schema
        .createIndex("user_preference_unique_idx")
        .ifNotExists()
        .unique()
        .on("user_preference")
        .columns(["userId", "key"])
        .execute();
}

export async function getUserPreference(userId: string, key: string): Promise<string | null> {
    const row = await getKysely()
        .selectFrom("user_preference")
        .select("value")
        .where("userId", "=", userId)
        .where("key", "=", key)
        .executeTakeFirst();
    return row?.value ?? null;
}

/** Set a preference; null/empty deletes it. */
export async function setUserPreference(userId: string, key: string, value: string | null): Promise<void> {
    await getKysely()
        .deleteFrom("user_preference")
        .where("userId", "=", userId)
        .where("key", "=", key)
        .execute();
    if (value) {
        await getKysely()
            .insertInto("user_preference")
            .values({
                id: crypto.randomUUID(),
                userId,
                key,
                value,
                updatedAt: new Date().toISOString(),
            })
            .execute();
    }
}

/** Preference key for the subagent/workflow default model ("provider/id"). */
export const PREF_SUBAGENT_MODEL = "subagent-model";
