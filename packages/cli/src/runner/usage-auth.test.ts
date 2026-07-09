import { afterEach, describe, expect, mock, test } from "bun:test";
import { getOAuthAccessToken, parseGeminiQuotaCredential } from "./usage-auth.js";

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

    test("ignores api_key credentials", () => {
        expect(parseGeminiQuotaCredential({ type: "api_key", key: "AIza..." })).toBeNull();
    });

    test("returns null for invalid values", () => {
        expect(parseGeminiQuotaCredential("AIza-api-key")).toBeNull();
        expect(parseGeminiQuotaCredential('{"token":"tok"}')).toBeNull();
    });
});
