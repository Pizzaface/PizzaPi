import { describe, test, expect } from "bun:test";
import {
    sanitizeConfigForUI,
    restoreMaskedServerEntry,
    SENSITIVE_NAME_RE,
    MASK_SENTINEL,
} from "./daemon-config-sanitize.js";

// ── SENSITIVE_NAME_RE ─────────────────────────────────────────────────────────

describe("SENSITIVE_NAME_RE", () => {
    test("matches common secret key names", () => {
        for (const name of [
            "API_KEY",
            "apikey",
            "auth_token",
            "SECRET",
            "password",
            "CREDENTIAL",
            "Authorization",
            "cookie",
            "PAT",
            "bearer_token",
        ]) {
            expect(SENSITIVE_NAME_RE.test(name)).toBe(true);
        }
    });

    test("does not match safe field names", () => {
        for (const name of ["command", "args", "url", "name", "transport", "timeout"]) {
            expect(SENSITIVE_NAME_RE.test(name)).toBe(false);
        }
    });
});

// ── sanitizeConfigForUI — apiKey / relayUrl removal ───────────────────────────

describe("sanitizeConfigForUI — top-level key removal", () => {
    test("removes apiKey and relayUrl", () => {
        const result = sanitizeConfigForUI({ apiKey: "secret", relayUrl: "https://relay.example.com" });
        expect(result).not.toHaveProperty("apiKey");
        expect(result).not.toHaveProperty("relayUrl");
    });

    test("leaves unrelated keys intact", () => {
        const result = sanitizeConfigForUI({ appendSystemPrompt: "hello", sandbox: { mode: "ask" } });
        expect(result.appendSystemPrompt).toBe("hello");
        expect((result.sandbox as any).mode).toBe("ask");
    });
});

// ── sanitizeConfigForUI — mcpServers{} (object / compatibility format) ────────

describe("sanitizeConfigForUI — mcpServers{} format", () => {
    test("masks sensitive env keys in an mcpServers entry", () => {
        const config = {
            mcpServers: {
                myServer: {
                    command: "npx",
                    args: ["mcp-server"],
                    env: { API_KEY: "super-secret", NODE_ENV: "production" },
                },
            },
        };
        const result = sanitizeConfigForUI(config);
        const env = (result.mcpServers as any).myServer.env;
        expect(env.API_KEY).toBe(MASK_SENTINEL);
        expect(env.NODE_ENV).toBe("production");
    });

    test("masks sensitive header keys in an mcpServers entry", () => {
        const config = {
            mcpServers: {
                myServer: {
                    url: "https://mcp.example.com",
                    headers: { Authorization: "Bearer tok", "Content-Type": "application/json" },
                },
            },
        };
        const result = sanitizeConfigForUI(config);
        const headers = (result.mcpServers as any).myServer.headers;
        expect(headers.Authorization).toBe(MASK_SENTINEL);
        expect(headers["Content-Type"]).toBe("application/json");
    });

    test("leaves entries without env/headers unchanged", () => {
        const config = {
            mcpServers: {
                simple: { command: "npx", args: ["x"] },
            },
        };
        const result = sanitizeConfigForUI(config);
        expect((result.mcpServers as any).simple).toEqual({ command: "npx", args: ["x"] });
    });

    test("handles non-object entries gracefully", () => {
        const config = {
            mcpServers: { broken: null },
        };
        const result = sanitizeConfigForUI(config as any);
        expect((result.mcpServers as any).broken).toBeNull();
    });
});

// ── sanitizeConfigForUI — mcp.servers[] (preferred array format) ──────────────

describe("sanitizeConfigForUI — mcp.servers[] format", () => {
    test("masks sensitive env keys in mcp.servers entries", () => {
        const config = {
            mcp: {
                servers: [
                    {
                        name: "playwright",
                        command: "npx",
                        args: ["playwright-mcp"],
                        env: { PLAYWRIGHT_API_TOKEN: "s3cr3t", DEBUG: "pw:api" },
                    },
                ],
            },
        };
        const result = sanitizeConfigForUI(config);
        const servers = (result.mcp as any).servers as any[];
        expect(servers[0].env.PLAYWRIGHT_API_TOKEN).toBe(MASK_SENTINEL);
        expect(servers[0].env.DEBUG).toBe("pw:api");
    });

    test("masks sensitive header keys in mcp.servers entries", () => {
        const config = {
            mcp: {
                servers: [
                    {
                        name: "httpServer",
                        url: "https://mcp.example.com",
                        headers: {
                            Authorization: "Bearer mytoken",
                            "X-Request-Id": "abc123",
                        },
                    },
                ],
            },
        };
        const result = sanitizeConfigForUI(config);
        const servers = (result.mcp as any).servers as any[];
        expect(servers[0].headers.Authorization).toBe(MASK_SENTINEL);
        expect(servers[0].headers["X-Request-Id"]).toBe("abc123");
    });

    test("does not mutate the original config", () => {
        const original = {
            mcp: {
                servers: [{ name: "s", command: "x", env: { API_KEY: "real" } }],
            },
        };
        sanitizeConfigForUI(original);
        expect(original.mcp.servers[0].env.API_KEY).toBe("real");
    });

    test("leaves entries without env/headers unchanged", () => {
        const config = {
            mcp: {
                servers: [{ name: "simple", command: "npx", args: ["x"] }],
            },
        };
        const result = sanitizeConfigForUI(config);
        const servers = (result.mcp as any).servers as any[];
        expect(servers[0]).toEqual({ name: "simple", command: "npx", args: ["x"] });
    });

    test("passes through non-object array entries unchanged", () => {
        const config = {
            mcp: { servers: [null, "bad-entry"] },
        };
        const result = sanitizeConfigForUI(config as any);
        const servers = (result.mcp as any).servers as any[];
        expect(servers[0]).toBeNull();
        expect(servers[1]).toBe("bad-entry");
    });

    test("handles mcp with no servers array", () => {
        const config = { mcp: { timeout: 30 } };
        const result = sanitizeConfigForUI(config as any);
        expect((result.mcp as any).timeout).toBe(30);
    });

    test("handles multiple servers, each masked independently", () => {
        const config = {
            mcp: {
                servers: [
                    { name: "a", command: "x", env: { API_KEY: "secA", KEEP: "v" } },
                    { name: "b", command: "y", env: { TOKEN: "secB", ALSO_KEEP: "w" } },
                ],
            },
        };
        const result = sanitizeConfigForUI(config);
        const [a, b] = (result.mcp as any).servers as any[];
        expect(a.env.API_KEY).toBe(MASK_SENTINEL);
        expect(a.env.KEEP).toBe("v");
        expect(b.env.TOKEN).toBe(MASK_SENTINEL);
        expect(b.env.ALSO_KEEP).toBe("w");
    });

    test("both mcp.servers[] and mcpServers{} are masked in the same config", () => {
        const config = {
            mcpServers: { objServer: { command: "a", env: { API_KEY: "s1" } } },
            mcp: {
                servers: [{ name: "arrServer", command: "b", env: { API_KEY: "s2" } }],
            },
        };
        const result = sanitizeConfigForUI(config);
        expect((result.mcpServers as any).objServer.env.API_KEY).toBe(MASK_SENTINEL);
        expect((result.mcp as any).servers[0].env.API_KEY).toBe(MASK_SENTINEL);
    });
});

