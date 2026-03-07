import { describe, expect, it } from "bun:test";

/**
 * Regression test: verify runAllMigrations exits the process on failure.
 * 
 * The migrations module catches errors and calls process.exit(1) to fail fast
 * during startup rather than leaving the server in an inconsistent state.
 * This test verifies that behavior remains intact.
 */
describe("migrations", () => {
    it("should call process.exit(1) on migration failure", async () => {
        // We verify the code structure statically:
        // The migrations.ts file contains a try/catch that calls process.exit(1)
        const migrationsSource = await Bun.file(
            new URL("../src/migrations.ts", import.meta.url).pathname
        ).text();

        // Verify the critical code pattern exists
        expect(migrationsSource).toContain("process.exit(1)");
        expect(migrationsSource).toContain("catch (e)");
        expect(migrationsSource).toContain("[startup] Migration failed:");

        // Verify the structure: catch block should contain the exit call
        const catchMatch = migrationsSource.match(/catch\s*\([^)]*\)\s*\{[^}]*process\.exit\(1\)/s);
        expect(catchMatch).not.toBeNull();
    });

    it("should have proper error handling structure", async () => {
        const migrationsSource = await Bun.file(
            new URL("../src/migrations.ts", import.meta.url).pathname
        ).text();

        // Verify the function is async (so errors are caught)
        expect(migrationsSource).toContain("async function runAllMigrations");
        
        // Verify try block wraps the migrations
        expect(migrationsSource).toContain("try {");
        expect(migrationsSource).toContain("await runMigrations()");
    });
});
