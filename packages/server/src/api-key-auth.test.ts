import { beforeAll, afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTestAuthContext, runWithAuthContext } from "./auth.js";
import { runAllMigrations } from "./migrations.js";
import { handleApi } from "./routes/index.js";
import { mintEphemeralApiKey } from "./routes/utils.js";
import { validateApiKey } from "./middleware.js";

const tmpDir = mkdtempSync(join(tmpdir(), "pizzapi-apikey-auth-"));
const dbPath = join(tmpDir, "test.db");
const authContext = createTestAuthContext({ dbPath, baseURL: "http://localhost:7492" });

beforeAll(async () => {
    await runAllMigrations(authContext);
});

afterAll(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

let testUserId = "";

async function createTestUser(id: string): Promise<string> {
    return await runWithAuthContext(authContext, async () => {
        const created = await authContext.auth.api.signUpEmail({
            body: {
                email: `${id}@example.com`,
                password: "Password123!",
                name: id,
            },
        });
        if (!created.user?.id) throw new Error("Failed to create test user");
        return created.user.id;
    });
}

describe("API-key auth fallback", () => {
    test("requireSession falls back to x-api-key header", async () => {
        testUserId = await createTestUser("user-1");
        await runWithAuthContext(authContext, async () => {
            const key = await mintEphemeralApiKey(testUserId, "test-key", 60);
            const req = new Request("http://localhost:7492/api/me", {
                headers: { "x-api-key": key },
            });
            const res = await handleApi(req, new URL(req.url));
            expect(res).not.toBeUndefined();
            expect(res!.status).toBe(200);
            const body = await res!.json();
            expect(body.userId).toBe(testUserId);
            expect(typeof body.userName).toBe("string");
        });
    });

    test("/api/me rejects missing session and missing api key", async () => {
        await runWithAuthContext(authContext, async () => {
            const req = new Request("http://localhost:7492/api/me");
            const res = await handleApi(req, new URL(req.url));
            expect(res).not.toBeUndefined();
            expect(res!.status).toBe(401);
        });
    });

    test("validateApiKey rejects invalid keys", async () => {
        await runWithAuthContext(authContext, async () => {
            const req = new Request("http://localhost:7492/api/me", {
                headers: { "x-api-key": "invalid" },
            });
            const identity = await validateApiKey(req);
            expect(identity).toBeInstanceOf(Response);
        });
    });
});
