/**
 * E2E test: signup → API key → authenticated requests → signup gating
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTestAuthContext, type AuthConfig } from "../../src/auth.js";
import { ensureBetterAuthCoreTables } from "../harness/ensure-auth-tables.js";
import { runAllMigrations } from "../../src/migrations.js";
import { handleFetch } from "../../src/handler.js";
import { initStateRedis } from "../../src/ws/sio-state/index.js";

const savedTrustProxy = process.env.PIZZAPI_TRUST_PROXY;
process.env.PIZZAPI_TRUST_PROXY = "true";

const tmpDir = mkdtempSync(join(tmpdir(), "pizzapi-e2e-"));
const dbPath = join(tmpDir, "test.db");
const BASE = "http://localhost:7777";

let reqCounter = 0;

const defaultSignupAuthConfig: AuthConfig = {
    dbPath,
    baseURL: BASE,
    secret: "test-secret-for-e2e-at-least-32-chars-long!!",
    disableSignupAfterFirstUser: false,
};
let currentSignupAuthConfig: AuthConfig = { ...defaultSignupAuthConfig };
let authContext = createTestAuthContext(currentSignupAuthConfig);

function setSignupAuthConfig(config: Partial<AuthConfig> = {}): void {
    currentSignupAuthConfig = { ...defaultSignupAuthConfig, ...config };
}

function recreateSignupAuthContext(config: Partial<AuthConfig> = {}): void {
    authContext = createTestAuthContext({ ...currentSignupAuthConfig, ...config });
}

async function req(method: string, path: string, body?: any, headers?: Record<string, string>): Promise<Response> {
    const socketIp = headers?.["x-pizzapi-client-ip"] ?? `10.255.${Math.floor(reqCounter / 256) % 256}.${reqCounter % 256}`;
    reqCounter++;
    const init: RequestInit = {
        method,
        headers: { "content-type": "application/json", "x-pizzapi-client-ip": socketIp, ...headers },
    };
    if (body) init.body = JSON.stringify(body);
    return handleFetch(new Request(`${BASE}${path}`, init), authContext);
}

beforeAll(async () => {
    setSignupAuthConfig();
    recreateSignupAuthContext();
    await runAllMigrations(authContext);
    await ensureBetterAuthCoreTables(authContext.db);
    await initStateRedis();
});

afterAll(() => {
    if (savedTrustProxy === undefined) {
        delete process.env.PIZZAPI_TRUST_PROXY;
    } else {
        process.env.PIZZAPI_TRUST_PROXY = savedTrustProxy;
    }
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

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
        expect(data.key.length).toBe(64);
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
        const result = await authContext.auth.api.verifyApiKey({ body: { key: apiKey } });
        expect(result.valid).toBe(true);
        expect(result.key?.userId).toBeTruthy();
    });

    test("invalid API key fails verification", async () => {
        const result = await authContext.auth.api.verifyApiKey({ body: { key: "bad-key" } }).catch(() => ({ valid: false }));
        expect(result.valid).toBe(false);
    });

    test("API key is stored in DB with correct metadata", async () => {
        const rows = await authContext.db
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
        expect([200, 503]).toContain(res.status);
        const data = await res.json();
        expect(["ok", "degraded"]).toContain(data.status);
        expect(typeof data.redis).toBe("boolean");
        expect(typeof data.socketio).toBe("boolean");
        expect(typeof data.uptime).toBe("number");
    });
});

describe("E2E: key rotation", () => {
    const rotUser = {
        name: "Rotation User",
        email: "rotate@example.com",
        password: "RotatePass123",
    };

    test("old API key is invalidated after re-register", async () => {
        const res1 = await req("POST", "/api/register", rotUser, { "x-forwarded-for": "10.0.1.1" });
        expect(res1.status).toBe(200);
        const { key: firstKey } = await res1.json();

        const check1 = await authContext.auth.api.verifyApiKey({ body: { key: firstKey } });
        expect(check1.valid).toBe(true);

        const res2 = await req("POST", "/api/register", rotUser, { "x-forwarded-for": "10.0.1.2" });
        expect(res2.status).toBe(200);
        const { key: secondKey } = await res2.json();
        expect(secondKey).not.toBe(firstKey);

        const check2 = await authContext.auth.api.verifyApiKey({ body: { key: secondKey } });
        expect(check2.valid).toBe(true);

        const check3 = await authContext.auth.api.verifyApiKey({ body: { key: firstKey } }).catch(() => ({ valid: false }));
        expect(check3.valid).toBe(false);
    });
});

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

describe.serial("E2E: signup gating (disable after first user)", () => {
    test("when gating is enabled, second user registration is blocked", async () => {
        const gatedDir = mkdtempSync(join(tmpdir(), "pizzapi-e2e-gated-"));
        const gatedDbPath = join(gatedDir, "gated.db");

        try {
            setSignupAuthConfig({ dbPath: gatedDbPath, disableSignupAfterFirstUser: true });
            recreateSignupAuthContext();
            await runAllMigrations(authContext);
            await ensureBetterAuthCoreTables(authContext.db);

            const res1 = await req("POST", "/api/register", {
                name: "First User",
                email: "first@example.com",
                password: "FirstPass123",
            }, { "x-forwarded-for": "10.0.3.1" });
            expect(res1.status).toBe(200);
            const data1 = await res1.json();
            expect(data1.ok).toBe(true);

            const res2 = await req("POST", "/api/register", {
                name: "Second User",
                email: "second@example.com",
                password: "SecondPass123",
            }, { "x-forwarded-for": "10.0.3.2" });
            expect(res2.status).toBe(403);
            const data2 = await res2.json();
            expect(data2.error).toBe("Registration is not available.");

            const statusRes = await req("GET", "/api/signup-status");
            const statusData = await statusRes.json();
            expect(statusData.signupEnabled).toBe(false);
        } finally {
            setSignupAuthConfig();
            recreateSignupAuthContext();
            try { rmSync(gatedDir, { recursive: true, force: true }); } catch {}
        }
    });
});

describe.serial("E2E: /api/register does not leak account existence when signups disabled", () => {
    test("existing email + wrong password and unknown email both return identical 403", async () => {
        const enumDir = mkdtempSync(join(tmpdir(), "pizzapi-e2e-enum-"));
        const enumDbPath = join(enumDir, "enum.db");

        try {
            setSignupAuthConfig({ dbPath: enumDbPath, disableSignupAfterFirstUser: true });
            recreateSignupAuthContext();
            await runAllMigrations(authContext);
            await ensureBetterAuthCoreTables(authContext.db);

            const reg = await req("POST", "/api/register", {
                name: "Enum Test User",
                email: "enumtest@example.com",
                password: "EnumPass123",
            }, { "x-forwarded-for": "10.0.5.1" });
            expect(reg.status).toBe(200);

            const resExisting = await req("POST", "/api/register", {
                name: "Enum Test User",
                email: "enumtest@example.com",
                password: "WrongPassword999",
            }, { "x-forwarded-for": "10.0.5.2" });

            const resUnknown = await req("POST", "/api/register", {
                name: "Unknown User",
                email: "nobody@example.com",
                password: "SomePass123",
            }, { "x-forwarded-for": "10.0.5.3" });

            expect(resExisting.status).toBe(403);
            expect(resUnknown.status).toBe(403);

            const bodyExisting = await resExisting.json();
            const bodyUnknown = await resUnknown.json();
            expect(bodyExisting.error).toBe("Registration is not available.");
            expect(bodyUnknown.error).toBe("Registration is not available.");
            expect(bodyExisting.error).toBe(bodyUnknown.error);
        } finally {
            setSignupAuthConfig();
            recreateSignupAuthContext();
            try { rmSync(enumDir, { recursive: true, force: true }); } catch {}
        }
    });

    test("existing email + correct password still succeeds when signups disabled", async () => {
        const enumDir2 = mkdtempSync(join(tmpdir(), "pizzapi-e2e-enum2-"));
        const enumDbPath2 = join(enumDir2, "enum2.db");

        try {
            setSignupAuthConfig({ dbPath: enumDbPath2, disableSignupAfterFirstUser: true });
            recreateSignupAuthContext();
            await runAllMigrations(authContext);
            await ensureBetterAuthCoreTables(authContext.db);

            const reg = await req("POST", "/api/register", {
                name: "Returning User",
                email: "returning@example.com",
                password: "ReturnPass123",
            }, { "x-forwarded-for": "10.0.6.1" });
            expect(reg.status).toBe(200);

            const reReg = await req("POST", "/api/register", {
                email: "returning@example.com",
                password: "ReturnPass123",
            }, { "x-forwarded-for": "10.0.6.2" });
            expect(reReg.status).toBe(200);
            const data = await reReg.json();
            expect(data.ok).toBe(true);
            expect(typeof data.key).toBe("string");
        } finally {
            setSignupAuthConfig();
            recreateSignupAuthContext();
            try { rmSync(enumDir2, { recursive: true, force: true }); } catch {}
        }
    });
});

describe("E2E: change-password enforces password policy", () => {
    const cpUser = {
        name: "ChangePass User",
        email: "changepass@example.com",
        password: "OldPass123",
    };
    let sessionHeaders: Record<string, string>;

    beforeAll(async () => {
        const regRes = await req("POST", "/api/register", cpUser, { "x-forwarded-for": "10.0.4.1" });
        expect(regRes.status).toBe(200);

        const signInRes = await req("POST", "/api/auth/sign-in/email", {
            email: cpUser.email,
            password: cpUser.password,
        });
        expect(signInRes.status).toBe(200);

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
            newPassword: "BetterPass456",
        }, sessionHeaders);
        expect(res.status).toBe(200);
    });
});
