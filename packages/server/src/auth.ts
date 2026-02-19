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

export interface RelaySessionTable {
    id: string;
    userId: string | null;
    userName: string | null;
    cwd: string;
    shareUrl: string;
    startedAt: string;
    lastActiveAt: string;
    endedAt: string | null;
    isEphemeral: number;
    expiresAt: string | null;
}

export interface RelaySessionStateTable {
    sessionId: string;
    state: string;
    updatedAt: string;
}

export interface DB {
    user: UserTable;
    session: SessionTable;
    account: AccountTable;
    verification: VerificationTable;
    apikey: ApiKeyTable;
    relay_session: RelaySessionTable;
    relay_session_state: RelaySessionStateTable;
}

// ── Instances ─────────────────────────────────────────────────────────────────

const sqliteDb = new Database(process.env.AUTH_DB_PATH ?? "auth.db");
const dialect = new BunSqliteDialect({ database: sqliteDb });

export const kysely = new Kysely<DB>({ dialect });

const DEFAULT_API_KEY_RATE_LIMIT_TIME_WINDOW_MS = 24 * 60 * 60 * 1000;
const DEFAULT_API_KEY_RATE_LIMIT_MAX_REQUESTS = 10;

function parseBooleanEnv(value: string | undefined, fallback: boolean): boolean {
    if (!value) return fallback;
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized)) return true;
    if (["0", "false", "no", "off"].includes(normalized)) return false;
    return fallback;
}

function parsePositiveIntEnv(value: string | undefined, fallback: number): number {
    if (!value) return fallback;
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export const apiKeyRateLimitConfig = {
    enabled: parseBooleanEnv(process.env.PIZZAPI_API_KEY_RATE_LIMIT_ENABLED, false),
    timeWindow: parsePositiveIntEnv(
        process.env.PIZZAPI_API_KEY_RATE_LIMIT_TIME_WINDOW_MS,
        DEFAULT_API_KEY_RATE_LIMIT_TIME_WINDOW_MS,
    ),
    maxRequests: parsePositiveIntEnv(
        process.env.PIZZAPI_API_KEY_RATE_LIMIT_MAX_REQUESTS,
        DEFAULT_API_KEY_RATE_LIMIT_MAX_REQUESTS,
    ),
};

export const auth = betterAuth({
    baseURL: process.env.BETTER_AUTH_BASE_URL ?? `http://localhost:${process.env.PORT ?? "3000"}`,
    secret: process.env.BETTER_AUTH_SECRET,
    database: { dialect, type: "sqlite", transaction: true },
    trustedOrigins: [process.env.PIZZAPI_BASE_URL ?? "http://localhost:5173"],
    emailAndPassword: {
        enabled: true,
    },
    plugins: [
        apiKey({
            enableSessionForAPIKeys: true,
            rateLimit: {
                enabled: apiKeyRateLimitConfig.enabled,
                timeWindow: apiKeyRateLimitConfig.timeWindow,
                maxRequests: apiKeyRateLimitConfig.maxRequests,
            },
        }),
    ],
});

export type Auth = typeof auth;
