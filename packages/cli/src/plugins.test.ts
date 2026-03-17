/**
 * Tests for Claude Code Plugin adapter — core parsing and discovery.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
    parseMarkdownFrontmatter,
    parseManifest,
    parseCommands,
    parseHooks,
    parsePluginSkills,
    parseRules,
    parsePlugin,
    isPluginDir,
    scanPluginsDir,
    discoverPlugins,
    discoverClaudeInstalledPlugins,
    pluginSearchDirs,
    globalPluginDirs,
    projectPluginDirs,
    resolvePluginRoot,
    matchesTool,
    mapHookEventToPi,
    toPluginInfo,
    type DiscoveredPlugin,
} from "./plugins.js";

// ── Test fixtures ─────────────────────────────────────────────────────────────

let fixtureDir: string;

function createPlugin(name: string, opts: {
    manifest?: Record<string, unknown>;
    /** Pass "root" to place manifest at plugin root instead of .claude-plugin/ */
    manifestLocation?: "standard" | "root";
    commands?: Record<string, string>;
    hooks?: Record<string, unknown>;
    skills?: string[];
    rules?: Record<string, string>;
    mcp?: boolean;
    agents?: boolean;
}) {
    const pluginDir = join(fixtureDir, "plugins", name);
    mkdirSync(pluginDir, { recursive: true });

    // Manifest
    if (opts.manifest) {
        if (opts.manifestLocation === "root") {
            writeFileSync(
                join(pluginDir, "plugin.json"),
                JSON.stringify(opts.manifest, null, 2),
            );
        } else {
            mkdirSync(join(pluginDir, ".claude-plugin"), { recursive: true });
            writeFileSync(
                join(pluginDir, ".claude-plugin", "plugin.json"),
                JSON.stringify(opts.manifest, null, 2),
            );
        }
    }

    // Commands — supports nested paths like "pm/epic-start"
    if (opts.commands) {
        for (const [cmdName, content] of Object.entries(opts.commands)) {
            const cmdPath = join(pluginDir, "commands", `${cmdName}.md`);
            mkdirSync(join(cmdPath, ".."), { recursive: true });
            writeFileSync(cmdPath, content);
        }
    }

    // Hooks
    if (opts.hooks) {
        mkdirSync(join(pluginDir, "hooks"), { recursive: true });
        writeFileSync(
            join(pluginDir, "hooks", "hooks.json"),
            JSON.stringify(opts.hooks, null, 2),
        );
    }

    // Skills
    if (opts.skills) {
        for (const skillName of opts.skills) {
            const skillDir = join(pluginDir, "skills", skillName);
            mkdirSync(skillDir, { recursive: true });
            writeFileSync(join(skillDir, "SKILL.md"), `---\nname: ${skillName}\ndescription: Test skill ${skillName}\n---\n# ${skillName}\n`);
        }
    }

    // Rules
    if (opts.rules) {
        mkdirSync(join(pluginDir, "rules"), { recursive: true });
        for (const [ruleName, content] of Object.entries(opts.rules)) {
            writeFileSync(join(pluginDir, "rules", `${ruleName}.md`), content);
        }
    }

    // MCP
    if (opts.mcp) {
        writeFileSync(join(pluginDir, ".mcp.json"), JSON.stringify({ mcpServers: {} }));
    }

    // Agents
    if (opts.agents) {
        mkdirSync(join(pluginDir, "agents"), { recursive: true });
        writeFileSync(join(pluginDir, "agents", "test-agent.md"), "# Test Agent\n");
    }

    return pluginDir;
}

beforeAll(() => {
    fixtureDir = mkdtempSync(join(tmpdir(), "pizzapi-plugins-test-"));
});

afterAll(() => {
    try {
        rmSync(fixtureDir, { recursive: true, force: true });
    } catch { /* ignore */ }
});

// ── parseMarkdownFrontmatter ──────────────────────────────────────────────────

describe("parseMarkdownFrontmatter", () => {
    test("parses basic frontmatter", () => {
        const content = `---
description: A test command
argument-hint: <arg>
---

# Body content here`;

        const { frontmatter, body } = parseMarkdownFrontmatter(content);
        expect(frontmatter.description).toBe("A test command");
        expect(frontmatter["argument-hint"]).toBe("<arg>");
        expect(body).toContain("# Body content here");
    });

    test("handles quoted values", () => {
        const content = `---
description: "A quoted description"
name: 'single-quoted'
---
Body`;

        const { frontmatter } = parseMarkdownFrontmatter(content);
        expect(frontmatter.description).toBe("A quoted description");
        expect(frontmatter.name).toBe("single-quoted");
    });

    test("parses JSON array values", () => {
        const content = `---
allowed-tools: ["Read", "Bash", "Write"]
---
Body`;

        const { frontmatter } = parseMarkdownFrontmatter(content);
        expect(frontmatter["allowed-tools"]).toEqual(["Read", "Bash", "Write"]);
    });

    test("parses unquoted array values", () => {
        const content = `---
allowed-tools: [Read, Bash, Write]
---
Body`;

        const { frontmatter } = parseMarkdownFrontmatter(content);
        expect(frontmatter["allowed-tools"]).toEqual(["Read", "Bash", "Write"]);
    });

    test("parses boolean values", () => {
        const content = `---
disable-model-invocation: true
some-flag: false
---
Body`;

        const { frontmatter } = parseMarkdownFrontmatter(content);
        expect(frontmatter["disable-model-invocation"]).toBe(true);
        expect(frontmatter["some-flag"]).toBe(false);
    });

    test("returns empty frontmatter if no delimiters", () => {
        const content = `# Just a markdown file\n\nNo frontmatter here.`;
        const { frontmatter, body } = parseMarkdownFrontmatter(content);
        expect(frontmatter).toEqual({});
        expect(body).toBe(content);
    });

    test("returns empty frontmatter if closing delimiter missing", () => {
        const content = `---\nname: test\nThis never closes`;
        const { frontmatter } = parseMarkdownFrontmatter(content);
        expect(frontmatter).toEqual({});
    });
});

