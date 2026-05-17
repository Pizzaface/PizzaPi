import { describe, expect, test } from "bun:test";
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
