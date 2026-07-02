import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
    loadConfig,
    applyProviderOverrides,
    resolveSessionProvider,
    _setGlobalConfigDir,
} from "./io.js";
import type { PizzaPiConfig } from "./types.js";

let tmpHome: string;
let projectDir: string;
const ENV_KEYS = ["PIZZAPI_SESSION_PROVIDER", "PIZZAPI_WORKER_INITIAL_MODEL_PROVIDER"] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "pizzapi-provider-overrides-"));
    projectDir = join(tmpHome, "project");
    mkdirSync(projectDir, { recursive: true });
    _setGlobalConfigDir(tmpHome);
    for (const k of ENV_KEYS) {
        savedEnv[k] = process.env[k];
        delete process.env[k];
    }
});

afterEach(() => {
    _setGlobalConfigDir(null);
    rmSync(tmpHome, { recursive: true, force: true });
    for (const k of ENV_KEYS) {
        if (savedEnv[k] === undefined) delete process.env[k];
        else process.env[k] = savedEnv[k];
    }
});

function writeGlobalConfig(config: Record<string, unknown>): void {
    writeFileSync(join(tmpHome, "config.json"), JSON.stringify(config));
}

function writeSettings(settings: Record<string, unknown>): void {
    writeFileSync(join(tmpHome, "settings.json"), JSON.stringify(settings));
}

// ── resolveSessionProvider ────────────────────────────────────────────────────

describe("resolveSessionProvider", () => {
    test("returns undefined when nothing is configured", () => {
        expect(resolveSessionProvider()).toBeUndefined();
    });

    test("reads defaultProvider from settings.json", () => {
        writeSettings({ defaultProvider: "claude-subscription" });
        expect(resolveSessionProvider()).toBe("claude-subscription");
    });

    test("PIZZAPI_WORKER_INITIAL_MODEL_PROVIDER beats settings.json", () => {
        writeSettings({ defaultProvider: "anthropic" });
        process.env.PIZZAPI_WORKER_INITIAL_MODEL_PROVIDER = "openai";
        expect(resolveSessionProvider()).toBe("openai");
    });

    test("PIZZAPI_SESSION_PROVIDER snapshot beats everything", () => {
        writeSettings({ defaultProvider: "anthropic" });
        process.env.PIZZAPI_WORKER_INITIAL_MODEL_PROVIDER = "openai";
        process.env.PIZZAPI_SESSION_PROVIDER = "google";
        expect(resolveSessionProvider()).toBe("google");
    });

    test("ignores malformed settings.json", () => {
        writeFileSync(join(tmpHome, "settings.json"), "{not json");
        expect(resolveSessionProvider()).toBeUndefined();
    });
});

// ── applyProviderOverrides ────────────────────────────────────────────────────

describe("applyProviderOverrides", () => {
    const base: PizzaPiConfig = {
        appendSystemPrompt: "global append",
        builtinSystemPrompt: true,
        sendAgentsMd: true,
        disabledMcpServers: ["already-off"],
        providerSettings: {
            anthropic: {
                overrides: {
                    builtinSystemPrompt: false,
                    sendAgentsMd: false,
                    appendSystemPrompt: "vanilla",
                    disabledMcpServers: ["godmother", "already-off"],
                },
            },
        },
    };

    test("no-op when provider is undefined", () => {
        expect(applyProviderOverrides(base, undefined)).toBe(base);
    });

    test("no-op when provider has no overrides", () => {
        expect(applyProviderOverrides(base, "openai")).toBe(base);
    });

    test("applies system prompt and AGENTS.md fields for matching provider", () => {
        const merged = applyProviderOverrides(base, "anthropic");
        expect(merged.builtinSystemPrompt).toBe(false);
        expect(merged.sendAgentsMd).toBe(false);
        expect(merged.appendSystemPrompt).toBe("vanilla");
    });

    test("unions disabledMcpServers with existing list", () => {
        const merged = applyProviderOverrides(base, "anthropic");
        expect(merged.disabledMcpServers!.sort()).toEqual(["already-off", "godmother"]);
    });

    test("supports full systemPrompt replacement", () => {
        const config: PizzaPiConfig = {
            providerSettings: { openai: { overrides: { systemPrompt: "You are a plain agent." } } },
        };
        expect(applyProviderOverrides(config, "openai").systemPrompt).toBe("You are a plain agent.");
    });

    test("ignores wrongly-typed override fields", () => {
        const config = {
            sendAgentsMd: true,
            providerSettings: {
                anthropic: { overrides: { sendAgentsMd: "nope", disabledMcpServers: [1, "ok"] } },
            },
        } as unknown as PizzaPiConfig;
        const merged = applyProviderOverrides(config, "anthropic");
        expect(merged.sendAgentsMd).toBe(true);
        expect(merged.disabledMcpServers).toEqual(["ok"]);
    });

    test("does not mutate the input config", () => {
        applyProviderOverrides(base, "anthropic");
        expect(base.builtinSystemPrompt).toBe(true);
        expect(base.disabledMcpServers).toEqual(["already-off"]);
    });
});

// ── loadConfig integration ────────────────────────────────────────────────────

describe("loadConfig provider overrides integration", () => {
    test("applies overrides from settings.json defaultProvider", () => {
        writeGlobalConfig({
            sendAgentsMd: true,
            providerSettings: {
                "claude-subscription": {
                    overrides: { builtinSystemPrompt: false, sendAgentsMd: false },
                },
            },
        });
        writeSettings({ defaultProvider: "claude-subscription" });

        const config = loadConfig(projectDir);
        expect(config.builtinSystemPrompt).toBe(false);
        expect(config.sendAgentsMd).toBe(false);
    });

    test("no overrides applied for a different provider", () => {
        writeGlobalConfig({
            providerSettings: {
                anthropic: { overrides: { sendAgentsMd: false } },
            },
        });
        writeSettings({ defaultProvider: "openai" });

        const config = loadConfig(projectDir);
        expect(config.sendAgentsMd).toBeUndefined();
    });

    test("spawn-time provider env selects the override set", () => {
        writeGlobalConfig({
            providerSettings: {
                anthropic: { overrides: { disabledMcpServers: ["playwright"] } },
            },
        });
        writeSettings({ defaultProvider: "openai" });
        process.env.PIZZAPI_WORKER_INITIAL_MODEL_PROVIDER = "anthropic";

        const config = loadConfig(projectDir);
        expect(config.disabledMcpServers).toEqual(["playwright"]);
    });
});
