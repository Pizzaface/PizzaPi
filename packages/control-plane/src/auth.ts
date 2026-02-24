import { betterAuth } from "better-auth";
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

export interface DB {
    user: UserTable;
    session: SessionTable;
    account: AccountTable;
    verification: VerificationTable;
}

// ── Instances ─────────────────────────────────────────────────────────────────

const sqliteDb = new Database(process.env.CP_DB_PATH ?? "control-plane.db");
const dialect = new BunSqliteDialect({ database: sqliteDb });

export const kysely = new Kysely<DB>({ dialect });

const PORT = process.env.PORT ?? "3100";

export const trustedOrigins: string[] = [
    process.env.CP_BASE_URL ?? `http://localhost:${PORT}`,
];

export const auth = betterAuth({
    baseURL: process.env.BETTER_AUTH_BASE_URL ?? `http://localhost:${PORT}`,
    secret: process.env.BETTER_AUTH_SECRET,
    database: { dialect, type: "sqlite", transaction: true },
    trustedOrigins,
    emailAndPassword: {
        enabled: true,
    },
});

export type Auth = typeof auth;
