/**
 * Defensive fallback for better-auth's runMigrations() which can silently
 * skip core table creation when initAuth() has been called multiple times
 * in the same Bun process. Uses CREATE TABLE IF NOT EXISTS so it's safe
 * to call even when migrations worked correctly.
 */
import { sql, type Kysely } from "kysely";

export async function ensureBetterAuthCoreTables(db: Kysely<any>): Promise<void> {
    await sql`CREATE TABLE IF NOT EXISTS "user" (
        "id" text NOT NULL PRIMARY KEY,
        "name" text NOT NULL,
        "email" text NOT NULL UNIQUE,
        "emailVerified" integer NOT NULL DEFAULT 0,
        "image" text,
        "createdAt" text NOT NULL,
        "updatedAt" text NOT NULL
    )`.execute(db);
    await sql`CREATE TABLE IF NOT EXISTS "session" (
        "id" text NOT NULL PRIMARY KEY,
        "expiresAt" text NOT NULL,
        "token" text NOT NULL UNIQUE,
        "createdAt" text NOT NULL,
        "updatedAt" text NOT NULL,
        "ipAddress" text,
        "userAgent" text,
        "userId" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE
    )`.execute(db);
    await sql`CREATE TABLE IF NOT EXISTS "account" (
        "id" text NOT NULL PRIMARY KEY,
        "accountId" text NOT NULL,
        "providerId" text NOT NULL,
        "userId" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
        "accessToken" text,
        "refreshToken" text,
        "idToken" text,
        "accessTokenExpiresAt" text,
        "refreshTokenExpiresAt" text,
        "scope" text,
        "password" text,
        "createdAt" text NOT NULL,
        "updatedAt" text NOT NULL
    )`.execute(db);
    await sql`CREATE TABLE IF NOT EXISTS "verification" (
        "id" text NOT NULL PRIMARY KEY,
        "identifier" text NOT NULL,
        "value" text NOT NULL,
        "expiresAt" text NOT NULL,
        "createdAt" text,
        "updatedAt" text
    )`.execute(db);
    await sql`CREATE TABLE IF NOT EXISTS "apikey" (
        "id" text NOT NULL PRIMARY KEY,
        "name" text,
        "start" text,
        "prefix" text,
        "key" text NOT NULL,
        "userId" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
        "refillInterval" integer,
        "refillAmount" integer,
        "lastRefillAt" text,
        "enabled" integer,
        "rateLimitEnabled" integer,
        "rateLimitTimeWindow" integer,
        "rateLimitMax" integer,
        "requestCount" integer,
        "remaining" integer,
        "lastRequest" text,
        "expiresAt" text,
        "createdAt" text NOT NULL,
        "updatedAt" text NOT NULL,
        "permissions" text,
        "metadata" text
    )`.execute(db);
}
