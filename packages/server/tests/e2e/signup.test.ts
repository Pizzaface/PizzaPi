/**
 * E2E test: signup → API key → authenticated requests → signup gating
 *
 * Uses the factory `initAuth()` to configure a temp SQLite DB, so no
 * subprocess isolation is needed.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initAuth, getAuth, getKysely, type AuthConfig } from "../../src/auth.js";
import { runAllMigrations } from "../../src/migrations.js";
import { handleFetch } from "../../src/handler.js";
import { initStateRedis } from "../../src/ws/sio-state/index.js";

// Save and restore PIZZAPI_TRUST_PROXY so we don't pollute other test files
const savedTrustProxy = process.env.PIZZAPI_TRUST_PROXY;
process.env.PIZZAPI_TRUST_PROXY = "true";

// ── Test setup ────────────────────────────────────────────────────────────────

const tmpDir = mkdtempSync(join(tmpdir(), "pizzapi-e2e-"));
const dbPath = join(tmpDir, "test.db");
const BASE = "http://localhost:7777";

// Counter for generating unique per-request socket IPs in tests.
// In production, nodeReqToFetchRequest always sets x-pizzapi-client-ip from
// the TCP socket. Tests call handleFetch directly, so we simulate that here
// to ensure each request gets a distinct rate-limit key.
let reqCounter = 0;

/** Helper to make requests through the handler */
async function req(method: string, path: string, body?: any, headers?: Record<string, string>): Promise<Response> {
    // Simulate the Node adapter injecting x-pizzapi-client-ip from the TCP socket.
    // Each call gets a unique IP so rate-limiter buckets are independent, matching
    // production behavior where distinct TCP connections get distinct IPs.
    const socketIp = headers?.["x-pizzapi-client-ip"] ?? `10.255.${Math.floor(reqCounter / 256) % 256}.${reqCounter % 256}`;
    reqCounter++;
    const init: RequestInit = {
        method,
        headers: { "content-type": "application/json", "x-pizzapi-client-ip": socketIp, ...headers },
    };
    if (body) init.body = JSON.stringify(body);
    return handleFetch(new Request(`${BASE}${path}`, init));
}

beforeAll(async () => {
    initAuth({
        dbPath,
        baseURL: BASE,
        secret: "test-secret-for-e2e-at-least-32-chars-long!!",
        disableSignupAfterFirstUser: false,
    });
    await runAllMigrations();
    // Routes like /api/runners/spawn need Redis for runner lookups.
    await initStateRedis();
});

