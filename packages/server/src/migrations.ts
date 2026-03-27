import { getMigrations } from "better-auth/db";
import { getAuth } from "./auth.js";
import { ensureRelaySessionTables } from "./sessions/store.js";
import { ensurePushSubscriptionTable } from "./push.js";
import { ensureRunnerRecentFoldersTable } from "./runner-recent-folders.js";
import { ensureUserHiddenModelTable } from "./user-hidden-models.js";
import { ensureExtractedAttachmentTable } from "./attachments/store.js";
import { createLogger } from "@pizzapi/tools";

const log = createLogger("startup");

type BetterAuthMigrationPlan = {
    toBeCreated: Array<{ table: string }>;
    toBeAdded: Array<{ table: string; fields: Record<string, unknown> }>;
};

export function summarizePendingBetterAuthMigrations(plan: BetterAuthMigrationPlan): {
    hasPending: boolean;
    tablesToCreate: number;
    fieldsToAdd: number;
} {
    const tablesToCreate = plan.toBeCreated.length;
    const fieldsToAdd = plan.toBeAdded.reduce((count, tablePatch) => {
        return count + Object.keys(tablePatch.fields).length;
    }, 0);

    return {
        hasPending: tablesToCreate > 0 || fieldsToAdd > 0,
        tablesToCreate,
        fieldsToAdd,
    };
}

/**
 * Run all database migrations (better-auth + custom tables).
 * Idempotent — safe to call on every server boot.
 */
export async function runAllMigrations(): Promise<void> {
    try {
        const migrationPlan = await getMigrations(getAuth().options);
        const { runMigrations } = migrationPlan;

        const summary = summarizePendingBetterAuthMigrations(migrationPlan);
        if (summary.hasPending) {
            log.warn(
                `Database schema is behind: ${summary.tablesToCreate} table(s) to create, ${summary.fieldsToAdd} field(s) to add. Applying migrations now.`,
            );
        }

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
