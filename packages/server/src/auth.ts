import { betterAuth } from "better-auth";
import { apiKey } from "better-auth/plugins";
import { BunSqliteDialect } from "kysely-bun-sqlite";
import { Kysely } from "kysely";
import { Database } from "bun:sqlite";

// ── DB schema types ───────────────────────────────────────────────────────────

export interface UserTable {
    id: string;
    name: string;
    email: string;
    emailVerified: number;
    image: string | null;
    createdAt: string;
    updatedAt: string;
}

export interface SessionTable {
    id: string;
    expiresAt: string;
    token: string;
    createdAt: string;
    updatedAt: string;
    ipAddress: string | null;
    userAgent: string | null;
    userId: string;
}

export interface AccountTable {
    id: string;
    accountId: string;
    providerId: string;
    userId: string;
    accessToken: string | null;
    refreshToken: string | null;
    idToken: string | null;
    accessTokenExpiresAt: string | null;
    refreshTokenExpiresAt: string | null;
    scope: string | null;
    password: string | null;
    createdAt: string;
    updatedAt: string;
}

export interface VerificationTable {
    id: string;
    identifier: string;
    value: string;
    expiresAt: string;
    createdAt: string;
    updatedAt: string;
}

export interface ApiKeyTable {
    id: string;
    name: string | null;
    start: string | null;
    prefix: string | null;
    key: string;
    userId: string;
    refillInterval: number | null;
    refillAmount: number | null;
    lastRefillAt: string | null;
    enabled: number;
    rateLimitEnabled: number;
    rateLimitTimeWindow: number | null;
    rateLimitMax: number | null;
    requestCount: number;
    remaining: number | null;
    lastRequest: string | null;
    expiresAt: string | null;
    createdAt: string;
    updatedAt: string;
    permissions: string | null;
    metadata: string | null;
}

export interface DB {
    user: UserTable;
    session: SessionTable;
    account: AccountTable;
    verification: VerificationTable;
    apikey: ApiKeyTable;
}

// ── Instances ─────────────────────────────────────────────────────────────────

const sqliteDb = new Database(process.env.AUTH_DB_PATH ?? "auth.db");
const dialect = new BunSqliteDialect({ database: sqliteDb });

export const kysely = new Kysely<DB>({ dialect });

export const auth = betterAuth({
    baseURL: process.env.BETTER_AUTH_BASE_URL ?? `http://localhost:${process.env.PORT ?? "3000"}`,
    database: { dialect, type: "sqlite" },
    trustedOrigins: [process.env.PIZZAPI_BASE_URL ?? "http://localhost:5173"],
    emailAndPassword: {
        enabled: true,
    },
    plugins: [
        apiKey({
            enableSessionForAPIKeys: true,
        }),
    ],
});

export type Auth = typeof auth;