afterAll(() => {
    // Restore PIZZAPI_TRUST_PROXY to avoid env pollution across test files
    if (savedTrustProxy === undefined) {
        delete process.env.PIZZAPI_TRUST_PROXY;
    } else {
        process.env.PIZZAPI_TRUST_PROXY = savedTrustProxy;
    }
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

// ── Core signup + API key flow ────────────────────────────────────────────────

describe("E2E: signup → API key → authenticated requests", () => {
    const testUser = {
        name: "Test User",
        email: "testuser@example.com",
        password: "SecurePass123",
    };
    let apiKey: string;

    test("GET /api/signup-status returns signupEnabled: true on fresh DB", async () => {
        const res = await req("GET", "/api/signup-status");
        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.signupEnabled).toBe(true);
    });

    test("POST /api/register creates user and returns API key", async () => {
        const res = await req("POST", "/api/register", testUser);
        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.ok).toBe(true);
        expect(typeof data.key).toBe("string");
        expect(data.key.length).toBe(64); // 32 random bytes → 64 hex chars
        apiKey = data.key;
    });

    test("POST /api/register with same creds returns new key (re-login)", async () => {
        const res = await req("POST", "/api/register", testUser);
        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.ok).toBe(true);
        expect(typeof data.key).toBe("string");
        apiKey = data.key;
    });

    test("POST /api/register with wrong password returns 401", async () => {
        const res = await req("POST", "/api/register", {
            ...testUser,
            password: "WrongPassword123",
        });
        expect(res.status).toBe(401);
    });

    test("POST /api/register with missing fields returns 400", async () => {
        const res = await req("POST", "/api/register", { email: "a@b.com" });
        expect(res.status).toBe(400);
    });

    test("POST /api/register with weak password returns 400", async () => {
        const res = await req("POST", "/api/register", {
            name: "Weak",
            email: "weak@example.com",
            password: "short",
        });
        expect(res.status).toBe(400);
    });

    test("POST /api/register with invalid email returns 400", async () => {
        const res = await req("POST", "/api/register", {
            name: "Bad Email",
            email: "not-an-email",
            password: "SecurePass123",
        }, { "x-forwarded-for": "10.0.0.99" });
        expect(res.status).toBe(400);
    });

    test("API key validates via better-auth verifyApiKey", async () => {
        const auth = getAuth();
        const result = await auth.api.verifyApiKey({ body: { key: apiKey } });
        expect(result.valid).toBe(true);
        expect(result.key?.userId).toBeTruthy();
    });

    test("invalid API key fails verification", async () => {
        const auth = getAuth();
        const result = await auth.api.verifyApiKey({ body: { key: "bad-key" } }).catch(() => ({ valid: false }));
        expect(result.valid).toBe(false);
    });

    test("API key is stored in DB with correct metadata", async () => {
        const kysely = getKysely();
        const rows = await kysely
            .selectFrom("apikey")
            .selectAll()
            .where("name", "=", "cli")
            .execute();

        expect(rows.length).toBe(1);
        expect(rows[0].enabled).toBe(1);
        expect(rows[0].start).toBe(apiKey.slice(0, 8));
    });

    test("GET /health works without auth", async () => {
        const res = await req("GET", "/health");
        // In test environments Redis/Socket.IO are not initialised, so the
        // endpoint reports degraded (503). The important thing is that it
        // responds without requiring authentication and returns the expected shape.
        expect([200, 503]).toContain(res.status);
        const data = await res.json();
        expect(["ok", "degraded"]).toContain(data.status);
        expect(typeof data.redis).toBe("boolean");
        expect(typeof data.socketio).toBe("boolean");
        expect(typeof data.uptime).toBe("number");
    });
});

// ── Key rotation: old key invalidated on re-register ──────────────────────────

describe("E2E: key rotation", () => {
    const rotUser = {
        name: "Rotation User",
        email: "rotate@example.com",
        password: "RotatePass123",
    };

    test("old API key is invalidated after re-register", async () => {
        // Register and get first key
        const res1 = await req("POST", "/api/register", rotUser, { "x-forwarded-for": "10.0.1.1" });
        expect(res1.status).toBe(200);
        const { key: firstKey } = await res1.json();

        // Verify first key works
        const auth = getAuth();
        const check1 = await auth.api.verifyApiKey({ body: { key: firstKey } });
        expect(check1.valid).toBe(true);

        // Re-register (re-login) to get a new key
        const res2 = await req("POST", "/api/register", rotUser, { "x-forwarded-for": "10.0.1.2" });
        expect(res2.status).toBe(200);
        const { key: secondKey } = await res2.json();
        expect(secondKey).not.toBe(firstKey);

        // Second key works
        const check2 = await auth.api.verifyApiKey({ body: { key: secondKey } });
        expect(check2.valid).toBe(true);

        // First key is now invalid (deleted on re-register)
        const check3 = await auth.api.verifyApiKey({ body: { key: firstKey } }).catch(() => ({ valid: false }));
        expect(check3.valid).toBe(false);
    });
});

// ── API key auth on real HTTP endpoint ────────────────────────────────────────

describe("E2E: API key authenticates HTTP requests", () => {
    let apiKey: string;

    beforeAll(async () => {
        const res = await req("POST", "/api/register", {
            name: "HTTP Auth User",
            email: "httpauth@example.com",
            password: "HttpAuth123",
        }, { "x-forwarded-for": "10.0.2.1" });
        const data = await res.json();
        apiKey = data.key;
    });

    test("x-api-key header authenticates on /api/runners/spawn", async () => {
        // /api/runners/spawn requires auth + runnerId. The runner lookup will
        // fail (runner doesn't exist), but NOT with 401 — proving auth passed.
        const res = await req("POST", "/api/runners/spawn", { runnerId: "nonexistent" }, {
            "x-api-key": apiKey,
        });
        expect(res.status).not.toBe(401);
    });

    test("missing API key returns 401 on protected endpoint", async () => {
        const res = await req("POST", "/api/runners/spawn", { runnerId: "fake" });
        expect(res.status).toBe(401);
    });

    test("bad API key returns 401 on protected endpoint", async () => {
        const res = await req("POST", "/api/runners/spawn", { runnerId: "fake" }, {
            "x-api-key": "totally-invalid-key",
        });
        expect(res.status).toBe(401);
    });
});

