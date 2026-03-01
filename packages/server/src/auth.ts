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

export interface PushSubscriptionTable {
    id: string;
    userId: string;
    endpoint: string;
    keys: string;
    createdAt: string;
    enabledEvents: string;
}

export interface RunnerRecentFolderTable {
    id: string;
    userId: string;
    runnerId: string;
    path: string;
    lastUsedAt: string;
}

export interface UserHiddenModelTable {
    id: string;
    userId: string;
    /** Format: "provider/modelId" */
    modelKey: string;
    createdAt: string;
}

export interface DB {
    user: UserTable;
    session: SessionTable;
    account: AccountTable;
    verification: VerificationTable;
    apikey: ApiKeyTable;
    relay_session: RelaySessionTable;
    relay_session_state: RelaySessionStateTable;
    push_subscription: PushSubscriptionTable;
    runner_recent_folder: RunnerRecentFolderTable;
    user_hidden_model: UserHiddenModelTable;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

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

// ── Configuration ─────────────────────────────────────────────────────────────

export interface AuthConfig {
    /** Path to SQLite database file. Defaults to AUTH_DB_PATH env or "auth.db". */
    dbPath?: string;
    /** better-auth base URL. Defaults to BETTER_AUTH_BASE_URL env. */
    baseURL?: string;
    /** better-auth secret. Defaults to BETTER_AUTH_SECRET env. */
    secret?: string;
    /** Disable signups after first user. Defaults to PIZZAPI_DISABLE_SIGNUP_AFTER_FIRST_USER env or true. */
    disableSignupAfterFirstUser?: boolean;
    /** Extra trusted origins. Defaults to PIZZAPI_EXTRA_ORIGINS env. */
    extraOrigins?: string[];
}

// ── Singleton state ───────────────────────────────────────────────────────────

let _kysely: Kysely<DB> | null = null;
// Use a factory function to capture the full inferred type including plugins
function _createAuth(opts: {
    baseURL: string;
    secret: string | undefined;
    dialect: BunSqliteDialect;
    trustedOrigins: string[];
    rateLimitConfig: { enabled: boolean; timeWindow: number; maxRequests: number };
}) {
    return betterAuth({
        baseURL: opts.baseURL,
        secret: opts.secret,
        database: { dialect: opts.dialect, type: "sqlite" as const, transaction: true },
        trustedOrigins: opts.trustedOrigins,
        emailAndPassword: { enabled: true },
        plugins: [
            apiKey({
                enableSessionForAPIKeys: true,
                rateLimit: {
                    enabled: opts.rateLimitConfig.enabled,
                    timeWindow: opts.rateLimitConfig.timeWindow,
                    maxRequests: opts.rateLimitConfig.maxRequests,
                },
            }),
        ],
    });
}
type AuthInstance = ReturnType<typeof _createAuth>;
let _auth: AuthInstance | null = null;
let _trustedOrigins: string[] | null = null;
let _disableSignupAfterFirstUser: boolean | null = null;
let _apiKeyRateLimitConfig: { enabled: boolean; timeWindow: number; maxRequests: number } | null = null;
let _initialized = false;

/**
 * Initialize the auth subsystem. Must be called once before any getters.
 * Safe to call multiple times (resets state — useful for tests).
 */
export function initAuth(config: AuthConfig = {}): void {
    const dbPath = config.dbPath ?? process.env.AUTH_DB_PATH ?? "auth.db";
    const baseURL = config.baseURL ?? process.env.BETTER_AUTH_BASE_URL ?? `http://localhost:${process.env.PORT ?? "7492"}`;
    const secret = config.secret ?? process.env.BETTER_AUTH_SECRET;

    _disableSignupAfterFirstUser = config.disableSignupAfterFirstUser ??
        parseBooleanEnv(process.env.PIZZAPI_DISABLE_SIGNUP_AFTER_FIRST_USER, true);

    _apiKeyRateLimitConfig = {
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

    // Trusted origins
    const extraOrigins = config.extraOrigins ??
        (process.env.PIZZAPI_EXTRA_ORIGINS
            ? process.env.PIZZAPI_EXTRA_ORIGINS.split(",").map((o) => o.trim()).filter(Boolean)
            : []);
    const isProduction = process.env.NODE_ENV === "production";
    if (isProduction && !process.env.PIZZAPI_BASE_URL) {
        console.warn("WARNING: PIZZAPI_BASE_URL is not set in production. This may cause CORS or WebSocket connection issues.");
    }
    const baseOrigins: string[] = [];
    if (process.env.PIZZAPI_BASE_URL) {
        baseOrigins.push(process.env.PIZZAPI_BASE_URL);
    } else if (!isProduction) {
        baseOrigins.push("http://localhost:5173", "http://127.0.0.1:5173");
    }
    _trustedOrigins = [...baseOrigins, ...extraOrigins];

    // Database
    const sqliteDb = new Database(dbPath);
    const dialect = new BunSqliteDialect({ database: sqliteDb });
    _kysely = new Kysely<DB>({ dialect });

    // Auth
    _auth = _createAuth({
        baseURL,
        secret,
        dialect,
        trustedOrigins: _trustedOrigins,
        rateLimitConfig: _apiKeyRateLimitConfig,
    });

    _initialized = true;
}

// ── Lazy auto-init ────────────────────────────────────────────────────────────
// For backward compatibility: if code accesses a getter before explicit init,
// auto-initialize with env-based defaults. This preserves the old behavior
// where importing auth.ts was enough.

function ensureInitialized(): void {
    if (!_initialized) {
        initAuth();
    }
}

// ── Accessors ─────────────────────────────────────────────────────────────────

/** Get the Kysely database instance. */
export function getKysely(): Kysely<DB> {
    ensureInitialized();
    return _kysely!;
}

/** Get the better-auth instance. */
export function getAuth(): AuthInstance {
    ensureInitialized();
    return _auth!;
}

/** Get trusted origins list. */
export function getTrustedOrigins(): string[] {
    ensureInitialized();
    return _trustedOrigins!;
}

/** Get API key rate limit configuration. */
export function getApiKeyRateLimitConfig() {
    ensureInitialized();
    return _apiKeyRateLimitConfig!;
}

/** Whether signup gating is enabled. */
export function getDisableSignupAfterFirstUser(): boolean {
    ensureInitialized();
    return _disableSignupAfterFirstUser!;
}

export type Auth = AuthInstance;



// ── Signup gating ──────────────────────────────────────────────────────────────

/**
 * Returns `true` when new user signups are currently allowed.
 */
export async function isSignupAllowed(): Promise<boolean> {
    if (!getDisableSignupAfterFirstUser()) return true;

    const db = getKysely();
    const row = await db
        .selectFrom("user")
        .select(db.fn.countAll<number>().as("cnt"))
        .executeTakeFirst();

    return (row?.cnt ?? 0) === 0;
}