// ── resolvePluginRoot ─────────────────────────────────────────────────────────

describe("resolvePluginRoot", () => {
    test("replaces ${CLAUDE_PLUGIN_ROOT} placeholders", () => {
        const input = "${CLAUDE_PLUGIN_ROOT}/scripts/run.sh";
        expect(resolvePluginRoot(input, "/home/user/my-plugin")).toBe("/home/user/my-plugin/scripts/run.sh");
    });

    test("replaces multiple occurrences", () => {
        const input = "${CLAUDE_PLUGIN_ROOT}/a && ${CLAUDE_PLUGIN_ROOT}/b";
        expect(resolvePluginRoot(input, "/plugin")).toBe("/plugin/a && /plugin/b");
    });

    test("no-ops when no placeholders present", () => {
        expect(resolvePluginRoot("just a command", "/x")).toBe("just a command");
    });
});

// ── matchesTool ───────────────────────────────────────────────────────────────

describe("matchesTool", () => {
    test("matches exact tool name", () => {
        expect(matchesTool("Edit", "Edit")).toBe(true);
        expect(matchesTool("Write", "Edit")).toBe(false);
    });

    test("matches OR patterns", () => {
        expect(matchesTool("Edit|Write|MultiEdit", "Edit")).toBe(true);
        expect(matchesTool("Edit|Write|MultiEdit", "Write")).toBe(true);
        expect(matchesTool("Edit|Write|MultiEdit", "Bash")).toBe(false);
    });

    test("maps Claude tool names to pi tool names", () => {
        expect(matchesTool("Read", "read")).toBe(true);
        expect(matchesTool("Write", "write")).toBe(true);
        expect(matchesTool("Edit", "edit")).toBe(true);
        expect(matchesTool("Bash", "bash")).toBe(true);
        expect(matchesTool("Glob", "find")).toBe(true);
        expect(matchesTool("Grep", "grep")).toBe(true);
    });

    test("matches Bash(prefix:*) patterns", () => {
        expect(matchesTool("Bash(git add:*)", "bash", { command: "git add -A" })).toBe(true);
        expect(matchesTool("Bash(git add:*)", "bash", { command: "git commit -m 'test'" })).toBe(false);
        expect(matchesTool("Bash(git:*)", "bash", { command: "git status" })).toBe(true);
    });

    test("matches all when matcher is undefined", () => {
        expect(matchesTool(undefined, "anything")).toBe(true);
    });

    test("treats wildcard patterns as match-all", () => {
        expect(matchesTool(".*", "edit")).toBe(true);
        expect(matchesTool(".*", "bash")).toBe(true);
        expect(matchesTool("*", "write")).toBe(true);
        expect(matchesTool(".+", "read")).toBe(true);
        // With surrounding whitespace
        expect(matchesTool(" .* ", "anything")).toBe(true);
    });

    test("handles compound OR with Bash prefix", () => {
        expect(matchesTool("Bash(git add:*)|Bash(git commit:*)", "bash", { command: "git commit -m 'x'" })).toBe(true);
        expect(matchesTool("Bash(git add:*)|Bash(git commit:*)", "bash", { command: "git push" })).toBe(false);
    });

    test("rejects non-string matchers (returns false to avoid match-all)", () => {
        // Malformed plugin configs may pass numbers, booleans, objects, etc.
        // These should NOT match any tool — returning true would cause hooks
        // to fire on every tool call unexpectedly.
        expect(matchesTool(123 as any, "edit")).toBe(false);
        expect(matchesTool(true as any, "bash")).toBe(false);
        expect(matchesTool({} as any, "write")).toBe(false);
        // null/undefined is intentionally match-all (means "no matcher specified")
        expect(matchesTool(null as any, "read")).toBe(true);
        expect(matchesTool(undefined, "read")).toBe(true);
    });
});

// ── mapHookEventToPi ──────────────────────────────────────────────────────────

