import { createAuthContext } from "./auth.js";
import { runAllMigrations } from "./migrations.js";

await runAllMigrations(createAuthContext());
