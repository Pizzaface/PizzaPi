import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { getDisableSignupAfterFirstUser, isSignupAllowed, getKysely, initAuth } from "./auth";
import { sql } from "kysely";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// Use a temp directory so the test is portable (CI runners have read-only working dirs)
const tmpDir = mkdtempSync(join(tmpdir(), "auth-test-"));
const tmpDbPath = join(tmpDir, "test.db");

// Initialize auth with the temp DB before any tests run
beforeAll(async () => {
    initAuth({ dbPath: tmpDbPath });

    // Ensure the user table exists for testing (better-auth normally creates it via migrations)
    await sql`
        CREATE TABLE IF NOT EXISTS user (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            email TEXT NOT NULL UNIQUE,
            emailVerified INTEGER NOT NULL DEFAULT 0,
            image TEXT,
            createdAt TEXT NOT NULL,
            updatedAt TEXT NOT NULL
        )
    `.execute(getKysely());
});

afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
});

describe("signup gating", () => {
    test("disableSignupAfterFirstUser defaults to true", () => {
        // The env var PIZZAPI_DISABLE_SIGNUP_AFTER_FIRST_USER is not set in
        // the test environment, so it should fall back to the default (true).
        expect(getDisableSignupAfterFirstUser()).toBe(true);
    });

    test("isSignupAllowed returns true when no users exist", async () => {
        // Clean the table for a deterministic test
        await getKysely().deleteFrom("user").execute();

        const allowed = await isSignupAllowed();
        expect(allowed).toBe(true);
    });

    test("isSignupAllowed returns false when users exist", async () => {
        // Insert a test user
        await getKysely().deleteFrom("user").execute();
        const now = new Date().toISOString();
        await getKysely()
            .insertInto("user")
            .values({
                id: "test-user-1",
                name: "Test User",
                email: "test@example.com",
                emailVerified: 0,
                image: null,
                createdAt: now,
                updatedAt: now,
            })
            .execute();

        const allowed = await isSignupAllowed();
        expect(allowed).toBe(false);

        // Clean up
        await getKysely().deleteFrom("user").execute();
    });
});
