import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
    readKeychainCredentials,
    readKeychainEntry,
    enumerateKeychainAccounts,
    readCredentialsFile,
    readBestExternalCredential,
    parseCredentialsJson,
    pickFreshestCredential,
    toAuthCredential,
    isKeychainFresher,
    syncKeychainToAuthJsonFile,
    type KeychainCredentials,
} from "./keychain-auth.js";

// ── Helper: build a valid credentials payload ──────────────────────────────

function makeCredentials(overrides: {
    accessToken?: string;
    refreshToken?: string;
    expiresAt?: number;
    orgUuid?: string;
} = {}): KeychainCredentials {
    return {
        claudeAiOauth: {
            accessToken: overrides.accessToken ?? "sk-ant-oat01-test-access-token",
            refreshToken: overrides.refreshToken ?? "sk-ant-ort01-test-refresh-token",
            expiresAt: overrides.expiresAt ?? Date.now() + 3_600_000, // 1h from now
        },
        ...(overrides.orgUuid ? { organizationUuid: overrides.orgUuid } : {}),
    };
}

// ── parseCredentialsJson ───────────────────────────────────────────────────

describe("parseCredentialsJson", () => {
    test("parses valid credentials JSON", () => {
        const cred = makeCredentials();
        const result = parseCredentialsJson(JSON.stringify(cred));
        expect(result).not.toBeNull();
        expect(result!.claudeAiOauth!.accessToken).toBe(cred.claudeAiOauth!.accessToken);
        expect(result!.claudeAiOauth!.refreshToken).toBe(cred.claudeAiOauth!.refreshToken);
        expect(result!.claudeAiOauth!.expiresAt).toBe(cred.claudeAiOauth!.expiresAt);
    });

    test("returns null for invalid JSON", () => {
        expect(parseCredentialsJson("not json")).toBeNull();
    });

    test("returns null for empty string", () => {
        expect(parseCredentialsJson("")).toBeNull();
    });

    test("returns null when claudeAiOauth is missing", () => {
        expect(parseCredentialsJson(JSON.stringify({ organizationUuid: "abc" }))).toBeNull();
    });

    test("returns null when accessToken is missing", () => {
        const data = {
            claudeAiOauth: {
                refreshToken: "tok",
                expiresAt: Date.now() + 3600000,
            },
        };
        expect(parseCredentialsJson(JSON.stringify(data))).toBeNull();
    });

    test("returns null when refreshToken is missing", () => {
        const data = {
            claudeAiOauth: {
                accessToken: "tok",
                expiresAt: Date.now() + 3600000,
            },
        };
        expect(parseCredentialsJson(JSON.stringify(data))).toBeNull();
    });

    test("returns null when expiresAt is not a number", () => {
        const data = {
            claudeAiOauth: {
                accessToken: "tok",
                refreshToken: "tok",
                expiresAt: "not-a-number",
            },
        };
        expect(parseCredentialsJson(JSON.stringify(data))).toBeNull();
    });

    test("preserves organizationUuid", () => {
        const cred = makeCredentials({ orgUuid: "org-123" });
        const result = parseCredentialsJson(JSON.stringify(cred));
        expect(result!.organizationUuid).toBe("org-123");
    });
});

// ── pickFreshestCredential ─────────────────────────────────────────────────

describe("pickFreshestCredential", () => {
    test("returns null for empty array", () => {
        expect(pickFreshestCredential([])).toBeNull();
    });

    test("returns the only credential", () => {
        const cred = makeCredentials();
        expect(pickFreshestCredential([cred])).toBe(cred);
    });

    test("picks the freshest non-expired credential", () => {
        const now = Date.now();
        const stale = makeCredentials({ expiresAt: now + 1_000_000 });
        const fresh = makeCredentials({ expiresAt: now + 5_000_000 });
        const middle = makeCredentials({ expiresAt: now + 3_000_000 });

        expect(pickFreshestCredential([stale, fresh, middle])).toBe(fresh);
    });

    test("prefers non-expired over expired even if expired is later", () => {
        const now = Date.now();
        const expired = makeCredentials({ expiresAt: now - 1000 });
        const valid = makeCredentials({ expiresAt: now + 1000 });

        // Even though the expired one might have a higher expiresAt in some
        // edge case, a valid one should always win.
        expect(pickFreshestCredential([expired, valid])).toBe(valid);
    });

    test("falls back to freshest expired when all are expired", () => {
        const now = Date.now();
        const old = makeCredentials({ expiresAt: now - 3_600_000 });
        const recent = makeCredentials({ expiresAt: now - 60_000 });

        expect(pickFreshestCredential([old, recent])).toBe(recent);
    });
});

