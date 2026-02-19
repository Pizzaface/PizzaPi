import { getMigrations } from "better-auth/db";
import { auth } from "./auth.js";

const { runMigrations } = await getMigrations(auth.options);
await runMigrations();
console.log("better-auth schema migration complete.");
