import { describe, test, expect } from "bun:test";
import { BASH_PASSTHROUGH_ENV, isStrippedSubprocessEnvName, scrubSubprocessEnv } from "./subprocess-env.js";

describe("scrubSubprocessEnv (F19)", () => {
    const env: NodeJS.ProcessEnv = {
        PATH: "/usr/bin",
        HOME: "/home/u",
        PIZZAPI_API_KEY: "relay-key",
        PIZZAPI_API_TOKEN: "relay-token",
        PIZZAPI_RUNNER_API_KEY: "runner-key",
        PIZZAPI_RUNNER_TOKEN: "runner-token",
        BETTER_AUTH_SECRET: "auth",
        VAPID_PRIVATE_KEY: "vapid",
        PIZZAPI_TUNNEL_TOKEN_SECRET: "tunnel",
        PIZZAPI_NEW_THING_PASSWORD: "pw",
        // Kept: user-owned credentials and non-secret PizzaPi variables.
        ANTHROPIC_API_KEY: "provider",
        OPENAI_API_KEY: "provider2",
        GITHUB_TOKEN: "gh",
        PIZZAPI_SESSION_PROC_FILE: "/tmp/procs",
        PIZZAPI_RELAY_URL: "https://relay.example",
        PIZZAPI_API_KEY_RATE_LIMIT_ENABLED: "true",
        PIZZAPI_API_KEY_FILE: "/run/secrets/key",
    };

    test("removes PizzaPi credentials and relay-server secrets", () => {
        const out = scrubSubprocessEnv(env, {});
        for (const k of [
            "PIZZAPI_API_KEY", "PIZZAPI_API_TOKEN", "PIZZAPI_RUNNER_API_KEY", "PIZZAPI_RUNNER_TOKEN",
            "BETTER_AUTH_SECRET", "VAPID_PRIVATE_KEY", "PIZZAPI_TUNNEL_TOKEN_SECRET", "PIZZAPI_NEW_THING_PASSWORD",
        ]) {
            expect(out[k]).toBeUndefined();
        }
    });

    test("keeps user-owned credentials and non-secret PizzaPi variables", () => {
        const out = scrubSubprocessEnv(env, {});
        expect(out.PATH).toBe("/usr/bin");
        expect(out.ANTHROPIC_API_KEY).toBe("provider");
        expect(out.OPENAI_API_KEY).toBe("provider2");
        expect(out.GITHUB_TOKEN).toBe("gh");
        expect(out.PIZZAPI_SESSION_PROC_FILE).toBe("/tmp/procs");
        expect(out.PIZZAPI_RELAY_URL).toBe("https://relay.example");
        expect(out.PIZZAPI_API_KEY_RATE_LIMIT_ENABLED).toBe("true");
        expect(out.PIZZAPI_API_KEY_FILE).toBe("/run/secrets/key");
    });

    test("does not mutate the input", () => {
        const copy = { ...env };
        scrubSubprocessEnv(env, {});
        expect(env).toEqual(copy);
    });

    test("is case-insensitive (Windows env names)", () => {
        expect(isStrippedSubprocessEnvName("pizzapi_api_key")).toBe(true);
        expect(scrubSubprocessEnv({ Pizzapi_Api_Key: "x" }, {}).Pizzapi_Api_Key).toBeUndefined();
    });

    test("operator passthrough allowlist keeps named variables", () => {
        const out = scrubSubprocessEnv(env, { [BASH_PASSTHROUGH_ENV]: " PIZZAPI_API_KEY , better_auth_secret" });
        expect(out.PIZZAPI_API_KEY).toBe("relay-key");
        expect(out.BETTER_AUTH_SECRET).toBe("auth");
        expect(out.PIZZAPI_RUNNER_TOKEN).toBeUndefined();
    });
});
