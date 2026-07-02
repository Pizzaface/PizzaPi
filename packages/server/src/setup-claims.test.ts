import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTestAuthContext } from "./auth.js";
import { runAllMigrations } from "./migrations.js";
import {
    createSetupClaim,
    pollSetupClaim,
    approveSetupClaim,
    sweepExpiredSetupClaims,
} from "./setup-claims.js";
import { runWithAuthContext } from "./auth.js";

const tmpDir = mkdtempSync(join(tmpdir(), "pizzapi-setup-claims-"));
const dbPath = join(tmpDir, "test.db");
const authContext = createTestAuthContext({ dbPath, baseURL: "http://localhost:7492" });

beforeAll(async () => {
    await runAllMigrations(authContext);
});

afterAll(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

describe("setup-claims store", () => {
    test("creates a pending claim", async () => {
        await runWithAuthContext(authContext, async () => {
            const { token, expiresAt } = await createSetupClaim("http://localhost:7492");
            expect(token.length).toBeGreaterThan(30);
            expect(new Date(expiresAt).getTime()).toBeGreaterThan(Date.now());

            const status = await pollSetupClaim(token);
            expect(status).not.toBeNull();
            expect(status!.status).toBe("pending");
            expect(status!.apiKey).toBeUndefined();
        });
    });

    test("approving stores an API key and polling redeems it", async () => {
        await runWithAuthContext(authContext, async () => {
            const { token } = await createSetupClaim("http://localhost:7492");
            const approve = await approveSetupClaim(token, "user-1", "Jordan");
            expect(approve).not.toBeNull();
            expect(approve!.apiKey.length).toBe(64);

            const first = await pollSetupClaim(token);
            expect(first!.status).toBe("approved");
            expect(first!.apiKey).toBe(approve!.apiKey);

            const second = await pollSetupClaim(token);
            expect(second!.status).toBe("redeemed");
            expect(second!.apiKey).toBeUndefined();
        });
    });

    test("unknown token returns null", async () => {
        await runWithAuthContext(authContext, async () => {
            const status = await pollSetupClaim("definitely-not-a-token");
            expect(status).toBeNull();
        });
    });

    test("expired claims are rejected", async () => {
        await runWithAuthContext(authContext, async () => {
            const { token } = await createSetupClaim("http://localhost:7492");
            // Force expiry by rewriting the row.
            const { getKysely } = await import("./auth.js");
            await getKysely()
                .updateTable("setup_claim")
                .set({ expiresAt: new Date(Date.now() - 1000).toISOString() })
                .where("id", "=", token)
                .execute();

            const status = await pollSetupClaim(token);
            expect(status!.status).toBe("expired");
        });
    });

    test("approval fails for already-approved claims", async () => {
        await runWithAuthContext(authContext, async () => {
            const { token } = await createSetupClaim("http://localhost:7492");
            const first = await approveSetupClaim(token, "user-1", "Jordan");
            expect(first).not.toBeNull();
            const second = await approveSetupClaim(token, "user-2", "Other");
            expect(second).toBeNull();
        });
    });
});
