import { sql, type Kysely } from "kysely";

/**
 * better-auth can occasionally skip core table creation when multiple auth
 * contexts are created in one Bun process during tests. This defensive helper
 * verifies the core tables exist for the provided test database.
 */
export async function ensureBetterAuthCoreTables(db: Kysely<any>): Promise<void> {
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
    `.execute(db);

    await sql`
        CREATE TABLE IF NOT EXISTS session (
            id TEXT PRIMARY KEY,
            expiresAt TEXT NOT NULL,
            token TEXT NOT NULL UNIQUE,
            createdAt TEXT NOT NULL,
            updatedAt TEXT NOT NULL,
            ipAddress TEXT,
            userAgent TEXT,
            userId TEXT NOT NULL
        )
    `.execute(db);

    await sql`
        CREATE TABLE IF NOT EXISTS account (
            id TEXT PRIMARY KEY,
            accountId TEXT NOT NULL,
            providerId TEXT NOT NULL,
            userId TEXT NOT NULL,
            accessToken TEXT,
            refreshToken TEXT,
            idToken TEXT,
            accessTokenExpiresAt TEXT,
            refreshTokenExpiresAt TEXT,
            scope TEXT,
            password TEXT,
            createdAt TEXT NOT NULL,
            updatedAt TEXT NOT NULL
        )
    `.execute(db);

    await sql`
        CREATE TABLE IF NOT EXISTS verification (
            id TEXT PRIMARY KEY,
            identifier TEXT NOT NULL,
            value TEXT NOT NULL,
            expiresAt TEXT NOT NULL,
            createdAt TEXT NOT NULL,
            updatedAt TEXT NOT NULL
        )
    `.execute(db);

    await sql`
        CREATE TABLE IF NOT EXISTS apikey (
            id TEXT PRIMARY KEY,
            name TEXT,
            start TEXT,
            prefix TEXT,
            key TEXT NOT NULL,
            userId TEXT NOT NULL,
            refillInterval INTEGER,
            refillAmount INTEGER,
            lastRefillAt TEXT,
            enabled INTEGER NOT NULL DEFAULT 1,
            rateLimitEnabled INTEGER NOT NULL DEFAULT 0,
            rateLimitTimeWindow INTEGER,
            rateLimitMax INTEGER,
            requestCount INTEGER NOT NULL DEFAULT 0,
            remaining INTEGER,
            lastRequest TEXT,
            expiresAt TEXT,
            createdAt TEXT NOT NULL,
            updatedAt TEXT NOT NULL,
            permissions TEXT,
            metadata TEXT
        )
    `.execute(db);
}
