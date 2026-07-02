import { beforeAll, afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTestAuthContext, runWithAuthContext } from "./auth.js";
import { runAllMigrations } from "./migrations.js";
import { approveMobileLink, createMobileLink, getMobileLink, redeemMobileLink, scanMobileLink } from "./mobile-links.js";
import { handleMobileLinksRoute } from "./routes/mobile-links.js";

const tmpDir = mkdtempSync(join(tmpdir(), "pizzapi-mobile-links-"));
const dbPath = join(tmpDir, "test.db");
const authContext = createTestAuthContext({ dbPath, baseURL: "http://localhost:7492" });

beforeAll(async () => {
    await runAllMigrations(authContext);
});

afterAll(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

describe("mobile-links route", () => {
    test("answers mobile WebView CORS preflight for scan endpoint", async () => {
        const url = new URL("http://localhost:7492/api/mobile-link/link123/scan");
        const res = await handleMobileLinksRoute(new Request(url, {
            method: "OPTIONS",
            headers: {
                origin: "capacitor://localhost",
                "access-control-request-method": "POST",
                "access-control-request-headers": "content-type",
            },
        }), url);
        expect(res!.status).toBe(204);
        expect(res!.headers.get("access-control-allow-origin")).toBe("capacitor://localhost");
        expect(res!.headers.get("access-control-allow-methods")).toContain("POST");
        expect(res!.headers.get("access-control-allow-headers")).toContain("Content-Type");
    });
});

describe("mobile-links store", () => {
    test("links only after mobile scan and web approval", async () => {
        await runWithAuthContext(authContext, async () => {
            const pending = await createMobileLink("http://localhost:7492", "user-1", "Jordan");
            expect(pending.status).toBe("pending");
            expect(pending.verificationToken).toBeUndefined();

            const scanned = await scanMobileLink(pending.id, {
                verificationToken: "ABC123",
                deviceName: "Pixel",
                scannedUrl: "http://localhost:7492/mobile-link?id=" + pending.id,
            });
            expect(scanned!.status).toBe("scanned");
            expect(scanned!.verificationToken).toBe("ABC123");
            expect(scanned!.deviceName).toBe("Pixel");

            const wrongUser = await approveMobileLink(pending.id, "user-2");
            expect(wrongUser).toBeNull();

            const approved = await approveMobileLink(pending.id, "user-1");
            expect(approved!.status).toBe("approved");
            expect(approved!.apiKey).toBeUndefined();

            const final = await getMobileLink(pending.id);
            expect(final!.status).toBe("approved");

            const redeemed = await redeemMobileLink(pending.id);
            expect(redeemed!.status).toBe("approved");
            expect(redeemed!.apiKey).toMatch(/^[a-f0-9]{64}$/);

            const secondRedeem = await redeemMobileLink(pending.id);
            expect(secondRedeem!.apiKey).toBeUndefined();
        });
    });
});