describe("mapHookEventToPi", () => {
    test("maps supported events", () => {
        expect(mapHookEventToPi("PreToolUse")).toBe("tool_call");
        expect(mapHookEventToPi("PostToolUse")).toBe("tool_result");
        expect(mapHookEventToPi("PostToolUseFailure")).toBe("tool_result");
        expect(mapHookEventToPi("UserPromptSubmit")).toBe("input");
        expect(mapHookEventToPi("Stop")).toBe("agent_end");
        expect(mapHookEventToPi("SessionStart")).toBe("session_start");
        expect(mapHookEventToPi("SessionEnd")).toBe("session_shutdown");
        expect(mapHookEventToPi("PreCompact")).toBe("session_before_compact");
    });

    test("returns null for unmappable events", () => {
        expect(mapHookEventToPi("PermissionRequest")).toBeNull();
        expect(mapHookEventToPi("Notification")).toBeNull();
        expect(mapHookEventToPi("SubagentStart")).toBeNull();
        expect(mapHookEventToPi("TeammateIdle")).toBeNull();
        expect(mapHookEventToPi("TaskCompleted")).toBeNull();
        expect(mapHookEventToPi("WorktreeCreate")).toBeNull();
    });
});

// ── parseManifest ─────────────────────────────────────────────────────────────

describe("parseManifest", () => {
    test("parses a full plugin.json", () => {
        const dir = createPlugin("manifest-test", {
            manifest: {
                name: "my-plugin",
                description: "A test plugin",
                version: "1.0.0",
                author: { name: "Test Author" },
                license: "MIT",
                keywords: ["test"],
            },
        });

        const manifest = parseManifest(dir);
        expect(manifest.name).toBe("my-plugin");
        expect(manifest.description).toBe("A test plugin");
        expect(manifest.version).toBe("1.0.0");
        expect(manifest.license).toBe("MIT");
    });

    test("handles malformed plugin.json fields gracefully", () => {
        const dir = createPlugin("bad-manifest", {
            manifest: {
                name: 42,         // non-string name → should fallback to dir name
                description: [],  // non-string description → should be undefined
                version: true,    // non-string version → should be undefined
            } as any,
        });
        const manifest = parseManifest(dir);
        expect(manifest.name).toBe("bad-manifest"); // Falls back to dir name
        expect(manifest.description).toBeUndefined();
        expect(manifest.version).toBeUndefined();
    });

    test("synthesizes manifest from directory name when plugin.json is missing", () => {
        const dir = createPlugin("no-manifest", { commands: { test: "# Test" } });
        const manifest = parseManifest(dir);
        expect(manifest.name).toBe("no-manifest");
        expect(manifest.description).toBeUndefined();
    });

    test("reads root plugin.json when .claude-plugin/plugin.json is missing", () => {
        const dir = createPlugin("root-manifest", {
            manifest: {
                name: "root-manifest",
                description: "Plugin with root manifest",
                version: "0.1.0",
            },
            manifestLocation: "root",
            commands: { test: "# Test" },
        });

        const manifest = parseManifest(dir);
        expect(manifest.name).toBe("root-manifest");
        expect(manifest.description).toBe("Plugin with root manifest");
        expect(manifest.version).toBe("0.1.0");
    });

    test("skips oversized manifest files gracefully", () => {
        const dir = createPlugin("huge-manifest", { commands: { test: "# Test" } });
        // Write an oversized manifest (> 2MB)
        mkdirSync(join(dir, ".claude-plugin"), { recursive: true });
        const huge = JSON.stringify({ name: "huge", description: "x".repeat(3 * 1024 * 1024) });
        writeFileSync(join(dir, ".claude-plugin", "plugin.json"), huge);

        const manifest = parseManifest(dir);
        // Should fall back to directory name since the file is too large
        expect(manifest.name).toBe("huge-manifest");
        expect(manifest.description).toBeUndefined();
    });

    test("prefers .claude-plugin/plugin.json over root plugin.json", () => {
        const dir = createPlugin("dual-manifest", {
            manifest: {
                name: "from-claude-plugin",
                description: "Standard location",
            },
            commands: { test: "# Test" },
        });
        // Also add a root plugin.json
        writeFileSync(
            join(dir, "plugin.json"),
            JSON.stringify({ name: "from-root", description: "Root location" }),
        );

        const manifest = parseManifest(dir);
        expect(manifest.name).toBe("from-claude-plugin");
        expect(manifest.description).toBe("Standard location");
    });
});

// ── parseCommands ─────────────────────────────────────────────────────────────

describe("parseCommands", () => {
    test("discovers command markdown files", () => {
        const dir = createPlugin("cmd-test", {
            commands: {
                commit: `---
description: Create a git commit
allowed-tools: [Bash, Read]
---

## Your task
Create a commit.`,
                "push-pr": `---
description: Push and create PR
argument-hint: [branch-name]
---

Push to origin and create PR.`,
            },
        });

        const commands = parseCommands(dir);
        expect(commands).toHaveLength(2);

        const commit = commands.find(c => c.name === "commit");
        expect(commit).toBeDefined();
        expect(commit!.frontmatter.description).toBe("Create a git commit");
        expect(commit!.content).toContain("Create a commit");

        const push = commands.find(c => c.name === "push-pr");
        expect(push).toBeDefined();
        expect(push!.frontmatter["argument-hint"]).toBe("[branch-name]");
    });

    test("returns empty array when no commands/ directory", () => {
        const dir = createPlugin("no-cmds", { manifest: { name: "no-cmds" } });
        expect(parseCommands(dir)).toEqual([]);
    });

    test("skips non-.md files", () => {
        const dir = createPlugin("mixed-cmds", {
            commands: { valid: "# Valid" },
        });
        // Manually add a non-md file
        writeFileSync(join(dir, "commands", "not-a-command.txt"), "nope");
        const commands = parseCommands(dir);
        expect(commands).toHaveLength(1);
        expect(commands[0].name).toBe("valid");
    });

    test("discovers commands in subdirectories recursively", () => {
        const dir = createPlugin("nested-cmds", {
            commands: {
                "top-level": "# Top level command",
                "pm/epic-start": `---\ndescription: Start an epic\n---\nStart the epic.`,
                "pm/epic-list": "# List epics",
                "testing/run": "# Run tests",
            },
        });

        const commands = parseCommands(dir);
        expect(commands).toHaveLength(4);

        const names = commands.map(c => c.name).sort();
        expect(names).toEqual(["pm/epic-list", "pm/epic-start", "testing/run", "top-level"]);

        const epicStart = commands.find(c => c.name === "pm/epic-start");
        expect(epicStart).toBeDefined();
        expect(epicStart!.frontmatter.description).toBe("Start an epic");
        expect(epicStart!.content).toContain("Start the epic.");
    });

    test("handles deeply nested command directories", () => {
        const dir = createPlugin("deep-cmds", {
            commands: {
                "a/b/c/deep": "# Deeply nested",
            },
        });

        const commands = parseCommands(dir);
        expect(commands).toHaveLength(1);
        expect(commands[0].name).toBe("a/b/c/deep");
    });
});

