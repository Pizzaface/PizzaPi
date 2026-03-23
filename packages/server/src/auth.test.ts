import { describe, expect, test, beforeAll, afterAll, spyOn } from "bun:test";
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

describe("secret validation", () => {
    test("throws in production when secret is missing", () => {
        const origEnv = process.env.NODE_ENV;
        const origSecret = process.env.BETTER_AUTH_SECRET;
        process.env.NODE_ENV = "production";
        delete process.env.BETTER_AUTH_SECRET;

        const dbPath = join(mkdtempSync(join(tmpdir(), "auth-secret-test-")), "test.db");
        try {
            expect(() => initAuth({ dbPath })).toThrow(/BETTER_AUTH_SECRET is not set/);
        } finally {
            process.env.NODE_ENV = origEnv;
            if (origSecret !== undefined) process.env.BETTER_AUTH_SECRET = origSecret;
        }
    });

    test("uses random fallback in development when secret is missing", () => {
        const origEnv = process.env.NODE_ENV;
        const origSecret = process.env.BETTER_AUTH_SECRET;
        process.env.NODE_ENV = "development";
        delete process.env.BETTER_AUTH_SECRET;

        const tmpD = mkdtempSync(join(tmpdir(), "auth-secret-test-"));
        const dbPath = join(tmpD, "test.db");
        const warnSpy = spyOn(console, "warn");
        try {
            // Should not throw — generates a random fallback
            expect(() => initAuth({ dbPath })).not.toThrow();
            const warnCalls = warnSpy.mock.calls.map((args) => args.join(" "));
            const found = warnCalls.some((msg) => msg.includes("BETTER_AUTH_SECRET") && msg.includes("random ephemeral secret"));
            expect(found).toBe(true);
        } finally {
            warnSpy.mockRestore();
            process.env.NODE_ENV = origEnv;
            if (origSecret !== undefined) process.env.BETTER_AUTH_SECRET = origSecret;
            rmSync(tmpD, { recursive: true, force: true });
        }
    });

    test("warns when secret is shorter than 32 characters", () => {
        const origEnv = process.env.NODE_ENV;
        process.env.NODE_ENV = "development";

        const tmpD = mkdtempSync(join(tmpdir(), "auth-secret-test-"));
        const dbPath = join(tmpD, "test.db");
        const warnSpy = spyOn(console, "warn");
        try {
            expect(() => initAuth({ dbPath, secret: "short" })).not.toThrow();
            const warnCalls = warnSpy.mock.calls.map((args) => args.join(" "));
            const found = warnCalls.some((msg) => msg.includes("shorter than 32 characters"));
            expect(found).toBe(true);
        } finally {
            warnSpy.mockRestore();
            process.env.NODE_ENV = origEnv;
            rmSync(tmpD, { recursive: true, force: true });
        }
    });

    test("accepts a valid secret without warnings", () => {
        const origEnv = process.env.NODE_ENV;
        process.env.NODE_ENV = "development";

        const tmpD = mkdtempSync(join(tmpdir(), "auth-secret-test-"));
        const dbPath = join(tmpD, "test.db");
        const warnSpy = spyOn(console, "warn");
        const goodSecret = "a".repeat(32);
        try {
            expect(() => initAuth({ dbPath, secret: goodSecret })).not.toThrow();
            const warnCalls = warnSpy.mock.calls.map((args) => args.join(" "));
            const foundSecretWarn = warnCalls.some(
                (msg) => msg.includes("BETTER_AUTH_SECRET") || msg.includes("shorter than 32"),
            );
            expect(foundSecretWarn).toBe(false);
        } finally {
            warnSpy.mockRestore();
            process.env.NODE_ENV = origEnv;
            rmSync(tmpD, { recursive: true, force: true });
        }
    });
});

describe("signup gating", () => {
    // Re-initialize with the test DB because the secret validation tests above
    // call initAuth() with different temp DBs, resetting global auth state.
    beforeAll(async () => {
        initAuth({ dbPath: tmpDbPath });

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