// ── isKeychainFresher ──────────────────────────────────────────────────────

describe("isKeychainFresher", () => {
    test("returns true when external is meaningfully fresher", () => {
        const now = Date.now();
        expect(isKeychainFresher(now + 3_600_000, now + 1_800_000)).toBe(true);
    });

    test("returns false when external is only slightly fresher (under threshold)", () => {
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

// ── toAuthCredential ───────────────────────────────────────────────────────

describe("toAuthCredential", () => {
    test("maps credential format to auth.json format", () => {
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

// ── readCredentialsFile ────────────────────────────────────────────────────

describe("readCredentialsFile", () => {
    let tmpDir: string;

    beforeEach(() => {
        tmpDir = mkdtempSync(join(tmpdir(), "cred-file-test-"));
    });

    afterEach(() => {
        try {
            rmSync(tmpDir, { recursive: true, force: true });
        } catch {}
    });

    test("returns null for non-existent file", () => {
        expect(readCredentialsFile(join(tmpDir, "missing.json"))).toBeNull();
    });

    test("returns null for empty file", () => {
        const path = join(tmpDir, "empty.json");
        writeFileSync(path, "");
        expect(readCredentialsFile(path)).toBeNull();
    });

    test("returns null for invalid JSON", () => {
        const path = join(tmpDir, "bad.json");
        writeFileSync(path, "not json {{{");
        expect(readCredentialsFile(path)).toBeNull();
    });

    test("returns null for JSON missing required fields", () => {
        const path = join(tmpDir, "partial.json");
        writeFileSync(path, JSON.stringify({ claudeAiOauth: { accessToken: "tok" } }));
        expect(readCredentialsFile(path)).toBeNull();
    });

    test("reads valid credentials file", () => {
        const cred = makeCredentials({ orgUuid: "org-456" });
        const path = join(tmpDir, "valid.json");
        writeFileSync(path, JSON.stringify(cred));

        const result = readCredentialsFile(path);
        expect(result).not.toBeNull();
        expect(result!.claudeAiOauth!.accessToken).toBe(cred.claudeAiOauth!.accessToken);
        expect(result!.claudeAiOauth!.refreshToken).toBe(cred.claudeAiOauth!.refreshToken);
        expect(result!.claudeAiOauth!.expiresAt).toBe(cred.claudeAiOauth!.expiresAt);
        expect(result!.organizationUuid).toBe("org-456");
    });
});

// ── readKeychainCredentials / readKeychainEntry ────────────────────────────

describe("readKeychainCredentials", () => {
    test("returns null on non-darwin platforms", () => {
        // On non-macOS this returns null immediately.
        // On macOS, it exercises the real keychain — we can't guarantee the entry exists.
        if (process.platform !== "darwin") {
            expect(readKeychainCredentials()).toBeNull();
        }
    });
});

describe("readKeychainEntry", () => {
    test("returns null on non-darwin platforms", () => {
        if (process.platform !== "darwin") {
            expect(readKeychainEntry("Claude Code-credentials")).toBeNull();
        }
    });

    test("returns null for non-existent service", () => {
        if (process.platform !== "darwin") return;
        expect(readKeychainEntry("PizzaPi-nonexistent-test-entry-12345")).toBeNull();
    });
});

describe("enumerateKeychainAccounts", () => {
    test("returns empty array on non-darwin platforms", () => {
        if (process.platform !== "darwin") {
            expect(enumerateKeychainAccounts()).toEqual([]);
        }
    });

    test("returns array of accounts on macOS (if any exist)", () => {
        if (process.platform !== "darwin") return;
        const accounts = enumerateKeychainAccounts();
        // We can't guarantee accounts exist, but the result should be an array
        expect(Array.isArray(accounts)).toBe(true);
        for (const acct of accounts) {
            expect(acct.serviceName).toBeDefined();
            expect(acct.credentials.claudeAiOauth).toBeDefined();
        }
    });
});

// ── readBestExternalCredential ─────────────────────────────────────────────

describe("readBestExternalCredential", () => {
    // This test exercises the real system — results depend on platform and
    // whether credentials exist. We just verify the shape.
    test("returns null or a properly shaped result", () => {
        const result = readBestExternalCredential();
        if (result === null) {
            // No credentials anywhere — acceptable
            return;
        }
        expect(result.credentials.claudeAiOauth).toBeDefined();
        expect(result.source).toMatch(/^(keychain|credentials-file)$/);
        expect(typeof result.sourceLabel).toBe("string");
    });
});

// ── syncKeychainToAuthJsonFile ─────────────────────────────────────────────

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

    test("updates auth.json when external credential is fresher", () => {
        // Try to get a real credential from any source
        const ext = readBestExternalCredential();
        if (!ext?.credentials.claudeAiOauth) return; // No credentials — skip

        const authPath = join(tmpDir, "auth.json");
        // Write auth.json with an older expiry
        const oldExpiry = ext.credentials.claudeAiOauth.expiresAt - 600_000; // 10 min older
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
        expect(result.anthropic.access).toBe(ext.credentials.claudeAiOauth.accessToken);
        expect(result.anthropic.refresh).toBe(ext.credentials.claudeAiOauth.refreshToken);
        expect(result.anthropic.expires).toBe(ext.credentials.claudeAiOauth.expiresAt);
    });

    test("preserves other providers when updating anthropic", () => {
        const ext = readBestExternalCredential();
        if (!ext?.credentials.claudeAiOauth) return;

        const authPath = join(tmpDir, "auth.json");
        const oldExpiry = ext.credentials.claudeAiOauth.expiresAt - 600_000;
        writeFileSync(
            authPath,
            JSON.stringify({
                anthropic: { type: "oauth", access: "old", refresh: "old", expires: oldExpiry },
                "google-gemini-cli": {
                    type: "oauth",
                    access: "gemini-token",
                    refresh: "gemini-refresh",
                    expires: 9999999999999,
                },
            }),
        );

        syncKeychainToAuthJsonFile(authPath);

        const result = JSON.parse(readFileSync(authPath, "utf-8"));
        // Anthropic updated
        expect(result.anthropic.access).toBe(ext.credentials.claudeAiOauth.accessToken);
        // Gemini preserved
        expect(result["google-gemini-cli"].access).toBe("gemini-token");
    });

    test("does not update when auth.json is already fresher", () => {
        const ext = readBestExternalCredential();
        if (!ext?.credentials.claudeAiOauth) return;

        const authPath = join(tmpDir, "auth.json");
        // Auth.json expiry is WAY in the future
        writeFileSync(
            authPath,
            JSON.stringify({
                anthropic: {
                    type: "oauth",
                    access: "super-fresh",
                    refresh: "super-refresh",
                    expires: Date.now() + 999_999_999,
                },
            }),
        );

        const updated = syncKeychainToAuthJsonFile(authPath);
        expect(updated).toBe(false);

        const result = JSON.parse(readFileSync(authPath, "utf-8"));
        expect(result.anthropic.access).toBe("super-fresh"); // unchanged
    });

    test("handles missing auth.json gracefully", () => {
        const ext = readBestExternalCredential();
        if (!ext?.credentials.claudeAiOauth) return;

        const authPath = join(tmpDir, "auth.json");
        // File doesn't exist — should create it
        const updated = syncKeychainToAuthJsonFile(authPath);
        expect(updated).toBe(true);

        const result = JSON.parse(readFileSync(authPath, "utf-8"));
        expect(result.anthropic.type).toBe("oauth");
        expect(result.anthropic.access).toBe(ext.credentials.claudeAiOauth.accessToken);
    });
});