// ── parseHooks ────────────────────────────────────────────────────────────────

describe("parseHooks", () => {
    test("parses hooks.json with multiple events", () => {
        const dir = createPlugin("hook-test", {
            hooks: {
                description: "Test hooks",
                hooks: {
                    PreToolUse: [
                        {
                            matcher: "Edit|Write",
                            hooks: [
                                { type: "command", command: "python3 ${CLAUDE_PLUGIN_ROOT}/hooks/check.py" },
                            ],
                        },
                    ],
                    SessionStart: [
                        {
                            hooks: [
                                { type: "command", command: "${CLAUDE_PLUGIN_ROOT}/hooks/init.sh" },
                            ],
                        },
                    ],
                },
            },
        });

        const hooks = parseHooks(dir);
        expect(hooks).not.toBeNull();
        expect(hooks!.description).toBe("Test hooks");
        expect(hooks!.hooks.PreToolUse).toHaveLength(1);
        expect(hooks!.hooks.PreToolUse![0].matcher).toBe("Edit|Write");
        expect(hooks!.hooks.PreToolUse![0].hooks[0].command).toContain("check.py");
        expect(hooks!.hooks.SessionStart).toHaveLength(1);
    });

    test("returns null when no hooks/ directory", () => {
        const dir = createPlugin("no-hooks", { manifest: { name: "no-hooks" } });
        expect(parseHooks(dir)).toBeNull();
    });

    test("handles malformed hooks gracefully", () => {
        const dir = createPlugin("bad-hooks", { manifest: { name: "bad-hooks" } });
        mkdirSync(join(dir, "hooks"), { recursive: true });

        // Hooks with non-array groups, missing hooks array, garbage values
        writeFileSync(join(dir, "hooks", "hooks.json"), JSON.stringify({
            hooks: {
                PreToolUse: "not-an-array",
                PostToolUse: [
                    { matcher: "Edit", hooks: "also-not-an-array" },
                    null,
                    { matcher: "Write", hooks: [{ type: "command", command: "ok.sh" }] },
                ],
                Stop: [{ hooks: [{ type: "command", command: "stop.sh" }] }],
            },
        }));

        const hooks = parseHooks(dir);
        expect(hooks).not.toBeNull();
        // PreToolUse should be skipped (not an array)
        expect(hooks!.hooks.PreToolUse).toBeUndefined();
        // PostToolUse: only the valid group should survive
        expect(hooks!.hooks.PostToolUse).toHaveLength(1);
        expect(hooks!.hooks.PostToolUse![0].hooks[0].command).toBe("ok.sh");
        // Stop should be fine
        expect(hooks!.hooks.Stop).toHaveLength(1);
    });

    test("rejects hook groups with non-string matcher", () => {
        const dir = createPlugin("bad-matcher-hooks", { manifest: { name: "bad-matcher" } });
        mkdirSync(join(dir, "hooks"), { recursive: true });
        writeFileSync(join(dir, "hooks", "hooks.json"), JSON.stringify({
            hooks: {
                PreToolUse: [
                    // Invalid: matcher is a number — should be rejected
                    { matcher: 123, hooks: [{ type: "command", command: "bad.sh" }] },
                    // Valid: string matcher
                    { matcher: "Edit", hooks: [{ type: "command", command: "good.sh" }] },
                    // Valid: no matcher (match-all by design)
                    { hooks: [{ type: "command", command: "also-good.sh" }] },
                ],
            },
        }));

        const hooks = parseHooks(dir);
        expect(hooks).not.toBeNull();
        expect(hooks!.hooks.PreToolUse).toHaveLength(2);
        // Only the valid groups should survive
        expect(hooks!.hooks.PreToolUse![0].matcher).toBe("Edit");
        expect(hooks!.hooks.PreToolUse![0].hooks[0].command).toBe("good.sh");
        expect(hooks!.hooks.PreToolUse![1].matcher).toBeUndefined();
        expect(hooks!.hooks.PreToolUse![1].hooks[0].command).toBe("also-good.sh");
    });

    test("merges multiple JSON files in hooks/", () => {
        const dir = createPlugin("multi-hooks", { manifest: { name: "multi-hooks" } });
        mkdirSync(join(dir, "hooks"), { recursive: true });
        writeFileSync(join(dir, "hooks", "hooks.json"), JSON.stringify({
            hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "a.sh" }] }] },
        }));
        writeFileSync(join(dir, "hooks", "extra.json"), JSON.stringify({
            hooks: { Stop: [{ hooks: [{ type: "command", command: "b.sh" }] }] },
        }));

        const hooks = parseHooks(dir);
        expect(hooks).not.toBeNull();
        expect(hooks!.hooks.PreToolUse).toHaveLength(1);
        expect(hooks!.hooks.Stop).toHaveLength(1);
    });
});

