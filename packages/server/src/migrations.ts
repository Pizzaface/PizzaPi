import { getMigrations } from "better-auth/db";
import { getAuth } from "./auth.js";
import { ensureRelaySessionTables } from "./sessions/store.js";
import { ensurePushSubscriptionTable } from "./push.js";
import { ensureRunnerRecentFoldersTable } from "./runner-recent-folders.js";
import { ensureUserHiddenModelTable } from "./user-hidden-models.js";
import { ensureExtractedAttachmentTable } from "./attachments/store.js";
import { createLogger } from "@pizzapi/tools";

const log = createLogger("startup");

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
        await ensureExtractedAttachmentTable();
        log.info("All database migrations complete.");
    } catch (e) {
        log.error("Migration failed:", e);
        process.exit(1);
    }
}
