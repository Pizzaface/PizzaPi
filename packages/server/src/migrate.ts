import { getMigrations } from "better-auth/db";
import { auth } from "./auth.js";
import { ensureRelaySessionTables } from "./sessions/store.js";
import { ensurePushSubscriptionTable } from "./push.js";
import { ensureRunnerRecentFoldersTable } from "./runner-recent-folders.js";

const { runMigrations } = await getMigrations(auth.options);
await runMigrations();
await ensureRelaySessionTables();
await ensurePushSubscriptionTable();
await ensureRunnerRecentFoldersTable();
console.log("better-auth + relay session + push + runner-recent-folders schema migration complete.");