// ── parsePluginSkills ─────────────────────────────────────────────────────────

describe("parsePluginSkills", () => {
    test("discovers SKILL.md directories", () => {
        const dir = createPlugin("skill-test", {
            skills: ["code-reviewer", "pdf-processor"],
        });

        const skills = parsePluginSkills(dir);
        expect(skills).toHaveLength(2);
        expect(skills.map(s => s.name).sort()).toEqual(["code-reviewer", "pdf-processor"]);
    });

    test("returns empty array when no skills/ directory", () => {
        const dir = createPlugin("no-skills", { manifest: { name: "no-skills" } });
        expect(parsePluginSkills(dir)).toEqual([]);
    });
});

// ── parseRules ────────────────────────────────────────────────────────────────

describe("parseRules", () => {
    test("discovers rule markdown files", () => {
        const dir = createPlugin("rule-test", {
            rules: {
                "beads-operations": "# Beads Operations\n\nStandard patterns for Beads.",
                "branch-operations": "# Branch Operations\n\nGit branch rules.",
            },
        });

        const rules = parseRules(dir);
        expect(rules).toHaveLength(2);

        const names = rules.map(r => r.name).sort();
        expect(names).toEqual(["beads-operations", "branch-operations"]);

        const beads = rules.find(r => r.name === "beads-operations");
        expect(beads).toBeDefined();
        expect(beads!.content).toContain("Standard patterns for Beads");
    });

    test("returns empty array when no rules/ directory", () => {
        const dir = createPlugin("no-rules", { manifest: { name: "no-rules" } });
        expect(parseRules(dir)).toEqual([]);
    });

    test("skips non-.md files", () => {
        const dir = createPlugin("mixed-rules", {
            rules: { valid: "# Valid rule" },
        });
        writeFileSync(join(dir, "rules", "not-a-rule.txt"), "nope");
        const rules = parseRules(dir);
        expect(rules).toHaveLength(1);
        expect(rules[0].name).toBe("valid");
    });
});

// ── isPluginDir ───────────────────────────────────────────────────────────────

describe("isPluginDir", () => {
    test("detects plugin with manifest", () => {
        const dir = createPlugin("has-manifest", { manifest: { name: "x" } });
        expect(isPluginDir(dir)).toBe(true);
    });

    test("detects plugin with commands/ only", () => {
        const dir = createPlugin("has-cmds", { commands: { test: "# Test" } });
        expect(isPluginDir(dir)).toBe(true);
    });

    test("detects plugin with hooks/ only", () => {
        const dir = createPlugin("has-hooks", {
            hooks: { hooks: { Stop: [{ hooks: [{ type: "command", command: "x" }] }] } },
        });
        expect(isPluginDir(dir)).toBe(true);
    });

    test("detects plugin with root plugin.json", () => {
        const dir = createPlugin("has-root-manifest", {
            manifest: { name: "x" },
            manifestLocation: "root",
        });
        expect(isPluginDir(dir)).toBe(true);
    });

    test("detects plugin with rules/ only", () => {
        const dir = createPlugin("has-rules", {
            rules: { "my-rule": "# A rule" },
        });
        expect(isPluginDir(dir)).toBe(true);
    });

    test("detects skills-only directories as plugins", () => {
        const dir = createPlugin("skills-only", { skills: ["my-skill"] });
        // Skills-only dirs need to be discovered so their SKILL.md entries
        // are added to pi via getPluginSkillPaths().
        expect(isPluginDir(dir)).toBe(true);
    });
});

// ── parsePlugin (full parse) ──────────────────────────────────────────────────

describe("parsePlugin", () => {
    test("parses a complete plugin", () => {
        const dir = createPlugin("full-plugin", {
            manifest: {
                name: "full-plugin",
                description: "A complete test plugin",
                author: { name: "Test" },
            },
            commands: {
                review: `---\ndescription: Review code\n---\nReview the code.`,
                deploy: `---\ndescription: Deploy\nargument-hint: [env]\n---\nDeploy to $ARGUMENTS.`,
                "pm/status": `---\ndescription: Show PM status\n---\nShow status.`,
            },
            hooks: {
                description: "Safety hooks",
                hooks: {
                    PreToolUse: [{
                        matcher: "Bash",
                        hooks: [{ type: "command", command: "check.sh", timeout: 5 }],
                    }],
                },
            },
            skills: ["code-review"],
            rules: {
                "git-ops": "# Git Operations\n\nAlways use feature branches.",
            },
            mcp: true,
            agents: true,
        });

        const plugin = parsePlugin(dir);
        expect(plugin.name).toBe("full-plugin");
        expect(plugin.description).toBe("A complete test plugin");
        expect(plugin.commands).toHaveLength(3);
        expect(plugin.commands.find(c => c.name === "pm/status")).toBeDefined();
        expect(plugin.hooks).not.toBeNull();
        expect(plugin.hooks!.hooks.PreToolUse).toHaveLength(1);
        expect(plugin.skills).toHaveLength(1);
        expect(plugin.rules).toHaveLength(1);
        expect(plugin.rules[0].name).toBe("git-ops");
        expect(plugin.hasMcp).toBe(true);
        expect(plugin.hasAgents).toBe(true);
        expect(plugin.hasLsp).toBe(false);
    });
});

