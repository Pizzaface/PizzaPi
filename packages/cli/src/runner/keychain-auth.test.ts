import { describe, test, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
    readKeychainCredentials,
    toAuthCredential,
    isKeychainFresher,
    syncKeychainToAuthJsonFile,
} from "./keychain-auth.js";

describe("keychain-auth", () => {
    describe("isKeychainFresher", () => {
        test("returns true when keychain is meaningfully fresher", () => {
            const now = Date.now();
            expect(isKeychainFresher(now + 3_600_000, now + 1_800_000)).toBe(true);
        });

        test("returns false when keychain is only slightly fresher (under threshold)", () => {
            const now = Date.now();
            // 30s difference — under the 60s threshold
            expect(isKeychainFresher(now + 1_830_000, now + 1_800_000)).toBe(false);
        });

        test("returns false when auth.json is fresher", () => {
            const now = Date.now();
            expect(isKeychainFresher(now + 1_000_000, now + 2_000_000)).toBe(false);
        });

        test("returns false when both are equal", () => {
            const ts = Date.now() + 3_600_000;
            expect(isKeychainFresher(ts, ts)).toBe(false);
        });

        test("returns true when auth.json has no expiry (0)", () => {
            expect(isKeychainFresher(Date.now() + 3_600_000, 0)).toBe(true);
        });
    });

    describe("toAuthCredential", () => {
        test("maps keychain format to auth.json format", () => {
            const keychainOAuth = {
                accessToken: "sk-ant-oat01-abc123",
                refreshToken: "sk-ant-ort01-xyz789",
                expiresAt: 1775514875888,
                scopes: ["user:inference"],
                subscriptionType: "max",
            };

            const credential = toAuthCredential(keychainOAuth);

            expect(credential.type).toBe("oauth");
            expect((credential as any).access).toBe("sk-ant-oat01-abc123");
            expect((credential as any).refresh).toBe("sk-ant-ort01-xyz789");
            expect((credential as any).expires).toBe(1775514875888);
        });
    });

    describe("readKeychainCredentials", () => {
        test("returns null on non-darwin platforms", () => {
            // If we're on macOS this test still works because it exercises
            // the actual keychain read — we just can't guarantee the entry
            // exists. On Linux/CI it should return null immediately.
            if (process.platform !== "darwin") {
                expect(readKeychainCredentials()).toBeNull();
            }
            // On darwin, we don't assert — the real keychain might or might not have the entry.
        });
    });

    describe("syncKeychainToAuthJsonFile", () => {
        let tmpDir: string;

        beforeEach(() => {
            tmpDir = mkdtempSync(join(tmpdir(), "keychain-auth-test-"));
        });

        afterEach(() => {
            try {
                rmSync(tmpDir, { recursive: true, force: true });
            } catch {}
        });

        test("updates auth.json when keychain is fresher", () => {
            // Skip on non-macOS or when Keychain entry doesn't exist
            if (process.platform !== "darwin") return;

            const kc = readKeychainCredentials();
            if (!kc?.claudeAiOauth) return; // No keychain entry — skip

            const authPath = join(tmpDir, "auth.json");
            // Write auth.json with an older expiry
            const oldExpiry = kc.claudeAiOauth.expiresAt - 600_000; // 10 min older
            writeFileSync(
                authPath,
                JSON.stringify({
                    anthropic: {
                        type: "oauth",
                        access: "old-token",
                        refresh: "old-refresh",
                        expires: oldExpiry,
                    },
                }),
            );

            const updated = syncKeychainToAuthJsonFile(authPath);
            expect(updated).toBe(true);

            const result = JSON.parse(readFileSync(authPath, "utf-8"));
            expect(result.anthropic.access).toBe(kc.claudeAiOauth.accessToken);
            expect(result.anthropic.refresh).toBe(kc.claudeAiOauth.refreshToken);
            expect(result.anthropic.expires).toBe(kc.claudeAiOauth.expiresAt);
        });

        test("preserves other providers when updating anthropic", () => {
            if (process.platform !== "darwin") return;

            const kc = readKeychainCredentials();
            if (!kc?.claudeAiOauth) return;

            const authPath = join(tmpDir, "auth.json");
            const oldExpiry = kc.claudeAiOauth.expiresAt - 600_000;
            writeFileSync(
                authPath,
                JSON.stringify({
                    anthropic: { type: "oauth", access: "old", refresh: "old", expires: oldExpiry },
                    "google-gemini-cli": { type: "oauth", access: "gemini-token", refresh: "gemini-refresh", expires: 9999999999999 },
                }),
            );

            syncKeychainToAuthJsonFile(authPath);

            const result = JSON.parse(readFileSync(authPath, "utf-8"));
            // Anthropic updated
            expect(result.anthropic.access).toBe(kc.claudeAiOauth.accessToken);
            // Gemini preserved
            expect(result["google-gemini-cli"].access).toBe("gemini-token");
        });

        test("does not update when auth.json is already fresher", () => {
            if (process.platform !== "darwin") return;

            const kc = readKeychainCredentials();
            if (!kc?.claudeAiOauth) return;

            const authPath = join(tmpDir, "auth.json");
            // Auth.json expiry is WAY in the future
            writeFileSync(
                authPath,
                JSON.stringify({
                    anthropic: { type: "oauth", access: "super-fresh", refresh: "super-refresh", expires: Date.now() + 999_999_999 },
                }),
            );

            const updated = syncKeychainToAuthJsonFile(authPath);
            expect(updated).toBe(false);

            const result = JSON.parse(readFileSync(authPath, "utf-8"));
            expect(result.anthropic.access).toBe("super-fresh"); // unchanged
        });

        test("handles missing auth.json gracefully", () => {
            if (process.platform !== "darwin") return;

            const kc = readKeychainCredentials();
            if (!kc?.claudeAiOauth) return;

            const authPath = join(tmpDir, "auth.json");
            // File doesn't exist — should create it
            const updated = syncKeychainToAuthJsonFile(authPath);
            expect(updated).toBe(true);

            const result = JSON.parse(readFileSync(authPath, "utf-8"));
            expect(result.anthropic.type).toBe("oauth");
            expect(result.anthropic.access).toBe(kc.claudeAiOauth.accessToken);
        });
    });
});
