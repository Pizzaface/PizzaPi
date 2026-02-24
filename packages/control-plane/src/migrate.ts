import { getMigrations } from "better-auth/db";
import { Migrator, FileMigrationProvider } from "kysely";
import { auth, kysely } from "./auth.js";
import * as path from "path";
import { promises as fs } from "fs";

// 1. Run better-auth schema migrations
const { runMigrations } = await getMigrations(auth.options);
await runMigrations();
console.log("control-plane: better-auth schema migration complete.");

// 2. Run custom Kysely migrations
const migrator = new Migrator({
    db: kysely,
    provider: new FileMigrationProvider({
        fs,
        path,
        migrationFolder: path.resolve(import.meta.dir, "migrations"),
    }),
});

const { error, results } = await migrator.migrateToLatest();
results?.forEach((r) => {
    if (r.status === "Success") {
        console.log(`control-plane: migration "${r.migrationName}" applied.`);
    } else if (r.status === "Error") {
        console.error(`control-plane: migration "${r.migrationName}" failed.`);
    }
});
if (error) {
    console.error("control-plane: migration failed", error);
    process.exit(1);
}
console.log("control-plane: all migrations complete.");
