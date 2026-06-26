/**
 * E2E test: QR-code setup claim lifecycle.
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

const tmpDir = mkdtempSync(join(tmpdir(), "pizzapi-e2e-setup-claims-"));
const dbPath = join(tmpDir, "test.db");
const BASE = "http://localhost:7492";

let reqCounter = 0;

const authConfig: AuthConfig = {
    dbPath,
    baseURL: BASE,
    secret: "test-secret-for-e2e-at-least-32-chars-long!!",
    disableSignupAfterFirstUser: false,
};
const authContext = createTestAuthContext(authConfig);

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

describe("E2E: /api/setup-claim lifecycle", () => {
    const testUser = {
        name: "QR Test",
        email: "qrtest@example.com",
        password: "SecurePass123",
    };
    let cookie = "";

    test("sign up to obtain a session cookie", async () => {
        const res = await req("POST", "/api/register", testUser);
        expect(res.status).toBe(200);
        const data = (await res.json()) as { ok: boolean; key: string };
        expect(data.ok).toBe(true);

        // Sign in via better-auth to get a session cookie.
        const signIn = await req("POST", "/api/auth/sign-in/email", {
            email: testUser.email,
            password: testUser.password,
        });
        expect(signIn.status).toBe(200);
        const setCookie = signIn.headers.get("set-cookie");
        expect(setCookie).toBeTruthy();
        cookie = setCookie!.split(";")[0];
    });

    test("POST /api/setup-claim creates a pending claim", async () => {
        const res = await req("POST", "/api/setup-claim", { relayUrl: BASE });
        expect(res.status).toBe(200);
        const data = (await res.json()) as { token: string; expiresAt: string };
        expect(data.token.length).toBeGreaterThan(30);
        expect(new Date(data.expiresAt).getTime()).toBeGreaterThan(Date.now());
    });

    test("POST /api/setup-claim rejects missing relayUrl", async () => {
        const res = await req("POST", "/api/setup-claim", {});
        expect(res.status).toBe(400);
    });

    test("GET /api/setup-claim/:token returns pending", async () => {
        const created = await req("POST", "/api/setup-claim", { relayUrl: BASE });
        const { token } = (await created.json()) as { token: string };

        const res = await req("GET", `/api/setup-claim/${token}`);
        expect(res.status).toBe(200);
        const data = (await res.json()) as { status: string; apiKey?: string };
        expect(data.status).toBe("pending");
        expect(data.apiKey).toBeUndefined();
    });

    test("POST /api/setup-claim/:token/approve requires session", async () => {
        const created = await req("POST", "/api/setup-claim", { relayUrl: BASE });
        const { token } = (await created.json()) as { token: string };

        const res = await req("POST", `/api/setup-claim/${token}/approve`);
        expect(res.status).toBe(401);
    });

    test("approve then poll redeems the claim", async () => {
        const created = await req("POST", "/api/setup-claim", { relayUrl: BASE });
        const { token } = (await created.json()) as { token: string };

        const approve = await req("POST", `/api/setup-claim/${token}/approve`, undefined, { cookie });
        expect(approve.status).toBe(200);
        const approveBody = (await approve.json()) as { ok: boolean };
        expect(approveBody.ok).toBe(true);

        const poll1 = await req("GET", `/api/setup-claim/${token}`);
        expect(poll1.status).toBe(200);
        const body1 = (await poll1.json()) as { status: string; apiKey?: string };
        expect(body1.status).toBe("approved");
        expect(body1.apiKey).toMatch(/^[0-9a-f]{64}$/);

        const poll2 = await req("GET", `/api/setup-claim/${token}`);
        const body2 = (await poll2.json()) as { status: string; apiKey?: string };
        expect(body2.status).toBe("redeemed");
        expect(body2.apiKey).toBeUndefined();
    });

    test("approved API key authenticates a request", async () => {
        const created = await req("POST", "/api/setup-claim", { relayUrl: BASE });
        const { token } = (await created.json()) as { token: string };

        await req("POST", `/api/setup-claim/${token}/approve`, undefined, { cookie });
        const poll = await req("GET", `/api/setup-claim/${token}`);
        const { apiKey } = (await poll.json()) as { apiKey: string };

        const me = await req("GET", "/api/settings/hidden-models", undefined, { "x-api-key": apiKey });
        expect(me.status).toBe(200);
        const body = (await me.json()) as { hiddenModels: string[] };
        expect(Array.isArray(body.hiddenModels)).toBe(true);
    });
});
