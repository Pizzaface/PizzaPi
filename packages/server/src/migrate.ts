import { getMigrations } from "better-auth/db";
import { auth } from "./auth.js";
import { ensureRelaySessionTables } from "./sessions/store.js";

const { runMigrations } = await getMigrations(auth.options);
await runMigrations();
await ensureRelaySessionTables();
console.log("better-auth + relay session schema migration complete.");
