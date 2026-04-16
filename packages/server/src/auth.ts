import { AsyncLocalStorage } from "node:async_hooks";
import { Database } from "bun:sqlite";
import { betterAuth } from "better-auth";
import { apiKey } from "better-auth/plugins";
import { Kysely } from "kysely";
import { BunSqliteDialect } from "kysely-bun-sqlite";
import { createLogger } from "@pizzapi/tools";

const log = createLogger("auth");

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
    isPinned: number;
    runnerId: string | null;
    runnerName: string | null;
    sessionName: string | null;
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

export interface RunnerTriggerListenerTable {
    id: string;
    runnerId: string;
    triggerType: string;
    listenerJson: string;
    updatedAt: string;
}

export interface UserHiddenModelTable {
    id: string;
    userId: string;
    /** Format: "provider/modelId" */
    modelKey: string;
    createdAt: string;
}

export interface ExtractedAttachmentTable {
    attachmentId: string;
    sessionId: string;
    ownerUserId: string;
    filename: string;
    mimeType: string;
    size: number;
    createdAt: string;
    expiresAt: string;
    filePath: string;
}

export interface WebhookTable {
    id: string;
    userId: string;
    name: string;
    secret: string;
    eventFilter: string | null;
    source: string;
    runnerId: string | null;
    cwd: string | null;
    prompt: string | null;
    modelProvider: string | null;
    modelId: string | null;
    enabled: number;
    createdAt: string;
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
    push_subscription: PushSubscriptionTable;
    runner_recent_folder: RunnerRecentFolderTable;
    runner_trigger_listener: RunnerTriggerListenerTable;
    user_hidden_model: UserHiddenModelTable;
    extracted_attachment: ExtractedAttachmentTable;
    webhook: WebhookTable;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const DEFAULT_API_KEY_RATE_LIMIT_TIME_WINDOW_MS = 24 * 60 * 60 * 1000;
const DEFAULT_API_KEY_RATE_LIMIT_MAX_REQUESTS = 10;
const TEST_AUTH_SECRET = "test-secret-for-server-tests-at-least-32-chars-long!!";

type ApiKeyRateLimitConfig = {
    enabled: boolean;
    timeWindow: number;
    maxRequests: number;
};

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

function createBetterAuth(opts: {
    baseURL: string;
    secret: string | undefined;
    dialect: BunSqliteDialect;
    trustedOrigins: string[];
    rateLimitConfig: ApiKeyRateLimitConfig;
}) {
    return betterAuth({
        baseURL: opts.baseURL,
        secret: opts.secret,
        database: { dialect: opts.dialect, type: "sqlite" as const, transaction: true },
        trustedOrigins: () => opts.trustedOrigins,
        emailAndPassword: { enabled: true },
        advanced: {
            ipAddress: {
                ipAddressHeaders: ["x-pizzapi-client-ip"],
            },
        },
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

type AuthInstance = ReturnType<typeof createBetterAuth>;

export interface AuthContext {
    config: {
        dbPath: string;
        baseURL: string;
        secret: string;
    };
    db: Kysely<DB>;
    auth: AuthInstance;
    trustedOrigins: string[];
    disableSignupAfterFirstUser: boolean;
    apiKeyRateLimitConfig: ApiKeyRateLimitConfig;
}

const authContextStorage = new AsyncLocalStorage<AuthContext>();

export function createAuthContext(config: AuthConfig = {}): AuthContext {
    const dbPath = config.dbPath ?? process.env.AUTH_DB_PATH ?? "auth.db";
    const baseURL = config.baseURL ?? process.env.BETTER_AUTH_BASE_URL ?? `http://localhost:${process.env.PORT ?? "7492"}`;
    let secret = config.secret ?? process.env.BETTER_AUTH_SECRET;

    const isProd = process.env.NODE_ENV === "production";
    if (!secret || secret.trim() === "") {
        const msg =
            "BETTER_AUTH_SECRET is not set. Sessions will be signed with an insecure key.\n" +
            "  Set it via the BETTER_AUTH_SECRET environment variable (min 32 characters).\n" +
            "  Example: BETTER_AUTH_SECRET=$(openssl rand -hex 32)";
        if (isProd) {
            throw new Error(`[auth] ${msg}`);
        }
        const fallback = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
        log.warn(`WARNING: ${msg}\n  Using a random ephemeral secret for this development session.`);
        secret = fallback;
    } else if (secret.length < 32) {
        log.warn(
            `WARNING: BETTER_AUTH_SECRET is shorter than 32 characters (got ${secret.length}). ` +
            "A longer secret is strongly recommended for security.",
        );
    }

    const disableSignupAfterFirstUser = config.disableSignupAfterFirstUser ??
        parseBooleanEnv(process.env.PIZZAPI_DISABLE_SIGNUP_AFTER_FIRST_USER, true);

    const apiKeyRateLimitConfig: ApiKeyRateLimitConfig = {
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

    const extraOrigins = config.extraOrigins ??
        (process.env.PIZZAPI_EXTRA_ORIGINS
            ? process.env.PIZZAPI_EXTRA_ORIGINS.split(",").map((o) => o.trim()).filter(Boolean)
            : []);
    const isProduction = process.env.NODE_ENV === "production";
    if (isProduction && !process.env.PIZZAPI_BASE_URL) {
        log.warn("WARNING: PIZZAPI_BASE_URL is not set in production. This may cause CORS or WebSocket connection issues.");
    }
    const baseOrigins: string[] = [];
    if (process.env.PIZZAPI_BASE_URL) {
        baseOrigins.push(process.env.PIZZAPI_BASE_URL);
    } else if (!isProduction) {
        baseOrigins.push("http://localhost:5173", "http://127.0.0.1:5173");
    }
    const trustedOrigins = [...baseOrigins, ...extraOrigins];

    const sqliteDb = new Database(dbPath);
    const dialect = new BunSqliteDialect({ database: sqliteDb });
    const db = new Kysely<DB>({ dialect });
    const auth = createBetterAuth({
        baseURL,
        secret,
        dialect,
        trustedOrigins,
        rateLimitConfig: apiKeyRateLimitConfig,
    });

    return {
        config: { dbPath, baseURL, secret },
        db,
        auth,
        trustedOrigins,
        disableSignupAfterFirstUser,
        apiKeyRateLimitConfig,
    };
}

export function createTestAuthContext(config: AuthConfig = {}): AuthContext {
    return createAuthContext({
        baseURL: config.baseURL ?? "http://localhost",
        secret: config.secret ?? TEST_AUTH_SECRET,
        disableSignupAfterFirstUser: config.disableSignupAfterFirstUser,
        extraOrigins: config.extraOrigins,
        dbPath: config.dbPath,
    });
}

export function initAuth(config: AuthConfig = {}): AuthContext {
    return createAuthContext(config);
}

export function initTestAuth(config: AuthConfig = {}): AuthContext {
    return createTestAuthContext(config);
}

export function runWithAuthContext<T>(context: AuthContext, fn: () => T): T {
    return authContextStorage.run(context, fn);
}

export function bindAuthContext<T extends (...args: any[]) => any>(context: AuthContext, fn: T): T {
    return ((...args: Parameters<T>) => runWithAuthContext(context, () => fn(...args))) as T;
}

export function getAuthContext(): AuthContext {
    const context = authContextStorage.getStore();
    if (!context) {
        throw new Error(
            "[auth] No auth context is active. Create one with createAuthContext()/createTestAuthContext() and call the code inside runWithAuthContext(...).",
        );
    }
    return context;
}

/** Get the Kysely database instance for the active auth context. */
export function getKysely(): Kysely<DB> {
    return getAuthContext().db;
}

/** Get the better-auth instance for the active auth context. */
export function getAuth(): AuthInstance {
    return getAuthContext().auth;
}

/** Get trusted origins list for the active auth context. */
export function getTrustedOrigins(): string[] {
    return getAuthContext().trustedOrigins;
}

/** Add an origin to the active auth context at runtime (e.g. Vite dev port in sandbox). */
export function addTrustedOrigin(origin: string): void {
    const trustedOrigins = getTrustedOrigins();
    if (!trustedOrigins.includes(origin)) {
        trustedOrigins.push(origin);
    }
}

/** Get API key rate limit configuration for the active auth context. */
export function getApiKeyRateLimitConfig(): ApiKeyRateLimitConfig {
    return getAuthContext().apiKeyRateLimitConfig;
}

/** Whether signup gating is enabled for the active auth context. */
export function getDisableSignupAfterFirstUser(): boolean {
    return getAuthContext().disableSignupAfterFirstUser;
}

export type Auth = AuthInstance;

/** Create a standalone Kysely instance for ad-hoc test setup. */
export function createTestDatabase(dbPath: string): Kysely<DB> {
    const sqliteDb = new Database(dbPath);
    return new Kysely<DB>({ dialect: new BunSqliteDialect({ database: sqliteDb }) });
}

export function _setKyselyForTest(_db: Kysely<DB>): never {
    throw new Error("_setKyselyForTest() was removed. Use createTestAuthContext() + runWithAuthContext() instead.");
}

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
