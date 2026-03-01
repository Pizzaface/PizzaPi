/**
 * E2E test: signup → API key → authenticated requests
 *
 * This test needs process isolation because it sets env vars before importing
 * server modules. When run as part of `bun test packages/server`, it spawns
 * itself in a subprocess to ensure clean module loading.
 *
 * Run directly: bun test tests/e2e/signup.test.ts
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";

// Detect if we're running as a subprocess (with env already set) or need to spawn one
const isSubprocess = process.env.__PIZZAPI_E2E_SUBPROCESS === "1";

if (!isSubprocess) {
    // When run in batch mode, just spawn ourselves as a subprocess
    describe("E2E: signup (subprocess)", () => {
        test("runs signup E2E tests in isolated subprocess", async () => {
            const result = Bun.spawnSync({
                cmd: ["bun", "test", import.meta.path],
                env: { ...process.env, __PIZZAPI_E2E_SUBPROCESS: "1" },
                cwd: import.meta.dir + "/../..",
                stdout: "pipe",
                stderr: "pipe",
            });
            const output = result.stdout.toString() + result.stderr.toString();
            if (result.exitCode !== 0) {
                console.error(output);
            }
            expect(result.exitCode).toBe(0);
        }, 30_000);
    });
} else {
    // ── Actual E2E tests (running in isolated subprocess) ─────────────────

    const { mkdtempSync, rmSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");

    // Set up temp DB BEFORE importing any server modules
    const tmpDir = mkdtempSync(join(tmpdir(), "pizzapi-e2e-"));
    const dbPath = join(tmpDir, "test.db");
    process.env.AUTH_DB_PATH = dbPath;
    process.env.BETTER_AUTH_SECRET = "test-secret-for-e2e-at-least-32-chars-long!!";
    process.env.BETTER_AUTH_BASE_URL = "http://localhost:7777";
    process.env.PIZZAPI_DISABLE_SIGNUP_AFTER_FIRST_USER = "false";

    const { runAllMigrations } = await import("../../src/migrations.js");
    const { handleFetch } = await import("../../src/handler.js");
    const { kysely } = await import("../../src/auth.js");

    const BASE = "http://localhost:7777";

    async function req(method: string, path: string, body?: any, headers?: Record<string, string>): Promise<Response> {
        const init: RequestInit = {
            method,
            headers: { "content-type": "application/json", ...headers },
        };
        if (body) init.body = JSON.stringify(body);
        return handleFetch(new Request(`${BASE}${path}`, init));
    }

    beforeAll(async () => {
        await runAllMigrations();
    });

    afterAll(() => {
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
            const { auth } = await import("../../src/auth.js");
            const result = await auth.api.verifyApiKey({ body: { key: apiKey } });
            expect(result.valid).toBe(true);
            expect(result.key?.userId).toBeTruthy();
        });

        test("invalid API key fails verification", async () => {
            const { auth } = await import("../../src/auth.js");
            const result = await auth.api.verifyApiKey({ body: { key: "bad-key" } }).catch(() => ({ valid: false }));
            expect(result.valid).toBe(false);
        });

        test("API key is stored in DB with correct metadata", async () => {
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
            expect(res.status).toBe(200);
            const data = await res.json();
            expect(data.status).toBe("ok");
        });
    });
}
