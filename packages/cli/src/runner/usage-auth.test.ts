import { describe, expect, test } from "bun:test";
import { getOAuthAccessToken, getRefreshedOAuthToken, parseGeminiQuotaCredential } from "./usage-auth.js";

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

describe("getRefreshedOAuthToken", () => {
    function mockAuthStorage(credential: unknown, apiKeyResult?: string) {
        return {
            get: () => credential,
            getApiKey: async () => apiKeyResult,
        } as any;
    }

    test("returns refreshed token for OAuth credentials", async () => {
        const storage = mockAuthStorage(
            { type: "oauth", access: "old-token", expires: 0 },
            "refreshed-token",
        );
        expect(await getRefreshedOAuthToken(storage, "anthropic")).toBe("refreshed-token");
    });

    test("returns null for API-key credentials", async () => {
        const storage = mockAuthStorage({ type: "api_key", key: "sk-123" });
        expect(await getRefreshedOAuthToken(storage, "anthropic")).toBeNull();
    });

    test("returns null when no credential exists", async () => {
        const storage = mockAuthStorage(undefined);
        expect(await getRefreshedOAuthToken(storage, "anthropic")).toBeNull();
    });

    test("returns null when getApiKey returns undefined", async () => {
        const storage = mockAuthStorage(
            { type: "oauth", access: "tok", expires: 0 },
            undefined,
        );
        expect(await getRefreshedOAuthToken(storage, "anthropic")).toBeNull();
    });

    test("falls back to raw access for unknown credential type", async () => {
        const storage = mockAuthStorage({ type: "custom", access: "custom-tok" });
        expect(await getRefreshedOAuthToken(storage, "anthropic")).toBe("custom-tok");
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
