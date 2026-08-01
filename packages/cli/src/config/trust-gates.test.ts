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
import { join, relative, resolve } from "path";
import { EventEmitter } from "node:events";

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
import { createClaudePluginExtension, getPluginSkillPaths, getPluginAgentPaths, getPluginPromptTemplatePaths } from "../extensions/claude-plugins.js";

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

    test("warns once (console.warn) when project mcpServers present and flag not set, but STILL loads them on every call — the warning itself is deduped, not the loading", () => {
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
            expect(warnCalls.length).toBe(1);

            // Second load of the SAME project: servers are still merged (the
            // gate never blocks loading — see describe title), but the warning
            // does not fire again. warnLoadConfigOnce dedupes per (projectPath,
            // code, message) for the lifetime of the process.
            const config2 = loadConfig(projectDir);
            expect((config2 as any).mcpServers).toHaveProperty("projectServer");
            expect(warnCalls.length).toBe(1);
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
        //
        // path.relative()/path.resolve() are exact lexical inverses (pure
        // string manipulation, no filesystem access) — resolve(cwd,
        // relative(cwd, p)) === p always holds, even when p is outside cwd's
        // subtree (relative() just emits "../" segments). Using them
        // unconditionally guarantees this test actually exercises a relative
        // path, unlike a "use absolute if not under cwd" fallback, which
        // could silently degrade to re-testing the absolute-path case
        // depending on where the OS puts tmpdir() relative to cwd.
        const pluginPath = join(tmpHome, "relative-check");
        mkdirSync(pluginPath, { recursive: true });
        trustPlugin(pluginPath);

        const relativePath = relative(process.cwd(), pluginPath);
        expect(relativePath).not.toBe(pluginPath); // sanity: genuinely relative, not accidentally absolute
        expect(resolve(process.cwd(), relativePath)).toBe(resolve(pluginPath));
        expect(isPluginTrusted(relativePath)).toBe(true);
    });
});

describe("trustedPlugins enforcement via createClaudePluginExtension / getPluginSkillPaths / getPluginAgentPaths (real production call sites)", () => {
    function writeLocalPlugin(name: string, opts: { skill?: boolean; agent?: boolean } = {}): string {
        const pluginDir = join(projectDir, ".pizzapi", "plugins", name);
        mkdirSync(join(pluginDir, "commands"), { recursive: true });
        writeFileSync(join(pluginDir, "commands", "test.md"), "# test\nHello from " + name + ".");
        if (opts.skill) {
            mkdirSync(join(pluginDir, "skills", "foo"), { recursive: true });
            writeFileSync(join(pluginDir, "skills", "foo", "SKILL.md"), "# Foo skill");
        }
        if (opts.agent) {
            mkdirSync(join(pluginDir, "agents"), { recursive: true });
            writeFileSync(join(pluginDir, "agents", "helper.md"), "# Helper agent");
        }
        return pluginDir;
    }

    function makeMockPi() {
        const commands = new Map<string, unknown>();
        const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
        const events = new EventEmitter();
        const api = {
            registerCommand(name: string, opts: unknown) { commands.set(name, opts); },
            on(event: string, handler: (event: unknown, ctx: unknown) => unknown) { handlers.set(event, handler); },
            sendUserMessage() {},
            events,
        };
        return { api, commands, handlers, events };
    }

    test("untrusted local plugin's command is NOT registered when the trust prompt is declined", async () => {
        writeLocalPlugin("untrusted-cmd");
        const factory = createClaudePluginExtension(projectDir);
        expect(factory).not.toBeNull();

        const { api, commands, handlers, events } = makeMockPi();
        factory!(api as any);
        events.on("plugin:trust_prompt", (data: any) => data.respond(false));

        await handlers.get("session_start")?.(
            { type: "session_start" },
            { hasUI: false, ui: { notify() {} }, cwd: projectDir },
        );

        expect(commands.has("test")).toBe(false);
    });

    test("pre-trusted local plugin's command IS registered on session_start, with no prompt (real trustPlugin \u2192 createClaudePluginExtension path)", async () => {
        const pluginDir = writeLocalPlugin("trusted-cmd");
        trustPlugin(pluginDir);

        const factory = createClaudePluginExtension(projectDir);
        const { api, commands, handlers, events } = makeMockPi();
        let prompted = false;
        events.on("plugin:trust_prompt", () => { prompted = true; });
        factory!(api as any);

        await handlers.get("session_start")?.(
            { type: "session_start" },
            { hasUI: false, ui: { notify() {} }, cwd: projectDir },
        );

        // "test" is a top-level, plain .md command — native-compatible, so it's
        // routed through pi's own prompt-template loader (getPluginPromptTemplatePaths)
        // instead of the bespoke pi.registerCommand() adapter (see isNativeCompatibleCommand).
        expect(commands.has("test")).toBe(false);
        expect(getPluginPromptTemplatePaths(projectDir)).toContain(join(pluginDir, "commands", "test.md"));
        expect(prompted).toBe(false);
    });

    test("accepting the trust prompt makes a newly-trusted plugin's native-compatible command available via resources_discover in the SAME session_start bind cycle — no restart", async () => {
        const pluginDir = writeLocalPlugin("newly-trusted-cmd");
        const factory = createClaudePluginExtension(projectDir);
        expect(factory).not.toBeNull();

        const { api, handlers, events } = makeMockPi();
        factory!(api as any);
        events.on("plugin:trust_prompt", (data: any) => data.respond(true));

        // Before session_start: the plugin isn't trusted yet, so pi's
        // startup-time additionalPromptTemplatePaths (built from
        // getPluginPromptTemplatePaths() before this factory ever runs)
        // would not have included it either — nothing to assert here except
        // that trust hasn't happened yet.
        expect(isPluginTrusted(pluginDir)).toBe(false);

        // Real ordering: pi's bindExtensions() awaits session_start handlers
        // to fully resolve (including this factory's trust-prompt await),
        // THEN fires resources_discover — all within one bind cycle, no
        // process restart in between.
        await handlers.get("session_start")?.(
            { type: "session_start" },
            { hasUI: false, ui: { notify() {} }, cwd: projectDir },
        );
        expect(isPluginTrusted(pluginDir)).toBe(true); // trust was persisted

        const discovered = await handlers.get("resources_discover")?.({ cwd: projectDir, reason: "startup" }, {} as any) as { promptPaths?: string[] } | undefined;
        expect(discovered?.promptPaths).toContain(join(pluginDir, "commands", "test.md"));
    });

    test("getPluginSkillPaths excludes an untrusted local plugin's skills dir", () => {
        const pluginDir = writeLocalPlugin("untrusted-skill", { skill: true });
        expect(getPluginSkillPaths(projectDir)).not.toContain(join(pluginDir, "skills"));
    });

    test("getPluginSkillPaths includes a trusted local plugin's skills dir", () => {
        const pluginDir = writeLocalPlugin("trusted-skill", { skill: true });
        trustPlugin(pluginDir);
        expect(getPluginSkillPaths(projectDir)).toContain(join(pluginDir, "skills"));
    });

    test("getPluginAgentPaths excludes an untrusted local plugin's agents dir", () => {
        const pluginDir = writeLocalPlugin("untrusted-agent", { agent: true });
        expect(getPluginAgentPaths(projectDir)).not.toContain(join(pluginDir, "agents"));
    });

    test("getPluginAgentPaths includes a trusted local plugin's agents dir", () => {
        const pluginDir = writeLocalPlugin("trusted-agent", { agent: true });
        trustPlugin(pluginDir);
        expect(getPluginAgentPaths(projectDir)).toContain(join(pluginDir, "agents"));
    });
});