// ── scanPluginsDir ────────────────────────────────────────────────────────────

describe("scanPluginsDir", () => {
    test("discovers multiple plugins in a directory", () => {
        const scanDir = join(fixtureDir, "scan-test");
        mkdirSync(scanDir, { recursive: true });

        // Create two plugins inside scanDir
        const p1 = join(scanDir, "plugin-a");
        mkdirSync(join(p1, ".claude-plugin"), { recursive: true });
        writeFileSync(join(p1, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "plugin-a", description: "A" }));
        mkdirSync(join(p1, "commands"), { recursive: true });
        writeFileSync(join(p1, "commands", "hello.md"), "---\ndescription: Hello\n---\nHello!");

        const p2 = join(scanDir, "plugin-b");
        mkdirSync(join(p2, "commands"), { recursive: true });
        writeFileSync(join(p2, "commands", "world.md"), "# World");

        const plugins = scanPluginsDir(scanDir);
        expect(plugins).toHaveLength(2);
        expect(plugins.map(p => p.name).sort()).toEqual(["plugin-a", "plugin-b"]);
    });

    test("skips hidden directories", () => {
        const scanDir = join(fixtureDir, "skip-hidden");
        mkdirSync(scanDir, { recursive: true });

        const hidden = join(scanDir, ".hidden-plugin");
        mkdirSync(join(hidden, "commands"), { recursive: true });
        writeFileSync(join(hidden, "commands", "test.md"), "# Test");

        const plugins = scanPluginsDir(scanDir);
        expect(plugins).toHaveLength(0);
    });

    test("returns empty for nonexistent directory", () => {
        const missingDir = join(fixtureDir, "definitely-does-not-exist-" + Date.now());
        expect(scanPluginsDir(missingDir)).toEqual([]);
    });

    test("a malformed plugin does not break discovery of other plugins", () => {
        const scanDir = join(fixtureDir, "malformed-test");
        mkdirSync(scanDir, { recursive: true });

        // Create a good plugin
        const goodDir = join(scanDir, "good-plugin");
        mkdirSync(join(goodDir, "commands"), { recursive: true });
        writeFileSync(join(goodDir, "commands", "hello.md"), "---\ndescription: Hello\n---\nHi", "utf-8");

        // Create a broken plugin with invalid JSON manifest
        const brokenDir = join(scanDir, "broken-plugin");
        mkdirSync(join(brokenDir, "commands"), { recursive: true });
        writeFileSync(join(brokenDir, "plugin.json"), "NOT VALID JSON {{{", "utf-8");
        writeFileSync(join(brokenDir, "commands", "cmd.md"), "---\ndescription: Cmd\n---\nBody", "utf-8");

        const plugins = scanPluginsDir(scanDir);
        // Both should load — broken JSON is caught per-file, plugin still parses
        const good = plugins.find(p => p.name === "good-plugin");
        expect(good).toBeDefined();
        expect(good!.commands).toHaveLength(1);
    });
});

// ── toPluginInfo ──────────────────────────────────────────────────────────────

describe("toPluginInfo", () => {
    test("converts DiscoveredPlugin to lightweight PluginInfo", () => {
        const dir = createPlugin("info-test", {
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
            rules: { "my-rule": "# Rule content" },
            mcp: true,
        });

        const plugin = parsePlugin(dir);
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
        expect(info.rules[0].name).toBe("my-rule");
        expect(info.hasMcp).toBe(true);
    });
});

// ── Security: global vs project-local dirs ────────────────────────────────────

