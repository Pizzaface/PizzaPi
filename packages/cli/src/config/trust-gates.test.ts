/**
 * Characterization tests for the four PizzaPi trust gates.
 *
 * These tests pin CURRENT behavior — they do not assert what "should"
 * happen. See docs/adr/trust-unification.md for the gap analysis and
 * migration plan. If a gate's real behavior looks surprising, the comment
 * on that test explains why; the fix (if any) is a separate change.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
    loadConfig,
    isProjectHooksTrusted,
    isProjectMcpTrusted,
    getTrustedPlugins,
    isPluginTrusted,
    trustPlugin,
    untrustPlugin,
    _setGlobalConfigDir,
} from "./io.js";
import { discoverProviders, globalProvidersDir } from "../providers/loader.js";

let tmpHome: string;
let projectDir: string;
const ENV_KEYS = ["PIZZAPI_ALLOW_PROJECT_HOOKS", "PIZZAPI_ALLOW_PROJECT_MCP"] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "pizzapi-trust-gates-"));
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

function writeProjectConfig(config: Record<string, unknown>): void {
    const dir = join(projectDir, ".pizzapi");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "config.json"), JSON.stringify(config));
}

// ── 1. allowProjectHooks — ENFORCED ─────────────────────────────────────────

describe("allowProjectHooks (enforced gate)", () => {
    test("isProjectHooksTrusted defaults to false with no config", () => {
        expect(isProjectHooksTrusted({})).toBe(false);
    });

    test("isProjectHooksTrusted true when global config sets allowProjectHooks: true", () => {
        expect(isProjectHooksTrusted({ allowProjectHooks: true })).toBe(true);
    });

    test("isProjectHooksTrusted false when global config explicitly sets allowProjectHooks: false", () => {
        expect(isProjectHooksTrusted({ allowProjectHooks: false })).toBe(false);
    });

    test("isProjectHooksTrusted true via PIZZAPI_ALLOW_PROJECT_HOOKS=1 env var, even if global config is false", () => {
        process.env.PIZZAPI_ALLOW_PROJECT_HOOKS = "1";
        expect(isProjectHooksTrusted({ allowProjectHooks: false })).toBe(true);
    });

    test("loadConfig DROPS project hooks by default (untrusted) — global hooks still run", () => {
        writeGlobalConfig({
            hooks: { SessionStart: [{ command: "echo global" }] },
        });
        writeProjectConfig({
            hooks: { SessionStart: [{ command: "echo project" }] },
        });

        const config = loadConfig(projectDir);
        expect(config.hooks?.SessionStart).toHaveLength(1);
        expect(config.hooks?.SessionStart?.[0]).toEqual({ command: "echo global" });
    });

    test("loadConfig MERGES project hooks with global hooks when allowProjectHooks: true", () => {
        writeGlobalConfig({
            allowProjectHooks: true,
            hooks: { SessionStart: [{ command: "echo global" }] },
        });
        writeProjectConfig({
            hooks: { SessionStart: [{ command: "echo project" }] },
        });

        const config = loadConfig(projectDir);
        expect(config.hooks?.SessionStart).toHaveLength(2);
    });

    test("loadConfig merges project hooks when trusted via env var instead of global config", () => {
        process.env.PIZZAPI_ALLOW_PROJECT_HOOKS = "1";
        writeGlobalConfig({});
        writeProjectConfig({
            hooks: { SessionStart: [{ command: "echo project" }] },
        });

        const config = loadConfig(projectDir);
        expect(config.hooks?.SessionStart).toHaveLength(1);
    });
});

// ── 2. allowProjectMcp — WARN-ONLY (not enforced) ───────────────────────────

describe("allowProjectMcp (warn-only gate — CRITICAL: servers load regardless)", () => {
    test("isProjectMcpTrusted defaults to false with no config", () => {
        expect(isProjectMcpTrusted({})).toBe(false);
    });

    test("isProjectMcpTrusted true when global config sets allowProjectMcp: true", () => {
        expect(isProjectMcpTrusted({ allowProjectMcp: true })).toBe(true);
    });

    test("isProjectMcpTrusted true via PIZZAPI_ALLOW_PROJECT_MCP=1 env var", () => {
        process.env.PIZZAPI_ALLOW_PROJECT_MCP = "1";
        expect(isProjectMcpTrusted({ allowProjectMcp: false })).toBe(true);
    });

    // CRITICAL: this is the "warn-and-load" behavior (see io.ts loadConfig,
    // ~"P0 fix: warn-and-load by default"). The flag only silences the
    // warning — it does NOT gate whether the servers are merged into config.
    // A future unification must preserve this unless a deliberate behavior
    // change is made and documented.
    test("mcpServers format: project servers ARE MERGED even when untrusted (flag absent)", () => {
        writeGlobalConfig({
            mcpServers: { globalServer: { command: "global-cmd" } },
        });
        writeProjectConfig({
            mcpServers: { projectServer: { command: "project-cmd" } },
        });

        const config = loadConfig(projectDir);
        expect((config as any).mcpServers).toEqual({
            globalServer: { command: "global-cmd" },
            projectServer: { command: "project-cmd" },
        });
    });

    test("mcpServers format: project servers ARE MERGED even when allowProjectMcp: false explicitly", () => {
        writeGlobalConfig({
            allowProjectMcp: false,
            mcpServers: { globalServer: { command: "global-cmd" } },
        });
        writeProjectConfig({
            mcpServers: { projectServer: { command: "project-cmd" } },
        });

        const config = loadConfig(projectDir);
        expect((config as any).mcpServers).toHaveProperty("projectServer");
    });

    test("mcp.servers (array) format: project servers ARE MERGED even when untrusted", () => {
        writeGlobalConfig({
            mcp: { servers: [{ name: "global-srv", command: "g" }] },
        });
        writeProjectConfig({
            mcp: { servers: [{ name: "project-srv", command: "p" }] },
        });

        const config = loadConfig(projectDir);
        const names = ((config as any).mcp.servers as Array<{ name: string }>).map((s) => s.name);
        expect(names.sort()).toEqual(["global-srv", "project-srv"]);
    });

    test("mcp.servers (array) format: project entry with same name overwrites global entry, still merged when untrusted", () => {
        writeGlobalConfig({
            mcp: { servers: [{ name: "shared", command: "global-version" }] },
        });
        writeProjectConfig({
            mcp: { servers: [{ name: "shared", command: "project-version" }] },
        });

        const config = loadConfig(projectDir);
        const servers = (config as any).mcp.servers as Array<{ name: string; command: string }>;
        expect(servers).toHaveLength(1);
        expect(servers[0].command).toBe("project-version");
    });

    test("warns once (console.warn) when project mcpServers present and flag not set, but STILL loads them", () => {
        const warnCalls: unknown[][] = [];
        const orig = console.warn;
        console.warn = (...args: unknown[]) => { warnCalls.push(args); };
        try {
            writeGlobalConfig({});
            writeProjectConfig({
                mcpServers: { projectServer: { command: "project-cmd" } },
            });
            const config = loadConfig(projectDir);
            expect((config as any).mcpServers).toHaveProperty("projectServer");
            const joined = warnCalls.map((a) => a.join(" ")).join("\n");
            expect(joined).toContain("Project MCP servers found");
        } finally {
            console.warn = orig;
        }
    });

    test("no warning when allowProjectMcp: true (still loads, silences the warning)", () => {
        const warnCalls: unknown[][] = [];
        const orig = console.warn;
        console.warn = (...args: unknown[]) => { warnCalls.push(args); };
        try {
            writeGlobalConfig({ allowProjectMcp: true });
            writeProjectConfig({
                mcpServers: { projectServer: { command: "project-cmd" } },
            });
            const config = loadConfig(projectDir);
            expect((config as any).mcpServers).toHaveProperty("projectServer");
            const joined = warnCalls.map((a) => a.join(" ")).join("\n");
            expect(joined).not.toContain("Project MCP servers found");
        } finally {
            console.warn = orig;
        }
    });

    test("empty project mcpServers object does not trigger a warning (skips placeholder objects)", () => {
        const warnCalls: unknown[][] = [];
        const orig = console.warn;
        console.warn = (...args: unknown[]) => { warnCalls.push(args); };
        try {
            writeGlobalConfig({});
            writeProjectConfig({ mcpServers: {} });
            loadConfig(projectDir);
            const joined = warnCalls.map((a) => a.join(" ")).join("\n");
            expect(joined).not.toContain("Project MCP servers found");
        } finally {
            console.warn = orig;
        }
    });
});

// ── 3. allowProjectProviders — ENFORCED ─────────────────────────────────────

describe("allowProjectProviders (enforced gate, via discoverProviders({allowProject}))", () => {
    let origHome: string | undefined;

    beforeEach(() => {
        origHome = process.env.HOME;
        process.env.HOME = tmpHome;
    });

    afterEach(() => {
        process.env.HOME = origHome;
    });

    function writeProvider(dir: string, id: string): void {
        mkdirSync(dir, { recursive: true });
        writeFileSync(
            join(dir, "index.ts"),
            `export default {
                id: ${JSON.stringify(id)},
                capabilities: ["lifecycle"],
                init() {},
                dispose() {},
                onSessionStart: async () => {},
            };`,
        );
    }

    test("allowProject: false (default) returns ONLY global providers, project provider excluded", async () => {
        writeProvider(join(globalProvidersDir(), "global-prov"), "global-prov");
        writeProvider(join(projectDir, ".pizzapi", "providers", "project-prov"), "project-prov");

        const result = await discoverProviders({ cwd: projectDir, allowProject: false });
        expect(result.providers.map((p) => p.provider.id)).toEqual(["global-prov"]);
    });

    test("allowProject omitted (undefined) also excludes project providers — default is false", async () => {
        writeProvider(join(globalProvidersDir(), "global-prov"), "global-prov");
        writeProvider(join(projectDir, ".pizzapi", "providers", "project-prov"), "project-prov");

        const result = await discoverProviders({ cwd: projectDir });
        expect(result.providers.map((p) => p.provider.id)).toEqual(["global-prov"]);
    });

    test("allowProject: true includes both global and project providers", async () => {
        writeProvider(join(globalProvidersDir(), "global-prov"), "global-prov");
        writeProvider(join(projectDir, ".pizzapi", "providers", "project-prov"), "project-prov");

        const result = await discoverProviders({ cwd: projectDir, allowProject: true });
        expect(result.providers.map((p) => p.provider.id).sort()).toEqual(["global-prov", "project-prov"]);
    });
});

// ── 4. trustedPlugins — path-based allowlist ────────────────────────────────

describe("trustedPlugins (path-based allowlist)", () => {
    test("getTrustedPlugins returns empty array with no config", () => {
        expect(getTrustedPlugins()).toEqual([]);
    });

    test("isPluginTrusted false for an untrusted path", () => {
        expect(isPluginTrusted(join(tmpHome, "some-plugin"))).toBe(false);
    });

    test("trustPlugin adds a path, isPluginTrusted then returns true", () => {
        const pluginPath = join(tmpHome, "my-plugin");
        mkdirSync(pluginPath, { recursive: true });

        const added = trustPlugin(pluginPath);
        expect(added).toBe(true);
        expect(isPluginTrusted(pluginPath)).toBe(true);
        expect(getTrustedPlugins()).toContain(pluginPath.replace(/[\\/]+$/, ""));
    });

    test("trustPlugin is idempotent — trusting an already-trusted path returns false", () => {
        const pluginPath = join(tmpHome, "my-plugin");
        mkdirSync(pluginPath, { recursive: true });
        trustPlugin(pluginPath);
        expect(trustPlugin(pluginPath)).toBe(false);
        expect(getTrustedPlugins()).toHaveLength(1);
    });

    test("untrustPlugin removes a trusted path, isPluginTrusted then returns false", () => {
        const pluginPath = join(tmpHome, "my-plugin");
        mkdirSync(pluginPath, { recursive: true });
        trustPlugin(pluginPath);

        const removed = untrustPlugin(pluginPath);
        expect(removed).toBe(true);
        expect(isPluginTrusted(pluginPath)).toBe(false);
    });

    test("untrustPlugin returns false when the path was never trusted", () => {
        expect(untrustPlugin(join(tmpHome, "never-trusted"))).toBe(false);
    });

    test("isPluginTrusted matches paths with a trailing slash the same as without", () => {
        const pluginPath = join(tmpHome, "trailing-slash-plugin");
        mkdirSync(pluginPath, { recursive: true });
        trustPlugin(pluginPath);
        expect(isPluginTrusted(pluginPath + "/")).toBe(true);
    });

    test("isPluginTrusted resolves relative paths against process.cwd() before comparing", () => {
        // trustPlugin canonicalizes with resolve(), so a relative path passed to
        // isPluginTrusted must resolve to the same absolute path to match.
        const pluginPath = join(tmpHome, "relative-check");
        mkdirSync(pluginPath, { recursive: true });
        trustPlugin(pluginPath);

        const relative = pluginPath.startsWith(process.cwd())
            ? pluginPath.slice(process.cwd().length + 1)
            : pluginPath; // fall back if tmpdir isn't under cwd (still absolute, still matches)
        expect(isPluginTrusted(relative)).toBe(true);
    });
});
