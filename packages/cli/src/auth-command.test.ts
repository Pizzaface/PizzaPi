import { describe, expect, test } from "bun:test";
import { loginTypes, pickOption } from "./auth-command.js";

describe("pizza auth", () => {
    test("loginTypes lists only interactive logins", () => {
        expect(loginTypes({ auth: { oauth: {}, apiKey: { login: () => {} } } })).toEqual(["oauth", "api_key"]);
        expect(loginTypes({ auth: { oauth: {} } })).toEqual(["oauth"]);
        // Ambient-only api key (env var / AWS profile) has no login step.
        expect(loginTypes({ auth: { apiKey: {} } })).toEqual([]);
        expect(loginTypes(undefined)).toEqual([]);
    });

    test("pickOption defaults to the first option and is 1-based", () => {
        const options = [{ id: "oauth" }, { id: "api_key" }];
        expect(pickOption(options, "").id).toBe("oauth");
        expect(pickOption(options, "2").id).toBe("api_key");
        expect(() => pickOption(options, "3")).toThrow();
    });
});
