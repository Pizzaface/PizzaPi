import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { deepRedactConfig, maskApiKey, maskUrlUserinfo, runConfigShowCommand } from "./config-show.js";
import { _setGlobalConfigDir } from "./config.js";

describe("maskUrlUserinfo", () => {
    test("strips embedded user:pass credentials", () => {
        expect(maskUrlUserinfo("ws://user:pass@relay.example.com:7492")).toBe("ws://relay.example.com:7492/");
    });
    test("leaves credential-free URLs unchanged", () => {
        expect(maskUrlUserinfo("ws://localhost:7492")).toBe("ws://localhost:7492");
    });
    test("passes through non-URL and undefined values", () => {
        expect(maskUrlUserinfo("off")).toBe("off");
        expect(maskUrlUserinfo(undefined)).toBeUndefined();
    });
});

describe("maskApiKey", () => {
    test("unset when no key", () => {
        expect(maskApiKey(undefined)).toBe("unset");
    });

    test("set for short keys (avoids leaking short secrets)", () => {
        expect(maskApiKey("abcd1234")).toBe("set");
    });

    test("shows first4…last4 for normal-length keys, never the full value", () => {
        const key = "pk_live_abcdefghijklmnopqrstuvwxyz";
        const masked = maskApiKey(key);
        expect(masked).toBe("pk_l…wxyz");
        expect(masked).not.toContain(key.slice(8, -4));
    });

    test("does not throw on malformed non-string input", () => {
        expect(maskApiKey(true)).toBe("set");
        expect(maskApiKey({})).toBe("set");
        expect(maskApiKey(12345678901234)).toBe("set");
        expect(maskApiKey(null)).toBe("unset");
    });
});

describe("deepRedactConfig", () => {
    test("redacts nested secrets, env/header maps, and URL userinfo — not the harmless fields", () => {
        const redacted = deepRedactConfig({
            apiKey: "sk_live_abcdefghijklmnop",
            relayUrl: "ws://user:pass@relay.example.com:7492",
            oauthClientId: "public-client-id",
            oauthClientSecret: "super-secret-value",
            envOverrides: { OPENAI_API_KEY: "sk-leak-me", FOO: "bar" },
            mcpServers: {
                gh: { url: "https://tok:zzz@mcp.example.com", headers: { Authorization: "Bearer leak" }, command: "bunx" },
            },
        }) as Record<string, any>;

        expect(redacted.apiKey).toBe("sk_l…mnop");
        expect(redacted.relayUrl).toBe("ws://relay.example.com:7492/");
        expect(redacted.oauthClientId).toBe("public-client-id");
        expect(redacted.oauthClientSecret).toBe("«redacted»");
        expect(redacted.envOverrides.OPENAI_API_KEY).toBe("«redacted»");
        expect(redacted.envOverrides.FOO).toBe("«redacted»");
        expect(redacted.mcpServers.gh.headers.Authorization).toBe("«redacted»");
        expect(redacted.mcpServers.gh.url).toBe("https://mcp.example.com/");
        expect(redacted.mcpServers.gh.command).toBe("bunx");

        // the full serialized output leaks nothing sensitive
        const dump = JSON.stringify(redacted);
        for (const secret of ["super-secret-value", "sk-leak-me", "Bearer leak", "tok:zzz", "user:pass"]) {
            expect(dump).not.toContain(secret);
        }
    });
});

describe("runConfigShowCommand", () => {
    let tmpDir: string;
    let projectDir: string;
    let globalDir: string;
    let originalApiKeyEnv: string | undefined;
    let originalRelayEnv: string | undefined;
    let originalLog: typeof console.log;
    let output: string[];

    beforeEach(() => {
        tmpDir = mkdtempSync(join(tmpdir(), "pizzapi-config-show-"));
        globalDir = join(tmpDir, "global", ".pizzapi");
        projectDir = join(tmpDir, "project");
        mkdirSync(globalDir, { recursive: true });
        mkdirSync(projectDir, { recursive: true });
        _setGlobalConfigDir(globalDir);
        originalApiKeyEnv = process.env.PIZZAPI_API_KEY;
        originalRelayEnv = process.env.PIZZAPI_RELAY_URL;
        delete process.env.PIZZAPI_API_KEY;
        delete process.env.PIZZAPI_RELAY_URL;
        output = [];
        originalLog = console.log;
        console.log = ((...args: unknown[]) => { output.push(args.join(" ")); }) as typeof console.log;
    });

    afterEach(() => {
        console.log = originalLog;
        _setGlobalConfigDir(null);
        if (originalApiKeyEnv === undefined) delete process.env.PIZZAPI_API_KEY;
        else process.env.PIZZAPI_API_KEY = originalApiKeyEnv;
        if (originalRelayEnv === undefined) delete process.env.PIZZAPI_RELAY_URL;
        else process.env.PIZZAPI_RELAY_URL = originalRelayEnv;
        try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    });

    test("returns 0 and never prints the full apiKey", () => {
        writeFileSync(
            join(globalDir, "config.json"),
            JSON.stringify({ apiKey: "sk_super_secret_do_not_leak_1234", relayUrl: "ws://relay.example.com" }),
        );

        const code = runConfigShowCommand(projectDir);
        expect(code).toBe(0);

        const text = output.join("\n");
        expect(text).not.toContain("sk_super_secret_do_not_leak_1234");
        expect(text).toContain("ws://relay.example.com");
        expect(text).toContain("sk_s…1234");
    });

    test("shows 'unset' apiKey and default relay URL when nothing is configured", () => {
        writeFileSync(join(globalDir, "config.json"), JSON.stringify({}));

        const code = runConfigShowCommand(projectDir);
        expect(code).toBe(0);

        const text = output.join("\n");
        expect(text).toContain("unset");
        expect(text).toContain("ws://localhost:7492");
    });

    test("reflects PIZZAPI_API_KEY / PIZZAPI_RELAY_URL env overrides in the effective values", () => {
        writeFileSync(
            join(globalDir, "config.json"),
            JSON.stringify({ apiKey: "file-key-aaaaaaaa", relayUrl: "ws://file-relay.example.com" }),
        );
        process.env.PIZZAPI_API_KEY = "env-key-bbbbbbbbbbbb";
        process.env.PIZZAPI_RELAY_URL = "ws://env-relay.example.com";

        const code = runConfigShowCommand(projectDir);
        expect(code).toBe(0);

        // The top "effective" summary reflects the env override (what the CLI
        // actually connects with); the raw config.json dump below still shows
        // the on-disk value, which is expected — it's a separate section.
        const summaryLine = output.find((line) => line.includes("relayUrl "));
        expect(summaryLine).toContain("ws://env-relay.example.com");
        expect(summaryLine).toContain("from PIZZAPI_RELAY_URL");
        const text = output.join("\n");
        expect(text).not.toContain("env-key-bbbbbbbbbbbb");
    });
});
