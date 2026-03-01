import { getMigrations } from "better-auth/db";
import { getAuth } from "./auth.js";
import { ensureRelaySessionTables } from "./sessions/store.js";
import { ensurePushSubscriptionTable } from "./push.js";
import { ensureRunnerRecentFoldersTable } from "./runner-recent-folders.js";
import { ensureUserHiddenModelTable } from "./user-hidden-models.js";

/**
 * Run all database migrations (better-auth + custom tables).
 * Idempotent — safe to call on every server boot.
 */
export async function runAllMigrations(): Promise<void> {
    try {
        const { runMigrations } = await getMigrations(getAuth().options);
        await runMigrations();
        await ensureRelaySessionTables();
        await ensurePushSubscriptionTable();
        await ensureUserHiddenModelTable();
        await ensureRunnerRecentFoldersTable();
        console.log("[startup] All database migrations complete.");
    } catch (e) {
        console.error("[startup] Migration failed:", e);
        process.exit(1);
    }
}
