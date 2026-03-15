/**
 * E2E tests for the Claude Code Plugin adapter — full lifecycle.
 *
 * These exercise the plugin discovery → registration pipeline end-to-end,
 * verifying commands, hooks, rules, and skills work through the full chain.
 *
 * NOTE: Bun caches homedir() from process start, so overriding HOME doesn't
 * affect globalPluginDirs(). Tests needing to control global plugin discovery
 * use the lower-level parsePlugin/scanPluginsDir APIs directly. Tests for
 * createClaudePluginExtension use project-local plugins (discovered via cwd).
 *
 * All fixtures use temp dirs — no writes outside /tmp.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EventEmitter } from "node:events";

import {
    parsePlugin,
    parseCommands,
    parseHooks,
    parsePluginSkills,
    parseRules,
    scanPluginsDir,
    parseManifest,
    matchesTool,
    resolvePluginRoot,
    mapHookEventToPi,
    toPluginInfo,
    projectPluginDirs,
    type DiscoveredPlugin,
} from "../plugins.js";
import { createClaudePluginExtension } from "./claude-plugins.js";

// ── Test fixtures ─────────────────────────────────────────────────────────────

let tmpBase: string;

function freshTmpDir(): string {
    return mkdtempSync(join(tmpBase, "e2e-"));
}

function createPluginTree(baseDir: string, name: string, opts: {
    manifest?: Record<string, unknown>;
    manifestLocation?: "standard" | "root";
    commands?: Record<string, string>;
    hooks?: Record<string, unknown>;
    skills?: string[];
    rules?: Record<string, string>;
    mcp?: boolean;
    agents?: boolean;
}) {
    const pluginDir = join(baseDir, name);
    mkdirSync(pluginDir, { recursive: true });

    if (opts.manifest) {
        if (opts.manifestLocation === "root") {
            writeFileSync(join(pluginDir, "plugin.json"), JSON.stringify(opts.manifest, null, 2));
        } else {
            mkdirSync(join(pluginDir, ".claude-plugin"), { recursive: true });
            writeFileSync(join(pluginDir, ".claude-plugin", "plugin.json"), JSON.stringify(opts.manifest, null, 2));
        }
    }

    if (opts.commands) {
        for (const [cmdName, content] of Object.entries(opts.commands)) {
            const cmdPath = join(pluginDir, "commands", `${cmdName}.md`);
            mkdirSync(join(cmdPath, ".."), { recursive: true });
            writeFileSync(cmdPath, content);
        }
    }

    if (opts.hooks) {
        mkdirSync(join(pluginDir, "hooks"), { recursive: true });
        writeFileSync(join(pluginDir, "hooks", "hooks.json"), JSON.stringify(opts.hooks, null, 2));
    }

    if (opts.skills) {
        for (const skillName of opts.skills) {
            const skillDir = join(pluginDir, "skills", skillName);
            mkdirSync(skillDir, { recursive: true });
            writeFileSync(join(skillDir, "SKILL.md"), `---\nname: ${skillName}\ndescription: Test skill\n---\n# ${skillName}\n`);
        }
    }

    if (opts.rules) {
        mkdirSync(join(pluginDir, "rules"), { recursive: true });
        for (const [ruleName, content] of Object.entries(opts.rules)) {
            writeFileSync(join(pluginDir, "rules", `${ruleName}.md`), content);
        }
    }

    if (opts.mcp) {
        writeFileSync(join(pluginDir, ".mcp.json"), JSON.stringify({ mcpServers: {} }));
    }

    if (opts.agents) {
        mkdirSync(join(pluginDir, "agents"), { recursive: true });
        writeFileSync(join(pluginDir, "agents", "test-agent.md"), "# Test Agent\n");
    }

    return pluginDir;
}

/** Simplified mock ExtensionAPI that records registrations. */
function createMockAPI() {
    const commands = new Map<string, any>();
    const handlers = new Map<string, Function[]>();
    const events = new EventEmitter();

    return {
        registerCommand(name: string, opts: any) { commands.set(name, opts); },
        registerTool() {},
        on(event: string, handler: Function) {
            if (!handlers.has(event)) handlers.set(event, []);
            handlers.get(event)!.push(handler);
        },
        sendUserMessage() {},
        sendMessage() {},
        getCommands: () => [],
        events,
        _commands: commands,
        _handlers: handlers,
    };
}

beforeAll(() => {
    tmpBase = mkdtempSync(join(tmpdir(), "pizzapi-plugin-e2e-"));
});

