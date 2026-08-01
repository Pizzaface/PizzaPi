import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expandFileBackedEnv, seedAuthFileIfNeeded } from "./secrets.js";

let tmpDir: string;

beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "pizzapi-secrets-test-"));
});

afterEach(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

describe("expandFileBackedEnv", () => {
    test("populates a credential-shaped var from its _FILE path", () => {
        const path = join(tmpDir, "key");
        writeFileSync(path, "  secret-value  \n");
        const env: NodeJS.ProcessEnv = { ANTHROPIC_API_KEY_FILE: path };
        expandFileBackedEnv(env);
        expect(env.ANTHROPIC_API_KEY).toBe("secret-value");
    });

    test("handles GH_TOKEN_FILE (ends in _TOKEN)", () => {
        const path = join(tmpDir, "token");
        writeFileSync(path, "ghp_abc123\n");
        const env: NodeJS.ProcessEnv = { GH_TOKEN_FILE: path };
        expandFileBackedEnv(env);
        expect(env.GH_TOKEN).toBe("ghp_abc123");
    });

    test("handles the explicit PizzaPi names", () => {
        const path = join(tmpDir, "pizzapikey");
        writeFileSync(path, "pk-123");
        const env: NodeJS.ProcessEnv = { PIZZAPI_API_KEY_FILE: path };
        expandFileBackedEnv(env);
        expect(env.PIZZAPI_API_KEY).toBe("pk-123");
    });

    test("leaves a non-credential *_FILE var alone", () => {
        const path = join(tmpDir, "auth.db");
        writeFileSync(path, "binary-ish-content");
        const env: NodeJS.ProcessEnv = { NTFY_AUTH_FILE: path };
        expandFileBackedEnv(env);
        expect(env.NTFY_AUTH).toBeUndefined();
    });

    test("an already-set var wins over its _FILE counterpart", () => {
        const path = join(tmpDir, "key");
        writeFileSync(path, "from-file");
        const env: NodeJS.ProcessEnv = { ANTHROPIC_API_KEY: "from-env", ANTHROPIC_API_KEY_FILE: path };
        expandFileBackedEnv(env);
        expect(env.ANTHROPIC_API_KEY).toBe("from-env");
    });

    test("an empty string counts as unset and still gets expanded", () => {
        const path = join(tmpDir, "key");
        writeFileSync(path, "from-file");
        const env: NodeJS.ProcessEnv = { ANTHROPIC_API_KEY: "", ANTHROPIC_API_KEY_FILE: path };
        expandFileBackedEnv(env);
        expect(env.ANTHROPIC_API_KEY).toBe("from-file");
    });

    test("unreadable file is skipped without throwing", () => {
        const env: NodeJS.ProcessEnv = { OPENAI_API_KEY_FILE: join(tmpDir, "does-not-exist") };
        expect(() => expandFileBackedEnv(env)).not.toThrow();
        expect(env.OPENAI_API_KEY).toBeUndefined();
    });
});

describe("seedAuthFileIfNeeded", () => {
    test("seeds auth.json when missing", () => {
        const src = join(tmpDir, "src-auth.json");
        writeFileSync(src, JSON.stringify({ anthropic: { key: "x" } }));
        const agentDir = join(tmpDir, "agent");
        mkdirSync(agentDir, { recursive: true });

        seedAuthFileIfNeeded(agentDir, { PIZZAPI_AUTH_FILE: src });

        const dest = join(agentDir, "auth.json");
        expect(readFileSync(dest, "utf-8")).toBe(readFileSync(src, "utf-8"));
    });

    test("keeps an existing auth.json (never clobbers)", () => {
        const src = join(tmpDir, "src-auth.json");
        writeFileSync(src, JSON.stringify({ anthropic: { key: "new" } }));
        const agentDir = join(tmpDir, "agent");
        mkdirSync(agentDir, { recursive: true });
        const dest = join(agentDir, "auth.json");
        writeFileSync(dest, JSON.stringify({ anthropic: { key: "existing-refreshed" } }));

        seedAuthFileIfNeeded(agentDir, { PIZZAPI_AUTH_FILE: src });

        expect(readFileSync(dest, "utf-8")).toContain("existing-refreshed");
    });

    test("no-op when PIZZAPI_AUTH_FILE is unset", () => {
        const agentDir = join(tmpDir, "agent");
        mkdirSync(agentDir, { recursive: true });
        seedAuthFileIfNeeded(agentDir, {});
        expect(() => readFileSync(join(agentDir, "auth.json"), "utf-8")).toThrow();
    });
});