describe("pluginSearchDirs security", () => {
    test("default search dirs do NOT include project-local dirs", () => {
        const dirs = pluginSearchDirs("/some/project");
        const projectLocal = projectPluginDirs("/some/project");
        for (const local of projectLocal) {
            expect(dirs).not.toContain(local);
        }
    });

    test("includeProjectLocal adds project dirs", () => {
        const dirs = pluginSearchDirs("/some/project", { includeProjectLocal: true });
        const projectLocal = projectPluginDirs("/some/project");
        for (const local of projectLocal) {
            expect(dirs).toContain(local);
        }
    });

    test("global dirs are always included", () => {
        const dirs = pluginSearchDirs("/some/project");
        const globals = globalPluginDirs();
        for (const g of globals) {
            expect(dirs).toContain(g);
        }
    });

    test("extraDirs are included", () => {
        const dirs = pluginSearchDirs("/some/project", { extraDirs: ["/custom/path"] });
        expect(dirs).toContain("/custom/path");
    });

    test("discoverPlugins without includeProjectLocal skips local dirs", () => {
        // Sandbox HOME so global dirs point to an empty temp dir
        // (avoids test results depending on real machine state)
        const realHome = process.env.HOME;
        const fakeHome = join(fixtureDir, "fake-home-security");
        mkdirSync(fakeHome, { recursive: true });
        process.env.HOME = fakeHome;

        try {
            // Create a plugin only in a project-local dir
            const projectDir = join(fixtureDir, "project-security");
            const localPluginDir = join(projectDir, ".pizzapi", "plugins", "sneaky");
            mkdirSync(join(localPluginDir, "commands"), { recursive: true });
            writeFileSync(join(localPluginDir, "commands", "evil.md"), "# Evil command");

            // Discovery without includeProjectLocal should NOT find it
            const plugins = discoverPlugins(projectDir);
            expect(plugins.find(p => p.name === "sneaky")).toBeUndefined();

            // Discovery WITH includeProjectLocal SHOULD find it
            const withLocal = discoverPlugins(projectDir, { includeProjectLocal: true });
            expect(withLocal.find(p => p.name === "sneaky")).toBeDefined();
        } finally {
            process.env.HOME = realHome;
        }
    });
});

// ── Claude Code installed_plugins.json discovery ──────────────────────────────

