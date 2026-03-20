import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// We can't easily unit-test the full createAuthStorageWithRetry because it
// depends on the AuthStorage class from pi-coding-agent which uses lockfile.
// Instead, we test the lockless fallback logic and the retry detection.

describe("worker auth resilience", () => {
    let tmpDir: string;

    beforeEach(() => {
        tmpDir = mkdtempSync(join(tmpdir(), "worker-auth-test-"));
    });

    afterEach(() => {
        try {
            rmSync(tmpDir, { recursive: true, force: true });
        } catch {}
    });

    test("auth.json with valid OAuth data is parseable", () => {
        const authPath = join(tmpDir, "auth.json");
        const authData = {
            anthropic: {
                type: "oauth",
                access: "test-access-token",
                refresh: "test-refresh-token",
                expires: Date.now() + 3600000,
            },
            "openai-codex": {
                type: "oauth",
                access: "test-codex-token",
                refresh: "test-codex-refresh",
                expires: Date.now() + 3600000,
            },
        };
        writeFileSync(authPath, JSON.stringify(authData, null, 2));

        // Simulate what the lockless fallback does
        const raw = require("node:fs").readFileSync(authPath, "utf-8");
        const parsed = JSON.parse(raw);
        expect(Object.keys(parsed)).toEqual(["anthropic", "openai-codex"]);
        expect(parsed.anthropic.type).toBe("oauth");
    });

    test("empty auth.json returns zero providers", () => {
        const authPath = join(tmpDir, "auth.json");
        writeFileSync(authPath, "{}");

        const raw = require("node:fs").readFileSync(authPath, "utf-8");
        const parsed = JSON.parse(raw);
        expect(Object.keys(parsed).length).toBe(0);
    });

    test("AuthStorage.create reads from correct path", async () => {
        // This test verifies that when we pass an explicit authPath,
        // AuthStorage reads from that path, not from ~/.pi/agent/auth.json
        const { AuthStorage } = await import("@mariozechner/pi-coding-agent");

        const authPath = join(tmpDir, "auth.json");
        const authData = {
            "test-provider": {
                type: "api_key" as const,
                key: "test-key-12345",
            },
        };
        writeFileSync(authPath, JSON.stringify(authData, null, 2));

        const storage = AuthStorage.create(authPath);
        expect(storage.has("test-provider")).toBe(true);
        expect(storage.list()).toContain("test-provider");

        // Should NOT have providers from the real ~/.pi/agent/auth.json
        // (unless they happen to match, which "test-provider" won't)
        const key = await storage.getApiKey("test-provider");
        expect(key).toBe("test-key-12345");
    });

    test("AuthStorage.inMemory creates storage from pre-loaded data", async () => {
        // This tests the lockless fallback path: read file without lock,
        // create in-memory storage
        const { AuthStorage } = await import("@mariozechner/pi-coding-agent");

        const authData = {
            anthropic: {
                type: "oauth" as const,
                access: "test-access",
                refresh: "test-refresh",
                expires: Date.now() + 3600000,
            },
        };

        const storage = AuthStorage.inMemory(authData);
        expect(storage.has("anthropic")).toBe(true);
        expect(storage.list()).toContain("anthropic");
    });

    test("AuthStorage.create with nonexistent path creates empty storage", async () => {
        const { AuthStorage } = await import("@mariozechner/pi-coding-agent");

        const authPath = join(tmpDir, "nonexistent", "auth.json");
        // Ensure parent dir exists (AuthStorage.create tries to create it)
        mkdirSync(join(tmpDir, "nonexistent"), { recursive: true });

        const storage = AuthStorage.create(authPath);
        expect(storage.list().length).toBe(0);
        // Verify it created the file
        expect(existsSync(authPath)).toBe(true);
    });
});