// ── Signup gating ─────────────────────────────────────────────────────────────

describe.serial("E2E: signup gating (disable after first user)", () => {
    test("when gating is enabled, second user registration is blocked", async () => {
        // Set up a fresh DB with gating enabled
        const gatedDir = mkdtempSync(join(tmpdir(), "pizzapi-e2e-gated-"));
        const gatedDbPath = join(gatedDir, "gated.db");

        try {
            initAuth({
                dbPath: gatedDbPath,
                baseURL: BASE,
                secret: "test-secret-for-e2e-at-least-32-chars-long!!",
                disableSignupAfterFirstUser: true, // ← gating enabled
            });
            await runAllMigrations();

            // First user signup should succeed
            const res1 = await req("POST", "/api/register", {
                name: "First User",
                email: "first@example.com",
                password: "FirstPass123",
            }, { "x-forwarded-for": "10.0.3.1" });
            expect(res1.status).toBe(200);
            const data1 = await res1.json();
            expect(data1.ok).toBe(true);

            // Second user signup should be blocked (403)
            const res2 = await req("POST", "/api/register", {
                name: "Second User",
                email: "second@example.com",
                password: "SecondPass123",
            }, { "x-forwarded-for": "10.0.3.2" });
            expect(res2.status).toBe(403);
            const data2 = await res2.json();
            expect(data2.error).toBe("Registration is not available.");

            // Signup status should reflect disabled state
            const statusRes = await req("GET", "/api/signup-status");
            const statusData = await statusRes.json();
            expect(statusData.signupEnabled).toBe(false);
        } finally {
            // Restore original DB for any subsequent tests
            initAuth({
                dbPath,
                baseURL: BASE,
                secret: "test-secret-for-e2e-at-least-32-chars-long!!",
                disableSignupAfterFirstUser: false,
            });
            try { rmSync(gatedDir, { recursive: true, force: true }); } catch {}
        }
    });
});

// ── User enumeration prevention ──────────────────────────────────────────────