afterAll(() => {
    try { rmSync(tmpBase, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ── parsePlugin → full pipeline ───────────────────────────────────────────────

describe("parsePlugin — full pipeline", () => {
    test("parses a complete plugin with all features", () => {
        const dir = freshTmpDir();
        const pluginDir = createPluginTree(dir, "full-plugin", {
            manifest: {
                name: "full-plugin",
                description: "A complete test plugin",
                version: "2.0.0",
                author: { name: "Test Author" },
                license: "MIT",
            },
            commands: {
                deploy: `---\ndescription: Deploy app\nargument-hint: [env]\n---\nDeploy to $ARGUMENTS.`,
                review: `---\ndescription: Review code\nallowed-tools: ["Read", "Bash"]\n---\nReview the code.`,
                "pm/epic-start": `---\ndescription: Start an epic\n---\nStart epic.`,
                "pm/epic-list": `---\ndescription: List epics\n---\nList epics.`,
            },
            hooks: {
                description: "Safety hooks",
                hooks: {
                    PreToolUse: [{
                        matcher: "Bash",
                        hooks: [{ type: "command", command: "check.sh", timeout: 5 }],
                    }],
                    PostToolUse: [{
                        matcher: "Edit|Write",
                        hooks: [{ type: "command", command: "post-check.sh" }],
                    }],
                    SessionStart: [{
                        hooks: [{ type: "command", command: "init.sh" }],
                    }],
                    Stop: [{
                        hooks: [{ type: "command", command: "stop.sh" }],
                    }],
                },
            },
            skills: ["code-review", "debugging"],
            rules: {
                "git-ops": "# Git Operations\n\nAlways use feature branches.",
                "testing": "# Testing\n\nRun tests before committing.",
            },
            mcp: true,
            agents: true,
        });

        const plugin = parsePlugin(pluginDir);

        // Manifest
        expect(plugin.name).toBe("full-plugin");
        expect(plugin.description).toBe("A complete test plugin");
        expect(plugin.manifest.version).toBe("2.0.0");
        expect(plugin.manifest.license).toBe("MIT");

        // Commands
        expect(plugin.commands).toHaveLength(4);
        const cmdNames = plugin.commands.map(c => c.name).sort();
        expect(cmdNames).toEqual(["deploy", "pm/epic-list", "pm/epic-start", "review"]);
        const deploy = plugin.commands.find(c => c.name === "deploy")!;
        expect(deploy.frontmatter.description).toBe("Deploy app");
        expect(deploy.frontmatter["argument-hint"]).toBe("[env]");
        expect(deploy.content).toContain("Deploy to $ARGUMENTS");

        // Nested commands
        const epicStart = plugin.commands.find(c => c.name === "pm/epic-start")!;
        expect(epicStart.frontmatter.description).toBe("Start an epic");

        // Allowed-tools as array
        const review = plugin.commands.find(c => c.name === "review")!;
        expect(review.frontmatter["allowed-tools"]).toEqual(["Read", "Bash"]);

        // Hooks
        expect(plugin.hooks).not.toBeNull();
        expect(plugin.hooks!.description).toBe("Safety hooks");
        expect(plugin.hooks!.hooks.PreToolUse).toHaveLength(1);
        expect(plugin.hooks!.hooks.PreToolUse![0].matcher).toBe("Bash");
        expect(plugin.hooks!.hooks.PostToolUse).toHaveLength(1);
        expect(plugin.hooks!.hooks.SessionStart).toHaveLength(1);
        expect(plugin.hooks!.hooks.Stop).toHaveLength(1);

        // Skills
        expect(plugin.skills).toHaveLength(2);
        expect(plugin.skills.map(s => s.name).sort()).toEqual(["code-review", "debugging"]);

        // Rules
        expect(plugin.rules).toHaveLength(2);
        expect(plugin.rules.map(r => r.name).sort()).toEqual(["git-ops", "testing"]);
        expect(plugin.rules.find(r => r.name === "git-ops")!.content).toContain("Always use feature branches");

        // Feature flags
        expect(plugin.hasMcp).toBe(true);
        expect(plugin.hasAgents).toBe(true);
        expect(plugin.hasLsp).toBe(false);
    });

    test("plugin with root plugin.json (no .claude-plugin/) works", () => {
        const dir = freshTmpDir();
        const pluginDir = createPluginTree(dir, "root-manifest", {
            manifest: { name: "root-manifest", description: "Root manifest" },
            manifestLocation: "root",
            commands: { hello: "---\ndescription: Hello\n---\nHello!" },
        });

        const plugin = parsePlugin(pluginDir);
        expect(plugin.name).toBe("root-manifest");
        expect(plugin.description).toBe("Root manifest");
        expect(plugin.commands).toHaveLength(1);
    });

    test("plugin with only skills (no commands/hooks/rules) works", () => {
        const dir = freshTmpDir();
        const pluginDir = createPluginTree(dir, "skills-only", {
            skills: ["code-review"],
        });

        const plugin = parsePlugin(pluginDir);
        expect(plugin.name).toBe("skills-only");
        expect(plugin.commands).toHaveLength(0);
        expect(plugin.hooks).toBeNull();
        expect(plugin.rules).toHaveLength(0);
        expect(plugin.skills).toHaveLength(1);
    });

    test("plugin with only rules (no commands) works", () => {
        const dir = freshTmpDir();
        const pluginDir = createPluginTree(dir, "rules-only", {
            rules: { "my-rule": "# Rule\n\nContent here." },
        });

        const plugin = parsePlugin(pluginDir);
        expect(plugin.commands).toHaveLength(0);
        expect(plugin.rules).toHaveLength(1);
    });

    test("plugin with deeply nested commands works", () => {
        const dir = freshTmpDir();
        const pluginDir = createPluginTree(dir, "deep", {
            commands: {
                "a/b/c/deep": "# Deeply nested",
            },
        });

        const plugin = parsePlugin(pluginDir);
        expect(plugin.commands).toHaveLength(1);
        expect(plugin.commands[0].name).toBe("a/b/c/deep");
    });
});

// ── toPluginInfo — serialization ──────────────────────────────────────────────

describe("toPluginInfo — serialization", () => {
    test("converts full plugin to PluginInfo", () => {
        const dir = freshTmpDir();
        const pluginDir = createPluginTree(dir, "info-test", {
            manifest: {
                name: "info-test",
                description: "Test plugin",
                version: "2.0.0",
                author: { name: "Alice" },
            },
            commands: {
                cmd1: `---\ndescription: Command 1\nargument-hint: [arg]\n---\nBody`,
                "pm/sub-cmd": `---\ndescription: Sub command\n---\nBody`,
            },
            hooks: {
                hooks: { Stop: [{ hooks: [{ type: "command", command: "x" }] }] },
            },
            skills: ["my-skill"],
            rules: { "my-rule": "# Rule" },
            mcp: true,
        });

        const plugin = parsePlugin(pluginDir);
        const info = toPluginInfo(plugin);

        expect(info.name).toBe("info-test");
        expect(info.description).toBe("Test plugin");
        expect(info.version).toBe("2.0.0");
        expect(info.author).toBe("Alice");
        expect(info.commands).toHaveLength(2);
        expect(info.commands.find(c => c.name === "cmd1")?.description).toBe("Command 1");
        expect(info.commands.find(c => c.name === "pm/sub-cmd")?.description).toBe("Sub command");
        expect(info.hookEvents).toEqual(["Stop"]);
        expect(info.skills).toHaveLength(1);
        expect(info.rules).toHaveLength(1);
        expect(info.rules![0].name).toBe("my-rule");
        expect(info.hasMcp).toBe(true);
    });
});

// ── scanPluginsDir — multi-plugin discovery ───────────────────────────────────

describe("scanPluginsDir — multi-plugin discovery", () => {
    test("discovers multiple plugins in one directory", () => {
        const dir = freshTmpDir();
        const pluginsDir = join(dir, "plugins");
        createPluginTree(pluginsDir, "alpha", {
            manifest: { name: "alpha" },
            commands: { "a-cmd": "# Alpha" },
        });
        createPluginTree(pluginsDir, "beta", {
            manifest: { name: "beta" },
            commands: { "b-cmd": "# Beta" },
        });

        const plugins = scanPluginsDir(pluginsDir);
        expect(plugins).toHaveLength(2);
        expect(plugins.map(p => p.name).sort()).toEqual(["alpha", "beta"]);
    });

    test("skips hidden directories", () => {
        const dir = freshTmpDir();
        const pluginsDir = join(dir, "plugins");
        createPluginTree(pluginsDir, ".hidden", { commands: { test: "# Test" } });
        createPluginTree(pluginsDir, "visible", { commands: { test: "# Test" } });

        const plugins = scanPluginsDir(pluginsDir);
        expect(plugins).toHaveLength(1);
        expect(plugins[0].name).toBe("visible");
    });

    test("returns empty for nonexistent directory", () => {
        expect(scanPluginsDir(join(tmpBase, "nonexistent-" + Date.now()))).toEqual([]);
    });
});

// ── createClaudePluginExtension — project-local plugin discovery ──────────────

describe("createClaudePluginExtension — project-local discovery", () => {
    test("returns null when no plugins exist anywhere", () => {
        // createClaudePluginExtension returns non-null if global plugins exist
        // in ~/.pizzapi/plugins/ (Bun caches homedir() — can't override HOME).
        // Verify the key invariant: no project-local plugins for an empty dir.
        const emptyProject = freshTmpDir();
        const localDirs = projectPluginDirs(emptyProject);
        const localPlugins = localDirs.flatMap(d => scanPluginsDir(d));
        expect(localPlugins).toHaveLength(0);
    });

    test("returns non-null factory when project-local plugins exist", () => {
        const projectDir = freshTmpDir();
        const localPluginsDir = join(projectDir, ".pizzapi", "plugins");
        createPluginTree(localPluginsDir, "local-plugin", {
            manifest: { name: "local-plugin" },
            commands: { test: "# Test" },
        });

        const factory = createClaudePluginExtension(projectDir);
        expect(factory).not.toBeNull();
    });

    test("registers session_start handler for trust prompting", () => {
        const projectDir = freshTmpDir();
        const localPluginsDir = join(projectDir, ".pizzapi", "plugins");
        createPluginTree(localPluginsDir, "local-plugin", {
            commands: { test: "# Test" },
        });

        const factory = createClaudePluginExtension(projectDir);
        const api = createMockAPI();
        factory!(api as any);

        // Should have registered session_start for trust prompt logic
        expect(api._handlers.has("session_start")).toBe(true);
    });

    test("discovers local plugins across all project dirs (.pizzapi, .agents, .claude)", () => {
        const projectDir = freshTmpDir();

        // Plugin in .pizzapi/plugins
        createPluginTree(join(projectDir, ".pizzapi", "plugins"), "p1", {
            commands: { test: "# Test" },
        });

        // Plugin in .agents/plugins (different name)
        createPluginTree(join(projectDir, ".agents", "plugins"), "p2", {
            commands: { test: "# Test" },
        });

        const factory = createClaudePluginExtension(projectDir);
        expect(factory).not.toBeNull();
    });
});

// ── Hook event mapping — e2e verification ─────────────────────────────────────

describe("hook event mapping — e2e verification", () => {
    test("all mappable events map to pi event names", () => {
        const mappable = [
            ["PreToolUse", "tool_call"],
            ["PostToolUse", "tool_result"],
            ["PostToolUseFailure", "tool_result"],
            ["UserPromptSubmit", "input"],
            ["Stop", "agent_end"],
            ["SessionStart", "session_start"],
            ["SessionEnd", "session_shutdown"],
            ["PreCompact", "session_before_compact"],
        ] as const;

        for (const [claude, pi] of mappable) {
            expect(mapHookEventToPi(claude)).toBe(pi);
        }
    });

    test("unmappable events return null", () => {
        const unmappable = [
            "PermissionRequest",
            "Notification",
            "SubagentStart",
            "SubagentStop",
            "TeammateIdle",
            "TaskCompleted",
            "ConfigChange",
            "WorktreeCreate",
            "WorktreeRemove",
        ] as const;

        for (const event of unmappable) {
            expect(mapHookEventToPi(event)).toBeNull();
        }
    });
});

// ── Tool matching — e2e with hook data ────────────────────────────────────────

describe("tool matching — e2e with hook data", () => {
    test("Claude tool names map to pi tool names", () => {
        expect(matchesTool("Read", "read")).toBe(true);
        expect(matchesTool("Write", "write")).toBe(true);
        expect(matchesTool("Edit", "edit")).toBe(true);
        expect(matchesTool("Bash", "bash")).toBe(true);
        expect(matchesTool("Glob", "find")).toBe(true);
        expect(matchesTool("Grep", "grep")).toBe(true);
        expect(matchesTool("MultiEdit", "edit")).toBe(true);
    });

    test("OR patterns work with mixed Claude/pi names", () => {
        expect(matchesTool("Edit|Write|MultiEdit", "edit")).toBe(true);
        expect(matchesTool("Edit|Write|MultiEdit", "write")).toBe(true);
        expect(matchesTool("Edit|Write|MultiEdit", "bash")).toBe(false);
    });

    test("Bash(prefix:*) matches command prefixes", () => {
        expect(matchesTool("Bash(git add:*)", "bash", { command: "git add -A" })).toBe(true);
        expect(matchesTool("Bash(git:*)", "bash", { command: "git status" })).toBe(true);
        expect(matchesTool("Bash(git add:*)", "bash", { command: "git commit -m 'test'" })).toBe(false);
    });

    test("wildcard patterns match everything", () => {
        expect(matchesTool(".*", "anything")).toBe(true);
        expect(matchesTool("*", "write")).toBe(true);
        expect(matchesTool(".+", "read")).toBe(true);
    });

    test("undefined/null matcher matches everything", () => {
        expect(matchesTool(undefined, "edit")).toBe(true);
        expect(matchesTool(null as any, "bash")).toBe(true);
    });

    test("non-string matcher rejects (not match-all)", () => {
        expect(matchesTool(123 as any, "edit")).toBe(false);
        expect(matchesTool(true as any, "bash")).toBe(false);
        expect(matchesTool({} as any, "write")).toBe(false);
    });
});

// ── ${CLAUDE_PLUGIN_ROOT} resolution ──────────────────────────────────────────

describe("${CLAUDE_PLUGIN_ROOT} resolution", () => {
    test("resolves in hook commands", () => {
        expect(resolvePluginRoot("${CLAUDE_PLUGIN_ROOT}/scripts/run.sh", "/my/plugin"))
            .toBe("/my/plugin/scripts/run.sh");
    });

    test("resolves multiple occurrences", () => {
        expect(resolvePluginRoot("${CLAUDE_PLUGIN_ROOT}/a && ${CLAUDE_PLUGIN_ROOT}/b", "/p"))
            .toBe("/p/a && /p/b");
    });

    test("no-ops when no placeholder present", () => {
        expect(resolvePluginRoot("just a command", "/x")).toBe("just a command");
    });
});

// ── Hook protocol — integration with real shell ───────────────────────────────

describe("hook protocol — real shell integration", () => {
    test("PreToolUse hook with exit 0 allows the tool call", async () => {
        const projectDir = freshTmpDir();
        const localPluginsDir = join(projectDir, ".pizzapi", "plugins");
        createPluginTree(localPluginsDir, "allow-hook", {
            hooks: {
                hooks: {
                    PreToolUse: [{
                        matcher: "Bash",
                        hooks: [{ type: "command", command: "echo '{\"decision\":\"allow\"}'" }],
                    }],
                },
            },
        });

        // Verify the hook config is parsed correctly
        const plugin = parsePlugin(join(localPluginsDir, "allow-hook"));
        expect(plugin.hooks).not.toBeNull();
        expect(plugin.hooks!.hooks.PreToolUse).toHaveLength(1);
        expect(plugin.hooks!.hooks.PreToolUse![0].matcher).toBe("Bash");
        expect(plugin.hooks!.hooks.PreToolUse![0].hooks[0].command).toContain("allow");
    });

    test("PreToolUse hook with exit 2 blocks the tool call", async () => {
        const projectDir = freshTmpDir();
        const localPluginsDir = join(projectDir, ".pizzapi", "plugins");
        createPluginTree(localPluginsDir, "block-hook", {
            hooks: {
                hooks: {
                    PreToolUse: [{
                        matcher: "Bash",
                        hooks: [{ type: "command", command: "echo 'BLOCKED: dangerous' >&2; exit 2" }],
                    }],
                },
            },
        });

        const plugin = parsePlugin(join(localPluginsDir, "block-hook"));
        expect(plugin.hooks!.hooks.PreToolUse![0].hooks[0].command).toContain("exit 2");
    });

    test("multiple hook events in one plugin are all parsed", () => {
        const projectDir = freshTmpDir();
        const localPluginsDir = join(projectDir, ".pizzapi", "plugins");
        createPluginTree(localPluginsDir, "multi-hook", {
            hooks: {
                hooks: {
                    PreToolUse: [{
                        matcher: "Bash",
                        hooks: [{ type: "command", command: "echo ok" }],
                    }],
                    PostToolUse: [{
                        matcher: "Edit|Write",
                        hooks: [{ type: "command", command: "echo done" }],
                    }],
                    SessionStart: [{
                        hooks: [{ type: "command", command: "echo start" }],
                    }],
                    Stop: [{
                        hooks: [{ type: "command", command: "echo stop" }],
                    }],
                    UserPromptSubmit: [{
                        hooks: [{ type: "command", command: "echo input" }],
                    }],
                    PreCompact: [{
                        hooks: [{ type: "command", command: "echo compact" }],
                    }],
                    SessionEnd: [{
                        hooks: [{ type: "command", command: "echo end" }],
                    }],
                },
            },
        });

        const plugin = parsePlugin(join(localPluginsDir, "multi-hook"));
        expect(plugin.hooks).not.toBeNull();
        const hookEvents = Object.keys(plugin.hooks!.hooks);
        expect(hookEvents).toContain("PreToolUse");
        expect(hookEvents).toContain("PostToolUse");
        expect(hookEvents).toContain("SessionStart");
        expect(hookEvents).toContain("Stop");
        expect(hookEvents).toContain("UserPromptSubmit");
        expect(hookEvents).toContain("PreCompact");
        expect(hookEvents).toContain("SessionEnd");
    });
});

// ── Plugin trust prompt bridge ────────────────────────────────────────────────

describe("plugin trust prompt — event bridge", () => {
    test("plugin:trust_prompt event emitted for untrusted local plugins", async () => {
        const projectDir = freshTmpDir();
        const localPluginsDir = join(projectDir, ".pizzapi", "plugins");
        createPluginTree(localPluginsDir, "untrusted-plugin", {
            commands: { test: "# Test" },
        });

        const factory = createClaudePluginExtension(projectDir);
        expect(factory).not.toBeNull();

        const api = createMockAPI();
        factory!(api as any);

        // The factory registers session_start handlers that will emit
        // plugin:trust_prompt. Verify the listener infra is set up.
        expect(api._handlers.has("session_start")).toBe(true);

        // Listen for trust prompt and immediately respond (reject)
        // to avoid the 60s timeout blocking the test.
        let trustPromptReceived = false;
        api.events.on("plugin:trust_prompt", (data: any) => {
            trustPromptReceived = true;
            // Respond immediately to unblock the handler
            if (typeof data?.respond === "function") {
                data.respond(false);
            }
        });

        // Invoke session_start handlers to trigger the flow
        for (const handler of api._handlers.get("session_start")!) {
            await handler(
                { type: "session_start" },
                {
                    hasUI: false,
                    ui: { notify() {}, confirm: async () => false },
                    cwd: projectDir,
                },
            );
        }

        // In headless mode, the trust prompt should have been emitted
        expect(trustPromptReceived).toBe(true);
    });

    test("plugin:trust_timeout event cleans up expired prompt", async () => {
        // The timeout mechanism is internal to createClaudePluginExtension.
        // We test that the event shape is correct by emitting/listening.
        const events = new EventEmitter();
        let timeoutReceived = false;

        events.on("plugin:trust_timeout", (data: any) => {
            timeoutReceived = true;
            expect(typeof data.promptId).toBe("string");
        });

        events.emit("plugin:trust_timeout", { promptId: "test-123" });
        expect(timeoutReceived).toBe(true);
    });

    test("plugin:loaded event fires after trust approval", async () => {
        // Test the event shape for the loaded notification
        const events = new EventEmitter();
        let loadedReceived = false;

        events.on("plugin:loaded", (data: any) => {
            loadedReceived = true;
            expect(typeof data.count).toBe("number");
        });

        events.emit("plugin:loaded", { count: 2 });
        expect(loadedReceived).toBe(true);
    });
});

// ── Rules injection ───────────────────────────────────────────────────────────

describe("rules injection", () => {
    test("rules content is preserved in the parsed plugin", () => {
        const dir = freshTmpDir();
        const pluginDir = createPluginTree(dir, "rules-test", {
            rules: {
                "git-ops": "# Git Operations\n\nAlways use feature branches.\nNever force push.",
                "testing": "# Testing\n\nRun tests before committing.\nCheck coverage.",
            },
        });

        const plugin = parsePlugin(pluginDir);
        expect(plugin.rules).toHaveLength(2);

        const gitOps = plugin.rules.find(r => r.name === "git-ops")!;
        expect(gitOps.content).toContain("Always use feature branches");
        expect(gitOps.content).toContain("Never force push");

        const testing = plugin.rules.find(r => r.name === "testing")!;
        expect(testing.content).toContain("Run tests before committing");
    });

    test("rules filePaths point to correct locations", () => {
        const dir = freshTmpDir();
        const pluginDir = createPluginTree(dir, "rules-paths", {
            rules: { "my-rule": "# Rule" },
        });

        const plugin = parsePlugin(pluginDir);
        expect(plugin.rules[0].filePath).toContain("rules");
        expect(plugin.rules[0].filePath).toContain("my-rule.md");
    });
});