describe("discoverClaudeInstalledPlugins", () => {
    let tmpDir: string;
    let realHome: string;

    beforeAll(() => {
        tmpDir = mkdtempSync(join(tmpdir(), "claude-installed-plugins-"));
        realHome = process.env.HOME!;
    });

    afterAll(() => {
        process.env.HOME = realHome;
        try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    });

    function setupHome(name: string): string {
        const home = join(tmpDir, name);
        mkdirSync(join(home, ".claude", "plugins"), { recursive: true });
        process.env.HOME = home;
        return home;
    }

    function writeInstalledPlugins(home: string, data: unknown): void {
        writeFileSync(
            join(home, ".claude", "plugins", "installed_plugins.json"),
            JSON.stringify(data, null, 2),
        );
    }

    function createCachedPlugin(home: string, marketplace: string, name: string, version: string): string {
        const dir = join(home, ".claude", "plugins", "cache", marketplace, name, version);
        mkdirSync(join(dir, ".claude-plugin"), { recursive: true });
        writeFileSync(
            join(dir, ".claude-plugin", "plugin.json"),
            JSON.stringify({ name, description: `Test plugin ${name}`, version }),
        );
        mkdirSync(join(dir, "commands"), { recursive: true });
        writeFileSync(join(dir, "commands", "hello.md"), `---\ndescription: Hello from ${name}\n---\n# Hello`);
        return dir;
    }

    test("returns empty array when installed_plugins.json does not exist", () => {
        const home = setupHome("no-file");
        const result = discoverClaudeInstalledPlugins("/tmp");
        expect(result).toEqual([]);
    });

    test("returns empty array for malformed JSON", () => {
        const home = setupHome("bad-json");
        writeFileSync(join(home, ".claude", "plugins", "installed_plugins.json"), "not json{{{");
        const result = discoverClaudeInstalledPlugins("/tmp");
        expect(result).toEqual([]);
    });

    test("returns empty array when plugins field is missing", () => {
        const home = setupHome("no-plugins");
        writeInstalledPlugins(home, { version: 2 });
        const result = discoverClaudeInstalledPlugins("/tmp");
        expect(result).toEqual([]);
    });

    test("discovers plugins from valid installed_plugins.json", () => {
        const home = setupHome("valid");
        const installPath = createCachedPlugin(home, "my-marketplace", "cool-plugin", "1.0.0");
        writeInstalledPlugins(home, {
            version: 2,
            plugins: {
                "cool-plugin@my-marketplace": [{
                    scope: "user",
                    installPath,
                    version: "1.0.0",
                    installedAt: "2026-01-15T00:00:00Z",
                    lastUpdated: "2026-01-15T00:00:00Z",
                }],
            },
        });

        const result = discoverClaudeInstalledPlugins("/tmp");
        expect(result).toHaveLength(1);
        expect(result[0].name).toBe("cool-plugin");
        expect(result[0].commands).toHaveLength(1);
    });

    test("skips plugins whose installPath does not exist", () => {
        const home = setupHome("missing-path");
        writeInstalledPlugins(home, {
            version: 2,
            plugins: {
                "ghost@marketplace": [{
                    scope: "user",
                    installPath: join(home, ".claude", "plugins", "cache", "marketplace", "ghost", "1.0.0"),
                    version: "1.0.0",
                }],
            },
        });

        const result = discoverClaudeInstalledPlugins("/tmp");
        expect(result).toEqual([]);
    });

    test("discovers multiple plugins from different marketplaces", () => {
        const home = setupHome("multi");
        const path1 = createCachedPlugin(home, "mkt-a", "plugin-a", "1.0.0");
        const path2 = createCachedPlugin(home, "mkt-b", "plugin-b", "2.0.0");
        writeInstalledPlugins(home, {
            version: 2,
            plugins: {
                "plugin-a@mkt-a": [{ scope: "user", installPath: path1, version: "1.0.0" }],
                "plugin-b@mkt-b": [{ scope: "user", installPath: path2, version: "2.0.0" }],
            },
        });

        const result = discoverClaudeInstalledPlugins("/tmp");
        expect(result).toHaveLength(2);
        const names = result.map(p => p.name).sort();
        expect(names).toEqual(["plugin-a", "plugin-b"]);
    });

    test("skips project-scoped plugins that don't match cwd", () => {
        const home = setupHome("project-scope");
        const path1 = createCachedPlugin(home, "mkt", "project-plugin", "1.0.0");
        writeInstalledPlugins(home, {
            version: 2,
            plugins: {
                "project-plugin@mkt": [{
                    scope: "project",
                    projectPath: "/some/other/project",
                    installPath: path1,
                    version: "1.0.0",
                }],
            },
        });

        // cwd doesn't match projectPath — should be skipped
        const result = discoverClaudeInstalledPlugins("/Users/me/my-project");
        expect(result).toEqual([]);
    });

    test("includes project-scoped plugins that match cwd", () => {
        const home = setupHome("project-match");
        const path1 = createCachedPlugin(home, "mkt", "my-project-plugin", "1.0.0");
        const projectDir = join(tmpDir, "my-real-project");
        mkdirSync(projectDir, { recursive: true });
        writeInstalledPlugins(home, {
            version: 2,
            plugins: {
                "my-project-plugin@mkt": [{
                    scope: "project",
                    projectPath: projectDir,
                    installPath: path1,
                    version: "1.0.0",
                }],
            },
        });

        const result = discoverClaudeInstalledPlugins(projectDir);
        expect(result).toHaveLength(1);
        expect(result[0].name).toBe("my-project-plugin");
    });

    test("prefers most recently updated installation", () => {
        const home = setupHome("prefer-newest");
        const oldPath = createCachedPlugin(home, "mkt", "evolving", "1.0.0");
        const newPath = createCachedPlugin(home, "mkt", "evolving", "2.0.0");
        // Overwrite the manifest to distinguish versions
        writeFileSync(
            join(newPath, ".claude-plugin", "plugin.json"),
            JSON.stringify({ name: "evolving", description: "v2", version: "2.0.0" }),
        );
        writeInstalledPlugins(home, {
            version: 2,
            plugins: {
                "evolving@mkt": [
                    { scope: "user", installPath: oldPath, version: "1.0.0", lastUpdated: "2026-01-01T00:00:00Z" },
                    { scope: "user", installPath: newPath, version: "2.0.0", lastUpdated: "2026-06-01T00:00:00Z" },
                ],
            },
        });

        const result = discoverClaudeInstalledPlugins("/tmp");
        expect(result).toHaveLength(1);
        expect(result[0].description).toBe("v2");
    });

    test("falls back to older installation when newest is not a valid plugin dir", () => {
        const home = setupHome("fallback");
        // Create a valid v1 plugin
        const oldPath = createCachedPlugin(home, "mkt", "flaky", "1.0.0");
        // Create a v2 directory that exists but isn't a valid plugin dir
        // (no commands/, hooks/, rules/, skills/, or plugin.json)
        const newPath = join(home, ".claude", "plugins", "cache", "mkt", "flaky", "2.0.0");
        mkdirSync(newPath, { recursive: true });
        writeFileSync(join(newPath, "README.md"), "This is not a plugin");

        writeInstalledPlugins(home, {
            version: 2,
            plugins: {
                "flaky@mkt": [
                    { scope: "user", installPath: newPath, version: "2.0.0", lastUpdated: "2026-06-01T00:00:00Z" },
                    { scope: "user", installPath: oldPath, version: "1.0.0", lastUpdated: "2026-01-01T00:00:00Z" },
                ],
            },
        });

        const result = discoverClaudeInstalledPlugins("/tmp");
        expect(result).toHaveLength(1);
        expect(result[0].name).toBe("flaky");
    });

    test("rejects project-scoped plugin when relative path is absolute (cross-drive)", () => {
        // Simulate cross-drive: projectPath and cwd share no common root.
        // On POSIX, relative("/a", "/b") returns "../b" (starts with "..").
        // On Windows cross-drive, relative("C:\\proj", "D:\\work") returns "D:\\work" (absolute).
        // Both cases should be rejected.
        const home = setupHome("cross-drive");
        const path1 = createCachedPlugin(home, "mkt", "cross-drive-plugin", "1.0.0");
        writeInstalledPlugins(home, {
            version: 2,
            plugins: {
                "cross-drive-plugin@mkt": [{
                    scope: "project",
                    projectPath: "/completely/different/root",
                    installPath: path1,
                    version: "1.0.0",
                }],
            },
        });

        const result = discoverClaudeInstalledPlugins("/some/other/place");
        expect(result).toEqual([]);
    });

    test("globalPluginDirs does NOT include ~/.claude/plugins", () => {
        const home = setupHome("dirs-check");
        const dirs = globalPluginDirs();
        const claudePluginsDir = join(home, ".claude", "plugins");
        expect(dirs).not.toContain(claudePluginsDir);
        // Should include pizzapi and agents
        expect(dirs.some(d => d.includes(".pizzapi"))).toBe(true);
        expect(dirs.some(d => d.includes(".agents"))).toBe(true);
    });
});
