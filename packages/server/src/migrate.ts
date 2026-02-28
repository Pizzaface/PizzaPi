import { getMigrations } from "better-auth/db";
import { auth } from "./auth.js";
import { ensureRelaySessionTables } from "./sessions/store.js";
import { ensurePushSubscriptionTable } from "./push.js";
import { ensureRunnerRecentFoldersTable } from "./runner-recent-folders.js";
import { ensureUserHiddenModelTable } from "./user-hidden-models.js";

const { runMigrations } = await getMigrations(auth.options);
await runMigrations();
await ensureRelaySessionTables();
await ensurePushSubscriptionTable();
await ensureRunnerRecentFoldersTable();
await ensureUserHiddenModelTable();
console.log("better-auth + relay session + push + runner-recent-folders + user-hidden-models schema migration complete.");
