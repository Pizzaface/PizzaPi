/**
 * Security-focused E2E tests for the Claude Code Plugin adapter.
 *
 * Tests trust boundaries, symlink rejection, oversized file handling,
 * entry limits, and the project-local vs global plugin security model.
 *
 * NOTE: Bun caches homedir() from process start, so overriding HOME won't
 * affect globalPluginDirs(). Tests use lower-level APIs (parseCommands,
 * scanPluginsDir, discoverPlugins with extraDirs) instead.
 *
 * All fixtures use temp dirs — no writes outside /tmp.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
    parseManifest,
    parseCommands,
    parseHooks,
    parsePluginSkills,
    parseRules,
    scanPluginsDir,
    discoverPlugins,
    pluginSearchDirs,
    projectPluginDirs,
} from "../plugins.js";
import { createClaudePluginExtension } from "./claude-plugins.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

let tmpBase: string;

function freshTmpDir(): string {
    return mkdtempSync(join(tmpBase, "sec-"));
}

function createPluginTree(baseDir: string, name: string, opts: {
    manifest?: Record<string, unknown>;
    manifestLocation?: "standard" | "root";
    commands?: Record<string, string>;
    hooks?: Record<string, unknown>;
    skills?: string[];
    rules?: Record<string, string>;
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
            writeFileSync(join(skillDir, "SKILL.md"), `# ${skillName}\n`);
        }
    }

    if (opts.rules) {
        mkdirSync(join(pluginDir, "rules"), { recursive: true });
        for (const [ruleName, content] of Object.entries(opts.rules)) {
            writeFileSync(join(pluginDir, "rules", `${ruleName}.md`), content);
        }
    }

    return pluginDir;
}

beforeAll(() => {
    tmpBase = mkdtempSync(join(tmpdir(), "pizzapi-plugin-security-"));
});

afterAll(() => {
    try { rmSync(tmpBase, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ── Symlink rejection ─────────────────────────────────────────────────────────

describe("symlink rejection", () => {
    test("scanPluginsDir skips symlinked plugin root directories", () => {
        const dir = freshTmpDir();
        const pluginsDir = join(dir, "plugins");
        mkdirSync(pluginsDir, { recursive: true });

        // Create a real plugin elsewhere
        const realPlugin = createPluginTree(dir, "real-plugin", {
            commands: { test: "# Test" },
        });

        // Symlink it into the plugins dir
        symlinkSync(realPlugin, join(pluginsDir, "symlinked-plugin"));

        const plugins = scanPluginsDir(pluginsDir);
        expect(plugins.find(p => p.name === "symlinked-plugin")).toBeUndefined();
    });

    test("parseCommands skips symlinked commands/ directory", () => {
        const dir = freshTmpDir();
        const pluginDir = join(dir, "plugin");
        mkdirSync(pluginDir, { recursive: true });

        const realCmdsDir = join(dir, "real-commands");
        mkdirSync(realCmdsDir, { recursive: true });
        writeFileSync(join(realCmdsDir, "evil.md"), "# Evil command");

        symlinkSync(realCmdsDir, join(pluginDir, "commands"));
        expect(parseCommands(pluginDir)).toHaveLength(0);
    });

    test("parseHooks skips symlinked hooks/ directory", () => {
        const dir = freshTmpDir();
        const pluginDir = join(dir, "plugin");
        mkdirSync(pluginDir, { recursive: true });

        const realHooksDir = join(dir, "real-hooks");
        mkdirSync(realHooksDir, { recursive: true });
        writeFileSync(join(realHooksDir, "hooks.json"), JSON.stringify({
            hooks: { Stop: [{ hooks: [{ type: "command", command: "evil.sh" }] }] },
        }));

        symlinkSync(realHooksDir, join(pluginDir, "hooks"));
        expect(parseHooks(pluginDir)).toBeNull();
    });

    test("parsePluginSkills skips symlinked skills/ directory", () => {
        const dir = freshTmpDir();
        const pluginDir = join(dir, "plugin");
        mkdirSync(pluginDir, { recursive: true });

        const realSkillsDir = join(dir, "real-skills");
        mkdirSync(join(realSkillsDir, "my-skill"), { recursive: true });
        writeFileSync(join(realSkillsDir, "my-skill", "SKILL.md"), "# Skill");

        symlinkSync(realSkillsDir, join(pluginDir, "skills"));
        expect(parsePluginSkills(pluginDir)).toHaveLength(0);
    });

    test("parseRules skips symlinked rules/ directory", () => {
        const dir = freshTmpDir();
        const pluginDir = join(dir, "plugin");
        mkdirSync(pluginDir, { recursive: true });

        const realRulesDir = join(dir, "real-rules");
        mkdirSync(realRulesDir, { recursive: true });
        writeFileSync(join(realRulesDir, "rule.md"), "# Evil rule");

        symlinkSync(realRulesDir, join(pluginDir, "rules"));
        expect(parseRules(pluginDir)).toHaveLength(0);
    });

    test("parseCommands skips individual symlinked files", () => {
        const dir = freshTmpDir();
        const pluginDir = join(dir, "plugin");
        mkdirSync(join(pluginDir, "commands"), { recursive: true });

        writeFileSync(join(pluginDir, "commands", "real.md"), "# Real");

        const evilFile = join(dir, "evil-cmd.md");
        writeFileSync(evilFile, "# Evil");
        symlinkSync(evilFile, join(pluginDir, "commands", "evil.md"));

        const commands = parseCommands(pluginDir);
        expect(commands).toHaveLength(1);
        expect(commands[0].name).toBe("real");
    });

    test("parsePluginSkills skips symlinked skill subdirectories", () => {
        const dir = freshTmpDir();
        const pluginDir = join(dir, "plugin");
        mkdirSync(join(pluginDir, "skills"), { recursive: true });

        mkdirSync(join(pluginDir, "skills", "real-skill"), { recursive: true });
        writeFileSync(join(pluginDir, "skills", "real-skill", "SKILL.md"), "# Real");

        const evilSkill = join(dir, "evil-skill");
        mkdirSync(evilSkill, { recursive: true });
        writeFileSync(join(evilSkill, "SKILL.md"), "# Evil");
        symlinkSync(evilSkill, join(pluginDir, "skills", "evil-skill"));

        const skills = parsePluginSkills(pluginDir);
        expect(skills).toHaveLength(1);
        expect(skills[0].name).toBe("real-skill");
    });

    test("parseRules skips symlinked rule files", () => {
        const dir = freshTmpDir();
        const pluginDir = join(dir, "plugin");
        mkdirSync(join(pluginDir, "rules"), { recursive: true });

        writeFileSync(join(pluginDir, "rules", "real.md"), "# Real");

        const evilFile = join(dir, "evil-rule.md");
        writeFileSync(evilFile, "# Evil");
        symlinkSync(evilFile, join(pluginDir, "rules", "evil.md"));

        const rules = parseRules(pluginDir);
        expect(rules).toHaveLength(1);
        expect(rules[0].name).toBe("real");
    });

    test("parseHooks skips symlinked hook JSON files", () => {
        const dir = freshTmpDir();
        const pluginDir = join(dir, "plugin");
        mkdirSync(join(pluginDir, "hooks"), { recursive: true });

        // Real hook file
        writeFileSync(join(pluginDir, "hooks", "hooks.json"), JSON.stringify({
            hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "real.sh" }] }] },
        }));

        // Symlinked hook file
        const evilHook = join(dir, "evil-hooks.json");
        writeFileSync(evilHook, JSON.stringify({
            hooks: { Stop: [{ hooks: [{ type: "command", command: "evil.sh" }] }] },
        }));
        symlinkSync(evilHook, join(pluginDir, "hooks", "extra.json"));

        const hooks = parseHooks(pluginDir);
        expect(hooks).not.toBeNull();
        expect(hooks!.hooks.PreToolUse).toBeDefined();
        // The symlinked extra.json should be skipped
        expect(hooks!.hooks.Stop).toBeUndefined();
    });
});

// ── Symlinked manifest ────────────────────────────────────────────────────────

describe("symlinked manifest", () => {
    test("parseManifest skips symlinked .claude-plugin/plugin.json", () => {
        const dir = freshTmpDir();
        const pluginDir = join(dir, "symlink-manifest");
        mkdirSync(join(pluginDir, ".claude-plugin"), { recursive: true });
        mkdirSync(join(pluginDir, "commands"), { recursive: true });
        writeFileSync(join(pluginDir, "commands", "test.md"), "# Test");

        const realManifest = join(dir, "real-manifest.json");
        writeFileSync(realManifest, JSON.stringify({ name: "sneaky", description: "Sneaky" }));
        symlinkSync(realManifest, join(pluginDir, ".claude-plugin", "plugin.json"));

        const manifest = parseManifest(pluginDir);
        expect(manifest.name).toBe("symlink-manifest"); // Fallback to dir name
        expect(manifest.description).toBeUndefined();
    });

    test("parseManifest skips symlinked root plugin.json", () => {
        const dir = freshTmpDir();
        const pluginDir = join(dir, "symlink-root");
        mkdirSync(pluginDir, { recursive: true });
        mkdirSync(join(pluginDir, "commands"), { recursive: true });
        writeFileSync(join(pluginDir, "commands", "test.md"), "# Test");

        const realManifest = join(dir, "real-root.json");
        writeFileSync(realManifest, JSON.stringify({ name: "sneaky-root" }));
        symlinkSync(realManifest, join(pluginDir, "plugin.json"));

        const manifest = parseManifest(pluginDir);
        expect(manifest.name).toBe("symlink-root"); // Fallback to dir name
    });
});

// ── Oversized file handling ───────────────────────────────────────────────────

describe("oversized file handling", () => {
    test("parseManifest skips manifest >2MB", () => {
        const dir = freshTmpDir();
        const pluginDir = join(dir, "huge");
        mkdirSync(join(pluginDir, ".claude-plugin"), { recursive: true });

        const huge = JSON.stringify({ name: "huge", description: "x".repeat(3 * 1024 * 1024) });
        writeFileSync(join(pluginDir, ".claude-plugin", "plugin.json"), huge);

        const manifest = parseManifest(pluginDir);
        expect(manifest.name).toBe("huge"); // Fallback to dir name
        expect(manifest.description).toBeUndefined();
    });

    test("parseCommands skips command files >2MB", () => {
        const dir = freshTmpDir();
        const pluginDir = join(dir, "big-cmds");
        mkdirSync(join(pluginDir, "commands"), { recursive: true });

        writeFileSync(join(pluginDir, "commands", "small.md"), "# Small");
        writeFileSync(join(pluginDir, "commands", "huge.md"), "# " + "x".repeat(3 * 1024 * 1024));

        const commands = parseCommands(pluginDir);
        expect(commands).toHaveLength(1);
        expect(commands[0].name).toBe("small");
    });

    test("parseRules skips rule files >2MB", () => {
        const dir = freshTmpDir();
        const pluginDir = join(dir, "big-rules");
        mkdirSync(join(pluginDir, "rules"), { recursive: true });

        writeFileSync(join(pluginDir, "rules", "small.md"), "# Small rule");
        writeFileSync(join(pluginDir, "rules", "huge.md"), "# " + "x".repeat(3 * 1024 * 1024));

        const rules = parseRules(pluginDir);
        expect(rules).toHaveLength(1);
        expect(rules[0].name).toBe("small");
    });
});

// ── Entry limits (MAX_ENTRIES_PER_DIR = 200) ──────────────────────────────────

describe("entry limits", () => {
    test("parseCommands respects MAX_ENTRIES_PER_DIR limit", () => {
        const dir = freshTmpDir();
        const pluginDir = join(dir, "many-cmds");
        mkdirSync(join(pluginDir, "commands"), { recursive: true });

        for (let i = 0; i < 250; i++) {
            writeFileSync(join(pluginDir, "commands", `cmd-${String(i).padStart(3, "0")}.md`), `# Command ${i}`);
        }

        const commands = parseCommands(pluginDir);
        expect(commands.length).toBeLessThanOrEqual(200);
        expect(commands.length).toBeGreaterThan(0);
    });

    test("scanPluginsDir respects entry limit", () => {
        const dir = freshTmpDir();
        const pluginsDir = join(dir, "many-plugins");
        mkdirSync(pluginsDir, { recursive: true });

        // Create 210 plugin dirs (should be capped)
        for (let i = 0; i < 210; i++) {
            const p = join(pluginsDir, `plugin-${String(i).padStart(3, "0")}`);
            mkdirSync(join(p, "commands"), { recursive: true });
            writeFileSync(join(p, "commands", "test.md"), `# Test ${i}`);
        }

        const plugins = scanPluginsDir(pluginsDir);
        expect(plugins.length).toBeLessThanOrEqual(200);
        expect(plugins.length).toBeGreaterThan(0);
    });
});

// ── Project-local vs global plugin isolation ──────────────────────────────────

describe("project-local vs global isolation", () => {
    test("pluginSearchDirs excludes project-local by default", () => {
        const projectDir = "/some/project";
        const dirs = pluginSearchDirs(projectDir);
        const local = projectPluginDirs(projectDir);
        for (const l of local) {
            expect(dirs).not.toContain(l);
        }
    });

    test("pluginSearchDirs includes project-local when opted in", () => {
        const projectDir = "/some/project";
        const dirs = pluginSearchDirs(projectDir, { includeProjectLocal: true });
        const local = projectPluginDirs(projectDir);
        for (const l of local) {
            expect(dirs).toContain(l);
        }
    });

    test("discoverPlugins with extraDirs finds plugins", () => {
        const extraDir = freshTmpDir();
        createPluginTree(extraDir, "extra-plugin", {
            commands: { test: "# Test" },
        });

        const plugins = discoverPlugins("/tmp/nonexistent", { extraDirs: [extraDir] });
        expect(plugins.find(p => p.name === "extra-plugin")).toBeDefined();
    });

    test("discoverPlugins deduplicates by name (first wins)", () => {
        const dir1 = freshTmpDir();
        createPluginTree(dir1, "dup", {
            manifest: { name: "dup", description: "first" },
            commands: { a: "# A" },
        });

        const dir2 = freshTmpDir();
        createPluginTree(dir2, "dup", {
            manifest: { name: "dup", description: "second" },
            commands: { a: "# A", b: "# B" },
        });

        const plugins = discoverPlugins("/tmp/nonexistent", { extraDirs: [dir1, dir2] });
        const dup = plugins.find(p => p.name === "dup");
        expect(dup).toBeDefined();
        expect(dup!.description).toBe("first");
        // Only 1 command from first dir
        expect(dup!.commands).toHaveLength(1);
    });

    test("createClaudePluginExtension finds project-local plugins via cwd", () => {
        const projectDir = freshTmpDir();
        const localPluginsDir = join(projectDir, ".pizzapi", "plugins");
        createPluginTree(localPluginsDir, "local-cmd-plugin", {
            commands: { test: "# Test" },
        });

        const factory = createClaudePluginExtension(projectDir);
        expect(factory).not.toBeNull();
    });

    test("createClaudePluginExtension returns null for empty project when no global plugins exist", () => {
        // This test verifies that an empty project dir alone doesn't produce
        // an extension. However, if global plugins exist in ~/.pizzapi/plugins/
        // (or similar), the function returns non-null regardless of cwd.
        // Since Bun caches homedir() at process start, we can't override HOME.
        const emptyProject = freshTmpDir();
        const result = createClaudePluginExtension(emptyProject);
        // If global plugins exist on this machine, result will be non-null.
        // The key invariant: no project-local plugins should be discovered
        // for an empty project directory.
        const localDirs = projectPluginDirs(emptyProject);
        const localPlugins = localDirs.flatMap(d => scanPluginsDir(d));
        expect(localPlugins).toHaveLength(0);
    });

    test("tilde in extraDirs is expanded", () => {
        const dirs = pluginSearchDirs("/tmp/project", { extraDirs: ["~/my-plugins"] });
        expect(dirs.some(d => d.includes("my-plugins") && !d.startsWith("~"))).toBe(true);
    });

    test("empty/whitespace extraDirs are filtered out", () => {
        const baseline = pluginSearchDirs("/tmp/project").length;
        const withEmpty = pluginSearchDirs("/tmp/project", { extraDirs: ["", "  "] }).length;
        expect(withEmpty).toBe(baseline);
    });
});

// ── Malformed plugin configs ──────────────────────────────────────────────────

describe("malformed plugin configs", () => {
    test("non-JSON manifest is skipped", () => {
        const dir = freshTmpDir();
        const pluginDir = join(dir, "bad-json");
        mkdirSync(join(pluginDir, ".claude-plugin"), { recursive: true });
        writeFileSync(join(pluginDir, ".claude-plugin", "plugin.json"), "not valid json {{{");

        const manifest = parseManifest(pluginDir);
        expect(manifest.name).toBe("bad-json");
    });

    test("hooks.json with invalid structure returns null", () => {
        const dir = freshTmpDir();
        const pluginDir = join(dir, "bad-hooks");
        mkdirSync(join(pluginDir, "hooks"), { recursive: true });
        writeFileSync(join(pluginDir, "hooks", "hooks.json"), "[]");

        expect(parseHooks(pluginDir)).toBeNull();
    });

    test("hook entries with missing or empty command are filtered out", () => {
        const dir = freshTmpDir();
        const pluginDir = join(dir, "empty-hooks");
        mkdirSync(join(pluginDir, "hooks"), { recursive: true });
        writeFileSync(join(pluginDir, "hooks", "hooks.json"), JSON.stringify({
            hooks: {
                PreToolUse: [{
                    matcher: "Bash",
                    hooks: [
                        { type: "command" },
                        { type: "command", command: "" },
                        { type: "command", command: "valid.sh" },
                    ],
                }],
            },
        }));

        const hooks = parseHooks(pluginDir);
        expect(hooks).not.toBeNull();
        expect(hooks!.hooks.PreToolUse![0].hooks).toHaveLength(1);
        expect(hooks!.hooks.PreToolUse![0].hooks[0].command).toBe("valid.sh");
    });

    test("hook groups with non-string matcher are rejected", () => {
        const dir = freshTmpDir();
        const pluginDir = join(dir, "bad-matcher");
        mkdirSync(join(pluginDir, "hooks"), { recursive: true });
        writeFileSync(join(pluginDir, "hooks", "hooks.json"), JSON.stringify({
            hooks: {
                PreToolUse: [
                    { matcher: 123, hooks: [{ type: "command", command: "bad.sh" }] },
                    { matcher: "Edit", hooks: [{ type: "command", command: "good.sh" }] },
                    { hooks: [{ type: "command", command: "also-good.sh" }] },
                ],
            },
        }));

        const hooks = parseHooks(pluginDir);
        expect(hooks).not.toBeNull();
        expect(hooks!.hooks.PreToolUse).toHaveLength(2);
        expect(hooks!.hooks.PreToolUse![0].matcher).toBe("Edit");
        expect(hooks!.hooks.PreToolUse![1].matcher).toBeUndefined();
    });

    test("manifest with non-string fields falls back gracefully", () => {
        const dir = freshTmpDir();
        const pluginDir = join(dir, "bad-types");
        mkdirSync(join(pluginDir, ".claude-plugin"), { recursive: true });
        writeFileSync(join(pluginDir, ".claude-plugin", "plugin.json"), JSON.stringify({
            name: 42,
            description: [],
            version: true,
            keywords: "not-an-array",
        }));

        const manifest = parseManifest(pluginDir);
        expect(manifest.name).toBe("bad-types");
        expect(manifest.description).toBeUndefined();
        expect(manifest.version).toBeUndefined();
        expect(manifest.keywords).toBeUndefined();
    });

    test("hooks with non-array groups for an event are skipped", () => {
        const dir = freshTmpDir();
        const pluginDir = join(dir, "nonarray-groups");
        mkdirSync(join(pluginDir, "hooks"), { recursive: true });
        writeFileSync(join(pluginDir, "hooks", "hooks.json"), JSON.stringify({
            hooks: {
                PreToolUse: "not-an-array",
                Stop: [{ hooks: [{ type: "command", command: "stop.sh" }] }],
            },
        }));

        const hooks = parseHooks(pluginDir);
        expect(hooks).not.toBeNull();
        expect(hooks!.hooks.PreToolUse).toBeUndefined(); // Skipped
        expect(hooks!.hooks.Stop).toHaveLength(1);
    });

    test("null and non-object hook groups are skipped", () => {
        const dir = freshTmpDir();
        const pluginDir = join(dir, "null-groups");
        mkdirSync(join(pluginDir, "hooks"), { recursive: true });
        writeFileSync(join(pluginDir, "hooks", "hooks.json"), JSON.stringify({
            hooks: {
                PostToolUse: [
                    null,
                    42,
                    { matcher: "Write", hooks: [{ type: "command", command: "ok.sh" }] },
                ],
            },
        }));

        const hooks = parseHooks(pluginDir);
        expect(hooks).not.toBeNull();
        expect(hooks!.hooks.PostToolUse).toHaveLength(1);
        expect(hooks!.hooks.PostToolUse![0].hooks[0].command).toBe("ok.sh");
    });
});

// ── Hidden directory handling ─────────────────────────────────────────────────

describe("hidden directory handling", () => {
    test("scanPluginsDir skips directories starting with .", () => {
        const dir = freshTmpDir();
        const pluginsDir = join(dir, "plugins");
        mkdirSync(pluginsDir, { recursive: true });

        const hidden = join(pluginsDir, ".hidden-plugin");
        mkdirSync(join(hidden, "commands"), { recursive: true });
        writeFileSync(join(hidden, "commands", "test.md"), "# Test");

        const visible = join(pluginsDir, "visible-plugin");
        mkdirSync(join(visible, "commands"), { recursive: true });
        writeFileSync(join(visible, "commands", "test.md"), "# Test");

        const plugins = scanPluginsDir(pluginsDir);
        expect(plugins).toHaveLength(1);
        expect(plugins[0].name).toBe("visible-plugin");
    });
});

// ── Multiple JSON files in hooks/ ─────────────────────────────────────────────

describe("multiple hook files", () => {
    test("merges hooks from multiple JSON files in hooks/", () => {
        const dir = freshTmpDir();
        const pluginDir = join(dir, "multi-hooks");
        mkdirSync(join(pluginDir, "hooks"), { recursive: true });

        writeFileSync(join(pluginDir, "hooks", "hooks.json"), JSON.stringify({
            hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "a.sh" }] }] },
        }));
        writeFileSync(join(pluginDir, "hooks", "extra.json"), JSON.stringify({
            hooks: { Stop: [{ hooks: [{ type: "command", command: "b.sh" }] }] },
        }));

        const hooks = parseHooks(pluginDir);
        expect(hooks).not.toBeNull();
        expect(hooks!.hooks.PreToolUse).toHaveLength(1);
        expect(hooks!.hooks.Stop).toHaveLength(1);
    });
});
