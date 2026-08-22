import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getOAuthAccessToken, parseGeminiQuotaCredential } from "./usage-auth.js";

function writeImportedCredential(path: string, token: string, expiresAt: number, nested = true): void {
    mkdirSync(join(path, ".."), { recursive: true });
    const oauth = { accessToken: token, refreshToken: "r", expiresAt };
    writeFileSync(path, JSON.stringify(nested ? { claudeAiOauth: oauth } : oauth));
}

describe("getOAuthAccessToken", () => {
    test("returns OAuth access token", () => {
        expect(getOAuthAccessToken({ type: "oauth", access: "oauth-token" })).toBe("oauth-token");
    });

    test("ignores api_key credentials", () => {
        expect(getOAuthAccessToken({ type: "api_key", key: "sk-123" })).toBeNull();
    });

    test("returns null for invalid payload", () => {
        expect(getOAuthAccessToken({})).toBeNull();
        expect(getOAuthAccessToken("token")).toBeNull();
    });
});

describe("getAnthropicKeychainToken", () => {
    afterEach(() => {
        mock.restore();
    });

    test("returns the keychain access token when unexpired", async () => {
        mock.module("./keychain-auth.js", () => ({
            readBestExternalCredential: () => ({
                credentials: { claudeAiOauth: { accessToken: "kc-token", refreshToken: "r", expiresAt: Date.now() + 60_000 } },
                source: "keychain",
                sourceLabel: "Claude Code-credentials",
            }),
        }));
        const { getAnthropicKeychainToken } = await import("./usage-auth.js");
        expect(getAnthropicKeychainToken()).toBe("kc-token");
    });

    test("returns null when the keychain token is expired (never refreshes)", async () => {
        mock.module("./keychain-auth.js", () => ({
            readBestExternalCredential: () => ({
                credentials: { claudeAiOauth: { accessToken: "kc-token", refreshToken: "r", expiresAt: Date.now() - 1_000 } },
                source: "keychain",
                sourceLabel: "Claude Code-credentials",
            }),
        }));
        const { getAnthropicKeychainToken } = await import("./usage-auth.js");
        expect(getAnthropicKeychainToken()).toBeNull();
    });

    test("returns null when no external credential is found", async () => {
        mock.module("./keychain-auth.js", () => ({
            readBestExternalCredential: () => null,
        }));
        const { getAnthropicKeychainToken } = await import("./usage-auth.js");
        expect(getAnthropicKeychainToken()).toBeNull();
    });

    test("prefers minimalcc-pi imported credentials when unexpired", async () => {
        const tmpHome = mkdtempSync(join(tmpdir(), "usage-auth-test-"));
        const importedPath = join(tmpHome, "imported-credentials.json");
        writeImportedCredential(importedPath, "mcc-imported-token", Date.now() + 60_000);

        mock.module("./keychain-auth.js", () => ({
            readBestExternalCredential: () => ({
                credentials: { claudeAiOauth: { accessToken: "kc-token", refreshToken: "r", expiresAt: Date.now() + 60_000 } },
                source: "keychain",
                sourceLabel: "Claude Code-credentials",
            }),
        }));

        const { getAnthropicKeychainToken } = await import("./usage-auth.js");
        expect(getAnthropicKeychainToken({ importedCredentialPath: importedPath })).toBe("mcc-imported-token");

        rmSync(tmpHome, { recursive: true, force: true });
    });

    test("falls back to keychain when minimalcc-pi imported credential is expired", async () => {
        const tmpHome = mkdtempSync(join(tmpdir(), "usage-auth-test-"));
        const importedPath = join(tmpHome, "imported-credentials.json");
        writeImportedCredential(importedPath, "mcc-imported-token", Date.now() - 1_000);

        mock.module("./keychain-auth.js", () => ({
            readBestExternalCredential: () => ({
                credentials: { claudeAiOauth: { accessToken: "kc-token", refreshToken: "r", expiresAt: Date.now() + 60_000 } },
                source: "keychain",
                sourceLabel: "Claude Code-credentials",
            }),
        }));

        const { getAnthropicKeychainToken } = await import("./usage-auth.js");
        expect(getAnthropicKeychainToken({ importedCredentialPath: importedPath })).toBe("kc-token");

        rmSync(tmpHome, { recursive: true, force: true });
    });

    test("reads flat minimalcc-pi credential shape", async () => {
        const tmpHome = mkdtempSync(join(tmpdir(), "usage-auth-test-"));
        const importedPath = join(tmpHome, "imported-credentials.json");
        writeImportedCredential(importedPath, "flat-token", Date.now() + 60_000, false);

        mock.module("./keychain-auth.js", () => ({
            readBestExternalCredential: () => null,
        }));

        const { getAnthropicKeychainToken } = await import("./usage-auth.js");
        expect(getAnthropicKeychainToken({ importedCredentialPath: importedPath })).toBe("flat-token");

        rmSync(tmpHome, { recursive: true, force: true });
    });
});

describe("parseGeminiQuotaCredential", () => {
    test("parses stringified credential payload", () => {
        expect(parseGeminiQuotaCredential('{"token":"tok","projectId":"proj"}')).toEqual({
            token: "tok",
            projectId: "proj",
        });
    });

    test("parses object credential payload", () => {
        expect(parseGeminiQuotaCredential({ token: "tok", projectId: "proj" })).toEqual({
            token: "tok",
            projectId: "proj",
        });
    });

    test("unwraps the legacy api_key wrapper around a quota payload", () => {
        expect(
            parseGeminiQuotaCredential({ type: "api_key", key: '{"token":"tok","projectId":"proj"}' }),
        ).toEqual({ token: "tok", projectId: "proj" });
    });

    test("ignores a real api_key credential", () => {
        expect(parseGeminiQuotaCredential({ type: "api_key", key: "AIza..." })).toBeNull();
    });

    test("accepts the oauth credential a real /login writes", () => {
        expect(
            parseGeminiQuotaCredential({ type: "oauth", access: "ya29.token", refresh: "1//r", expires: 123 }),
        ).toEqual({ token: "ya29.token", projectId: null });
    });

    test("keeps a projectId alongside an oauth credential when present", () => {
        expect(
            parseGeminiQuotaCredential({ type: "oauth", access: "ya29.token", projectId: "proj" }),
        ).toEqual({ token: "ya29.token", projectId: "proj" });
    });

    test("returns null for a blank oauth access token", () => {
        expect(parseGeminiQuotaCredential({ type: "oauth", access: "   " })).toBeNull();
    });

    test("returns null for invalid values", () => {
        expect(parseGeminiQuotaCredential("AIza-api-key")).toBeNull();
        expect(parseGeminiQuotaCredential('{"token":"tok"}')).toBeNull();
        expect(parseGeminiQuotaCredential(null)).toBeNull();
    });
});
