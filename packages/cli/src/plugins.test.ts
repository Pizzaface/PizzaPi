/**
 * Tests for Claude Code Plugin adapter — pure parsing/selection logic +
 * two filesystem smoke tests.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
    parseMarkdownFrontmatter,
    parseManifest,
    parsePlugin,
    discoverClaudeInstalledPlugins,
    pluginSearchDirs,
    globalPluginDirs,
    projectPluginDirs,
    resolvePluginRoot,
    matchesTool,
    mapHookEventToPi,
} from "./plugins.js";

// ── Shared fixture helpers ────────────────────────────────────────────────────

let fixtureDir: string;

beforeAll(() => {
    fixtureDir = mkdtempSync(join(tmpdir(), "pizzapi-plugins-test-"));
});

afterAll(() => {
    try { rmSync(fixtureDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

function createPlugin(name: string, opts: {
    manifest?: Record<string, unknown>;
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
            writeFileSync(join(skillDir, "SKILL.md"), `---\nname: ${skillName}\ndescription: Test skill ${skillName}\n---\n# ${skillName}\n`);
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

// ── parseMarkdownFrontmatter (pure) ──────────────────────────────────────────

describe("parseMarkdownFrontmatter", () => {
    test("parses basic frontmatter", () => {
        const content = `---\ndescription: A test command\nargument-hint: <arg>\n---\n\n# Body content here`;
        const { frontmatter, body } = parseMarkdownFrontmatter(content);
        expect(frontmatter.description).toBe("A test command");
        expect(frontmatter["argument-hint"]).toBe("<arg>");
        expect(body).toContain("# Body content here");
    });

    test("handles quoted values", () => {
        const content = `---\ndescription: "A quoted description"\nname: 'single-quoted'\n---\nBody`;
        const { frontmatter } = parseMarkdownFrontmatter(content);
        expect(frontmatter.description).toBe("A quoted description");
        expect(frontmatter.name).toBe("single-quoted");
    });

    test("parses JSON array values", () => {
        const { frontmatter } = parseMarkdownFrontmatter(`---\nallowed-tools: ["Read", "Bash", "Write"]\n---\nBody`);
        expect(frontmatter["allowed-tools"]).toEqual(["Read", "Bash", "Write"]);
    });

    test("parses unquoted array values", () => {
        const { frontmatter } = parseMarkdownFrontmatter(`---\nallowed-tools: [Read, Bash, Write]\n---\nBody`);
        expect(frontmatter["allowed-tools"]).toEqual(["Read", "Bash", "Write"]);
    });

    test("parses boolean values", () => {
        const { frontmatter } = parseMarkdownFrontmatter(`---\ndisable-model-invocation: true\nsome-flag: false\n---\nBody`);
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
        const { frontmatter } = parseMarkdownFrontmatter(`---\nname: test\nThis never closes`);
        expect(frontmatter).toEqual({});
    });
});

// ── resolvePluginRoot (pure) ──────────────────────────────────────────────────

describe("resolvePluginRoot", () => {
    test("replaces ${CLAUDE_PLUGIN_ROOT} placeholders", () => {
        expect(resolvePluginRoot("${CLAUDE_PLUGIN_ROOT}/scripts/run.sh", "/home/user/my-plugin"))
            .toBe("/home/user/my-plugin/scripts/run.sh");
    });

    test("replaces multiple occurrences", () => {
        expect(resolvePluginRoot("${CLAUDE_PLUGIN_ROOT}/a && ${CLAUDE_PLUGIN_ROOT}/b", "/plugin"))
            .toBe("/plugin/a && /plugin/b");
    });

    test("no-ops when no placeholders present", () => {
        expect(resolvePluginRoot("just a command", "/x")).toBe("just a command");
    });
});

// ── matchesTool (pure) ────────────────────────────────────────────────────────

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

    test("matches all when matcher is undefined or null", () => {
        expect(matchesTool(undefined, "anything")).toBe(true);
        expect(matchesTool(null as any, "read")).toBe(true);
    });

    test("treats wildcard patterns as match-all", () => {
        expect(matchesTool(".*", "edit")).toBe(true);
        expect(matchesTool("*", "write")).toBe(true);
        expect(matchesTool(".+", "read")).toBe(true);
        expect(matchesTool(" .* ", "anything")).toBe(true);
    });

    test("handles compound OR with Bash prefix", () => {
        expect(matchesTool("Bash(git add:*)|Bash(git commit:*)", "bash", { command: "git commit -m 'x'" })).toBe(true);
        expect(matchesTool("Bash(git add:*)|Bash(git commit:*)", "bash", { command: "git push" })).toBe(false);
    });

    test("rejects non-string matchers (prevents accidental match-all)", () => {
        expect(matchesTool(123 as any, "edit")).toBe(false);
        expect(matchesTool(true as any, "bash")).toBe(false);
        expect(matchesTool({} as any, "write")).toBe(false);
    });
});

// ── mapHookEventToPi (pure) ───────────────────────────────────────────────────

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
        expect(mapHookEventToPi("TaskCompleted")).toBeNull();
    });
});

// ── Filesystem smoke tests ────────────────────────────────────────────────────

describe("parsePlugin smoke test", () => {
    test("parses a full plugin with commands, hooks, skills, rules, mcp, agents", () => {
        const dir = createPlugin("full-plugin-smoke", {
            manifest: { name: "full-plugin-smoke", description: "Smoke test plugin", author: { name: "Test" } },
            commands: {
                review: `---\ndescription: Review code\n---\nReview the code.`,
                "pm/status": `---\ndescription: Show PM status\n---\nShow status.`,
            },
            hooks: {
                description: "Safety hooks",
                hooks: {
                    PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "check.sh" }] }],
                },
            },
            skills: ["code-review"],
            rules: { "git-ops": "# Git Operations\n\nAlways use feature branches." },
            mcp: true,
            agents: true,
        });

        const plugin = parsePlugin(dir);
        expect(plugin.name).toBe("full-plugin-smoke");
        expect(plugin.description).toBe("Smoke test plugin");
        expect(plugin.commands).toHaveLength(2);
        expect(plugin.commands.find(c => c.name === "pm/status")).toBeDefined();
        expect(plugin.hooks).not.toBeNull();
        expect(plugin.hooks!.hooks.PreToolUse).toHaveLength(1);
        expect(plugin.skills).toHaveLength(1);
        expect(plugin.rules).toHaveLength(1);
        expect(plugin.rules[0].name).toBe("git-ops");
        expect(plugin.hasMcp).toBe(true);
        expect(plugin.hasAgents).toBe(true);
    });
});

describe("discoverClaudeInstalledPlugins smoke test", () => {
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

    test("discovers plugins from valid installed_plugins.json and respects disabled entries", () => {
        const home = join(tmpDir, "smoke-home");
        mkdirSync(join(home, ".claude", "plugins"), { recursive: true });
        process.env.HOME = home;

        // Create two cached plugins
        for (const [name, version] of [["plugin-a", "1.0.0"], ["plugin-b", "1.0.0"]] as const) {
            const dir = join(home, ".claude", "plugins", "cache", "mkt", name, version);
            mkdirSync(join(dir, ".claude-plugin"), { recursive: true });
            writeFileSync(join(dir, ".claude-plugin", "plugin.json"), JSON.stringify({ name, description: `Test ${name}`, version }));
            mkdirSync(join(dir, "commands"), { recursive: true });
            writeFileSync(join(dir, "commands", "hello.md"), `---\ndescription: Hello from ${name}\n---\n# Hello`);
        }

        const pluginAPath = join(home, ".claude", "plugins", "cache", "mkt", "plugin-a", "1.0.0");
        const pluginBPath = join(home, ".claude", "plugins", "cache", "mkt", "plugin-b", "1.0.0");

        writeFileSync(
            join(home, ".claude", "plugins", "installed_plugins.json"),
            JSON.stringify({
                version: 2,
                plugins: {
                    "plugin-a@mkt": [{ scope: "user", installPath: pluginAPath, version: "1.0.0" }],
                    "plugin-b@mkt": [{ scope: "user", installPath: pluginBPath, version: "1.0.0" }],
                },
            }),
        );

        // Disable plugin-b via settings
        writeFileSync(
            join(home, ".claude", "settings.json"),
            JSON.stringify({ enabledPlugins: { "plugin-a@mkt": true, "plugin-b@mkt": false } }),
        );

        const result = discoverClaudeInstalledPlugins("/tmp");
        expect(result).toHaveLength(1);
        expect(result[0].name).toBe("plugin-a");
        expect(result[0].commands).toHaveLength(1);
    });
});

// ── pluginSearchDirs security (pure path logic) ───────────────────────────────

describe("pluginSearchDirs", () => {
    test("global dirs always included, project-local excluded by default", () => {
        const dirs = pluginSearchDirs("/some/project");
        const globals = globalPluginDirs();
        const locals = projectPluginDirs("/some/project");
        for (const g of globals) expect(dirs).toContain(g);
        for (const l of locals) expect(dirs).not.toContain(l);
    });

    test("includeProjectLocal adds project dirs", () => {
        const dirs = pluginSearchDirs("/some/project", { includeProjectLocal: true });
        for (const l of projectPluginDirs("/some/project")) {
            expect(dirs).toContain(l);
        }
    });

    test("extraDirs are included", () => {
        const dirs = pluginSearchDirs("/some/project", { extraDirs: ["/custom/path"] });
        expect(dirs).toContain("/custom/path");
    });
});