// ── sanitizeConfigForUI — envOverrides ────────────────────────────────────────

describe("sanitizeConfigForUI — envOverrides", () => {
    test("masks sensitive keys in envOverrides", () => {
        const result = sanitizeConfigForUI({
            envOverrides: { ANTHROPIC_API_KEY: "sk-xxx", EDITOR: "vim" },
        });
        const ov = result.envOverrides as any;
        expect(ov.ANTHROPIC_API_KEY).toBe(MASK_SENTINEL);
        expect(ov.EDITOR).toBe("vim");
    });
});

// ── restoreMaskedServerEntry ──────────────────────────────────────────────────

describe("restoreMaskedServerEntry", () => {
    test("restores masked env value from on-disk entry", () => {
        const incoming = { name: "s", command: "x", env: { API_KEY: MASK_SENTINEL, DEBUG: "1" } };
        const existing = { name: "s", command: "x", env: { API_KEY: "real-secret", DEBUG: "0" } };
        const result = restoreMaskedServerEntry(incoming, existing);
        expect((result.env as any).API_KEY).toBe("real-secret");
        // Non-sentinel values are kept as-is from incoming
        expect((result.env as any).DEBUG).toBe("1");
    });

    test("restores masked header value from on-disk entry", () => {
        const incoming = {
            name: "s",
            url: "https://x.com",
            headers: { Authorization: MASK_SENTINEL, "Content-Type": "application/json" },
        };
        const existing = {
            name: "s",
            url: "https://x.com",
            headers: { Authorization: "Bearer token123", "Content-Type": "text/plain" },
        };
        const result = restoreMaskedServerEntry(incoming, existing);
        expect((result.headers as any).Authorization).toBe("Bearer token123");
        expect((result.headers as any)["Content-Type"]).toBe("application/json");
    });

    test("leaves sentinel as-is if existing entry has no value for that key", () => {
        const incoming = { name: "s", env: { API_KEY: MASK_SENTINEL } };
        const existing = { name: "s", env: {} }; // no API_KEY on disk
        const result = restoreMaskedServerEntry(incoming, existing);
        expect((result.env as any).API_KEY).toBe(MASK_SENTINEL);
    });

    test("returns incoming unchanged when existing is undefined (new server)", () => {
        const incoming = { name: "new", command: "x", env: { TOKEN: MASK_SENTINEL } };
        const result = restoreMaskedServerEntry(incoming, undefined);
        expect(result).toEqual(incoming);
    });

    test("does not restore when incoming value is not the sentinel", () => {
        const incoming = { name: "s", env: { API_KEY: "user-typed-new-value" } };
        const existing = { name: "s", env: { API_KEY: "old-secret" } };
        const result = restoreMaskedServerEntry(incoming, existing);
        expect((result.env as any).API_KEY).toBe("user-typed-new-value");
    });

    test("does not mutate the incoming object", () => {
        const incoming = { name: "s", env: { API_KEY: MASK_SENTINEL } };
        const existing = { name: "s", env: { API_KEY: "real" } };
        restoreMaskedServerEntry(incoming, existing);
        expect(incoming.env.API_KEY).toBe(MASK_SENTINEL);
    });

    test("handles entries with no env or headers gracefully", () => {
        const incoming = { name: "s", command: "x" };
        const existing = { name: "s", command: "x" };
        const result = restoreMaskedServerEntry(incoming, existing);
        expect(result).toEqual({ name: "s", command: "x" });
    });

    test("restores both env and headers in a single call", () => {
        const incoming = {
            name: "s",
            env: { TOKEN: MASK_SENTINEL },
            headers: { Authorization: MASK_SENTINEL },
        };
        const existing = {
            name: "s",
            env: { TOKEN: "tok123" },
            headers: { Authorization: "Bearer abc" },
        };
        const result = restoreMaskedServerEntry(incoming, existing);
        expect((result.env as any).TOKEN).toBe("tok123");
        expect((result.headers as any).Authorization).toBe("Bearer abc");
    });
});