describe.serial("E2E: /api/register does not leak account existence when signups disabled", () => {
    test("existing email + wrong password and unknown email both return identical 403", async () => {
        // Set up a fresh DB with one user and gating enabled
        const enumDir = mkdtempSync(join(tmpdir(), "pizzapi-e2e-enum-"));
        const enumDbPath = join(enumDir, "enum.db");

        try {
            initAuth({
                dbPath: enumDbPath,
                baseURL: BASE,
                secret: "test-secret-for-e2e-at-least-32-chars-long!!",
                disableSignupAfterFirstUser: true,
            });
            await runAllMigrations();

            // Register first (and only) user — signups now effectively disabled
            const reg = await req("POST", "/api/register", {
                name: "Enum Test User",
                email: "enumtest@example.com",
                password: "EnumPass123",
            }, { "x-forwarded-for": "10.0.5.1" });
            expect(reg.status).toBe(200);

            // Path A: existing email with wrong password
            const resExisting = await req("POST", "/api/register", {
                name: "Enum Test User",
                email: "enumtest@example.com",   // ← known email
                password: "WrongPassword999",
            }, { "x-forwarded-for": "10.0.5.2" });

            // Path B: unknown email (new registration attempt, blocked)
            const resUnknown = await req("POST", "/api/register", {
                name: "Unknown User",
                email: "nobody@example.com",     // ← unknown email
                password: "SomePass123",
            }, { "x-forwarded-for": "10.0.5.3" });

            // Both paths MUST return the same status code
            expect(resExisting.status).toBe(403);
            expect(resUnknown.status).toBe(403);

            // Both paths MUST return the same error body
            const bodyExisting = await resExisting.json();
            const bodyUnknown = await resUnknown.json();
            expect(bodyExisting.error).toBe("Registration is not available.");
            expect(bodyUnknown.error).toBe("Registration is not available.");
            expect(bodyExisting.error).toBe(bodyUnknown.error);
        } finally {
            initAuth({
                dbPath,
                baseURL: BASE,
                secret: "test-secret-for-e2e-at-least-32-chars-long!!",
                disableSignupAfterFirstUser: false,
            });
            try { rmSync(enumDir, { recursive: true, force: true }); } catch {}
        }
    });

    test("existing email + correct password still succeeds when signups disabled", async () => {
        // Set up a fresh DB with gating enabled
        const enumDir2 = mkdtempSync(join(tmpdir(), "pizzapi-e2e-enum2-"));
        const enumDbPath2 = join(enumDir2, "enum2.db");

        try {
            initAuth({
                dbPath: enumDbPath2,
                baseURL: BASE,
                secret: "test-secret-for-e2e-at-least-32-chars-long!!",
                disableSignupAfterFirstUser: true,
            });
            await runAllMigrations();

            // Register the first user
            const reg = await req("POST", "/api/register", {
                name: "Returning User",
                email: "returning@example.com",
                password: "ReturnPass123",
            }, { "x-forwarded-for": "10.0.6.1" });
            expect(reg.status).toBe(200);

            // Re-register with correct credentials — should succeed (key rotation)
            const reReg = await req("POST", "/api/register", {
                email: "returning@example.com",
                password: "ReturnPass123",
            }, { "x-forwarded-for": "10.0.6.2" });
            expect(reReg.status).toBe(200);
            const data = await reReg.json();
            expect(data.ok).toBe(true);
            expect(typeof data.key).toBe("string");
        } finally {
            initAuth({
                dbPath,
                baseURL: BASE,
                secret: "test-secret-for-e2e-at-least-32-chars-long!!",
                disableSignupAfterFirstUser: false,
            });
            try { rmSync(enumDir2, { recursive: true, force: true }); } catch {}
        }
    });
});

// ── Change password validation ────────────────────────────────────────────────

describe("E2E: change-password enforces password policy", () => {
    const cpUser = {
        name: "ChangePass User",
        email: "changepass@example.com",
        password: "OldPass123",
    };
    let sessionHeaders: Record<string, string>;

    beforeAll(async () => {
        // Register user
        const regRes = await req("POST", "/api/register", cpUser, { "x-forwarded-for": "10.0.4.1" });
        expect(regRes.status).toBe(200);

        // Sign in to get a session cookie
        const signInRes = await req("POST", "/api/auth/sign-in/email", {
            email: cpUser.email,
            password: cpUser.password,
        });
        expect(signInRes.status).toBe(200);

        // Extract set-cookie header for subsequent requests
        const cookies = signInRes.headers.getSetCookie();
        sessionHeaders = { cookie: cookies.join("; ") };
    });

    test("rejects weak new password", async () => {
        const res = await req("POST", "/api/auth/change-password", {
            currentPassword: cpUser.password,
            newPassword: "weak",
        }, sessionHeaders);
        expect(res.status).toBe(400);
        const data = await res.json();
        expect(data.error).toContain("Password must be");
    });

    test("rejects password without uppercase", async () => {
        const res = await req("POST", "/api/auth/change-password", {
            currentPassword: cpUser.password,
            newPassword: "alllowercase1",
        }, sessionHeaders);
        expect(res.status).toBe(400);
    });

    test("rejects password without number", async () => {
        const res = await req("POST", "/api/auth/change-password", {
            currentPassword: cpUser.password,
            newPassword: "NoNumberHere",
        }, sessionHeaders);
        expect(res.status).toBe(400);
    });

    test("accepts valid new password", async () => {
        const res = await req("POST", "/api/auth/change-password", {
            currentPassword: cpUser.password,
            newPassword: "NewSecure1",
        }, sessionHeaders);
        // Should be 200 (success) — better-auth returns the updated status
        expect(res.status).toBe(200);
    });
});
