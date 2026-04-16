import { describe, expect, test, beforeAll, beforeEach, afterAll, spyOn } from "bun:test";
import {
    createAuthContext,
    createTestAuthContext,
    getDisableSignupAfterFirstUser,
    getKysely,
    initAuth,
    initTestAuth,
    isSignupAllowed,
    runWithAuthContext,
} from "./auth";
import { sql } from "kysely";
import { runAllMigrations } from "./migrations.js";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const tmpDir = mkdtempSync(join(tmpdir(), "auth-test-"));
const tmpDbPath = join(tmpDir, "test.db");
let testAuthContext = initTestAuth({ dbPath: tmpDbPath });
const withTestAuth = <T>(fn: () => T): T => runWithAuthContext(testAuthContext, fn);

beforeAll(async () => {
    testAuthContext = initTestAuth({ dbPath: tmpDbPath });

    await withTestAuth(() => sql`
        CREATE TABLE IF NOT EXISTS user (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            email TEXT NOT NULL UNIQUE,
            emailVerified INTEGER NOT NULL DEFAULT 0,
            image TEXT,
            createdAt TEXT NOT NULL,
            updatedAt TEXT NOT NULL
        )
    `.execute(getKysely()));
});

beforeEach(() => {
    testAuthContext = initTestAuth({ dbPath: tmpDbPath });
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

        const tmpD = mkdtempSync(join(tmpdir(), "auth-secret-test-"));
        const dbPath = join(tmpD, "test.db");
        try {
            expect(() => initAuth({ dbPath })).toThrow(/BETTER_AUTH_SECRET is not set/);
        } finally {
            process.env.NODE_ENV = origEnv;
            if (origSecret !== undefined) process.env.BETTER_AUTH_SECRET = origSecret;
            rmSync(tmpD, { recursive: true, force: true });
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

describe("auth database wiring", () => {
    test("better-auth and getKysely share the same migrated database", async () => {
        const dir = mkdtempSync(join(tmpdir(), "auth-shared-db-test-"));
        const dbPath = join(dir, "shared.db");
        const context = createTestAuthContext({
            dbPath,
            baseURL: "http://localhost:7003",
            disableSignupAfterFirstUser: false,
        });

        try {
            await runAllMigrations(context);
            const created = await runWithAuthContext(context, () => context.auth.api.signUpEmail({
                body: {
                    name: "Shared DB User",
                    email: "shared-db@example.com",
                    password: "SharedPass123",
                },
            }));

            expect(created?.user?.id).toBeTruthy();

            const row = await runWithAuthContext(context, () => getKysely()
                .selectFrom("user")
                .select(["id", "email"])
                .where("email", "=", "shared-db@example.com")
                .executeTakeFirst());

            expect(row?.id).toBe(created?.user?.id);
            expect(row?.email).toBe("shared-db@example.com");
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe("signup gating", () => {
    beforeAll(async () => {
        testAuthContext = initTestAuth({ dbPath: tmpDbPath });
    });

    test("independent auth contexts keep their own signup config", async () => {
        const allowCtx = createAuthContext({
            dbPath: join(tmpdir(), `auth-allow-${crypto.randomUUID()}.db`),
            secret: "a".repeat(32),
            disableSignupAfterFirstUser: false,
            baseURL: "http://localhost:7001",
        });
        const blockCtx = createAuthContext({
            dbPath: join(tmpdir(), `auth-block-${crypto.randomUUID()}.db`),
            secret: "b".repeat(32),
            disableSignupAfterFirstUser: true,
            baseURL: "http://localhost:7002",
        });

        expect(await runWithAuthContext(allowCtx, () => Promise.resolve(getDisableSignupAfterFirstUser()))).toBe(false);
        expect(await runWithAuthContext(blockCtx, () => Promise.resolve(getDisableSignupAfterFirstUser()))).toBe(true);
    });

    test("disableSignupAfterFirstUser defaults to true", () => {
        expect(withTestAuth(() => getDisableSignupAfterFirstUser())).toBe(true);
    });

    test("isSignupAllowed returns true when no users exist", async () => {
        await withTestAuth(() => getKysely().deleteFrom("user").execute());
        const allowed = await withTestAuth(() => isSignupAllowed());
        expect(allowed).toBe(true);
    });

    test("isSignupAllowed returns false when users exist", async () => {
        await withTestAuth(() => getKysely().deleteFrom("user").execute());
        const now = new Date().toISOString();
        await withTestAuth(() => getKysely()
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
            .execute());

        const allowed = await withTestAuth(() => isSignupAllowed());
        expect(allowed).toBe(false);

        await withTestAuth(() => getKysely().deleteFrom("user").execute());
    });
});
