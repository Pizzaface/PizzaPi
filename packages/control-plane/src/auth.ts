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

export interface OrganizationTable {
    id: string;
    slug: string;
    name: string;
    status: "active" | "suspended" | "deleted";
    created_at: string;
    updated_at: string;
}

export interface OrgMembershipTable {
    id: string;
    user_id: string;
    org_id: string;
    role: "owner" | "admin" | "member";
    created_at: string;
}

export interface OrgInstanceTable {
    id: string;
    org_id: string;
    container_id: string | null;
    host: string | null;
    port: number | null;
    status: "provisioning" | "healthy" | "unhealthy" | "stopped";
    health_checked_at: string | null;
    created_at: string;
}

export interface DB {
    user: UserTable;
    session: SessionTable;
    account: AccountTable;
    verification: VerificationTable;
    organizations: OrganizationTable;
    org_memberships: OrgMembershipTable;
    org_instances: OrgInstanceTable;
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
