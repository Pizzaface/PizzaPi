/**
 * Low-level parsers for Claude Code plugin components.
 *
 * Covers: frontmatter, manifests, commands, hooks, skills, agents, rules,
 * and the high-level `parsePlugin` / `isPluginDir` entry points.
 */
import { existsSync, lstatSync, readdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import {
    MAX_ENTRIES_PER_DIR,
    readFileCapped,
    type ClaudeHookEvent,
    type CommandFrontmatter,
    type DiscoveredPlugin,
    type HookEntry,
    type HookGroup,
    type HooksConfig,
    type PluginAgentRef,
    type PluginCommand,
    type PluginManifest,
    type PluginRule,
    type PluginSkillRef,
} from "./types.js";

// ── Parsing helpers ───────────────────────────────────────────────────────────

/**
 * Parse YAML-style frontmatter from a markdown string.
 * Returns the frontmatter object and the body content after the frontmatter.
 */
export function parseMarkdownFrontmatter(content: string): { frontmatter: Record<string, unknown>; body: string } {
    const trimmed = content.trimStart();
    if (!trimmed.startsWith("---")) {
        return { frontmatter: {}, body: content };
    }

    const endIdx = trimmed.indexOf("\n---", 3);
    if (endIdx === -1) {
        return { frontmatter: {}, body: content };
    }

    const fmBlock = trimmed.slice(3, endIdx).trim();
    const body = trimmed.slice(endIdx + 4).trim();
    const frontmatter: Record<string, unknown> = {};

    for (const line of fmBlock.split("\n")) {
        const colonIdx = line.indexOf(":");
        if (colonIdx === -1) continue;

        const key = line.slice(0, colonIdx).trim();
        let value: unknown = line.slice(colonIdx + 1).trim();

        // Strip quotes
        if (typeof value === "string") {
            const str = value as string;
            if ((str.startsWith('"') && str.endsWith('"')) || (str.startsWith("'") && str.endsWith("'"))) {
                value = str.slice(1, -1);
            }
            // Try to parse JSON arrays: ["Bash", "Read", "Write"] or [Bash, Read, Write]
            // But NOT bracket-wrapped scalar hints like [branch-name] or <arg>
            if (str.startsWith("[") && str.endsWith("]") && str.includes(",")) {
                try {
                    value = JSON.parse(str);
                } catch {
                    // Try comma-separated: [Bash, Read]
                    value = str.slice(1, -1).split(",").map(s => s.trim().replace(/^["']|["']$/g, ""));
                }
            }
            // Booleans
            if (value === "true") value = true;
            if (value === "false") value = false;
        }

        frontmatter[key] = value;
    }

    return { frontmatter, body };
}

/**
 * Resolve `${CLAUDE_PLUGIN_ROOT}` placeholders in hook commands.
 */
export function resolvePluginRoot(text: string, pluginRoot: string): string {
    return text.replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, pluginRoot);
}

// ── Plugin parsing ────────────────────────────────────────────────────────────

/**
 * Parse a plugin.json manifest file.
 *
 * Checks in order:
 *   1. .claude-plugin/plugin.json (Claude Code standard location)
 *   2. plugin.json (root — common in third-party plugins)
 *
 * Returns a synthesized manifest from the directory name if neither is found.
 */
export function parseManifest(pluginDir: string): PluginManifest {
    const candidates = [
        join(pluginDir, ".claude-plugin", "plugin.json"),
        join(pluginDir, "plugin.json"),
    ];
    const dirName = basename(pluginDir);

    for (const manifestPath of candidates) {
        if (!existsSync(manifestPath)) continue;
        try {
            // Verify it's a regular file — a FIFO/device here could block
            // readFileSync during discovery before trust approval.
            const mstat = lstatSync(manifestPath);
            if (mstat.isSymbolicLink() || !mstat.isFile()) continue;

            const raw = readFileCapped(manifestPath);
            if (raw === null) continue; // Too large or unreadable — skip
            const parsed = JSON.parse(raw);
            const name = typeof parsed.name === "string" && parsed.name.trim()
                ? parsed.name.trim()
                : dirName;
            return {
                name,
                description: typeof parsed.description === "string" ? parsed.description : undefined,
                version: typeof parsed.version === "string" ? parsed.version : undefined,
                author: parsed.author,
                homepage: typeof parsed.homepage === "string" ? parsed.homepage : undefined,
                repository: typeof parsed.repository === "string" ? parsed.repository : undefined,
                license: typeof parsed.license === "string" ? parsed.license : undefined,
                keywords: Array.isArray(parsed.keywords) ? parsed.keywords.filter((k: unknown) => typeof k === "string") : undefined,
            };
        } catch {
            // Try next candidate
        }
    }

    return { name: dirName };
}

/**
 * Discover all commands in a plugin's commands/ directory.
 * Recursively scans subdirectories — a command at commands/pm/epic-start.md
 * is registered with name "pm/epic-start".
 */
export function parseCommands(pluginDir: string): PluginCommand[] {
    const commandsDir = join(pluginDir, "commands");
    if (!existsSync(commandsDir)) return [];

    // Reject if commands/ itself is a symlink (prevents scanning outside plugin root)
    try {
        if (lstatSync(commandsDir).isSymbolicLink()) return [];
    } catch { return []; }

    const commands: PluginCommand[] = [];

    const MAX_DEPTH = 10;
    let entryCount = 0;

    function scanDir(dir: string, prefix: string, depth: number = 0) {
        if (depth > MAX_DEPTH) return;
        if (entryCount >= MAX_ENTRIES_PER_DIR) return;

        let entries: string[];
        try {
            entries = readdirSync(dir);
        } catch {
            return;
        }

        for (const entry of entries) {
            if (entryCount >= MAX_ENTRIES_PER_DIR) break;
            entryCount++;

            const entryPath = join(dir, entry);
            let stat;
            try {
                // Use lstatSync to avoid following symlinks (prevents cycles)
                stat = lstatSync(entryPath);
            } catch {
                continue;
            }

            // lstatSync does not follow symlinks — a symlinked dir will
            // show isSymbolicLink()=true, isDirectory()=false. Skip symlink
            // dirs to prevent recursive symlink DoS.
            if (stat.isSymbolicLink()) continue;

            if (stat.isDirectory()) {
                scanDir(entryPath, prefix ? `${prefix}/${entry}` : entry, depth + 1);
                continue;
            }

            // Only read regular files — skip FIFOs, devices, sockets, etc.
            // that could block readFileSync before trust approval.
            if (!stat.isFile()) continue;

            if (!entry.endsWith(".md")) continue;

            const content = readFileCapped(entryPath);
            if (content === null) continue;

            const baseName = entry.slice(0, -3); // Strip .md
            const name = prefix ? `${prefix}/${baseName}` : baseName;
            const { frontmatter, body } = parseMarkdownFrontmatter(content);

            commands.push({
                name,
                content: body,
                frontmatter: frontmatter as CommandFrontmatter,
                filePath: entryPath,
            });
        }
    }

    scanDir(commandsDir, "");
    return commands;
}

/**
 * Parse hooks/hooks.json (and any other *.json files in hooks/).
 * Merges all hook configs found.
 */
export function parseHooks(pluginDir: string): HooksConfig | null {
    const hooksDir = join(pluginDir, "hooks");
    if (!existsSync(hooksDir)) return null;

    // Reject if hooks/ itself is a symlink (prevents scanning outside plugin root)
    try {
        if (lstatSync(hooksDir).isSymbolicLink()) return null;
    } catch { return null; }

    const merged: HooksConfig = { hooks: {} };
    let foundAny = false;

    let entries: string[];
    try {
        entries = readdirSync(hooksDir).slice(0, MAX_ENTRIES_PER_DIR);
    } catch {
        return null;
    }

    for (const entry of entries) {
        if (!entry.endsWith(".json")) continue;

        const filePath = join(hooksDir, entry);
        // Skip symlinks and non-regular files (FIFOs, devices, sockets)
        // that could block readFileSync before trust approval.
        try {
            const hookStat = lstatSync(filePath);
            if (hookStat.isSymbolicLink() || !hookStat.isFile()) continue;
        } catch { continue; }
        const raw = readFileCapped(filePath);
        if (raw === null) continue;
        try {
            const parsed = JSON.parse(raw) as Partial<HooksConfig>;

            if (parsed.description && !merged.description) {
                merged.description = parsed.description;
            }

            if (parsed.hooks && typeof parsed.hooks === "object") {
                for (const [event, groups] of Object.entries(parsed.hooks)) {
                    const key = event as ClaudeHookEvent;
                    if (!Array.isArray(groups)) continue;
                    if (!merged.hooks[key]) {
                        merged.hooks[key] = [];
                    }
                    // Validate each group has the expected shape
                    for (const group of groups) {
                        if (!group || typeof group !== "object") continue;
                        if (!Array.isArray((group as any).hooks)) continue;
                        // Reject groups with invalid matcher types (must be string or absent)
                        if ("matcher" in (group as any) && typeof (group as any).matcher !== "string") continue;
                        // Sanitize individual hook entries: require type+command strings
                        const g = group as HookGroup;
                        g.hooks = g.hooks.filter((h): h is HookEntry => {
                            if (!h || typeof h !== "object") return false;
                            if (h.type === "command") {
                                return typeof h.command === "string" && h.command.trim().length > 0;
                            }
                            return true; // allow future hook types
                        });
                        if (g.hooks.length === 0) continue;
                        merged.hooks[key]!.push(g);
                    }
                }
                foundAny = true;
            }
        } catch {
            // Skip unparseable hook files
        }
    }

    return foundAny ? merged : null;
}

/**
 * Discover skills within a plugin's skills/ directory.
 */
export function parsePluginSkills(pluginDir: string): PluginSkillRef[] {
    const skillsDir = join(pluginDir, "skills");
    if (!existsSync(skillsDir)) return [];

    // Reject if skills/ itself is a symlink
    try {
        if (lstatSync(skillsDir).isSymbolicLink()) return [];
    } catch { return []; }

    const skills: PluginSkillRef[] = [];

    let entries: string[];
    try {
        entries = readdirSync(skillsDir).slice(0, MAX_ENTRIES_PER_DIR);
    } catch {
        return [];
    }

    for (const entry of entries) {
        const entryPath = join(skillsDir, entry);
        try {
            // Use lstatSync: skip symlinked skill dirs
            const s = lstatSync(entryPath);
            if (s.isSymbolicLink() || !s.isDirectory()) continue;
        } catch {
            continue;
        }

        const skillMdPath = join(entryPath, "SKILL.md");
        if (existsSync(skillMdPath)) {
            // Also verify SKILL.md itself is not a symlink — a symlinked SKILL.md
            // could point to arbitrary files outside the plugin root.
            try {
                const skillMdStat = lstatSync(skillMdPath);
                if (skillMdStat.isSymbolicLink()) continue;
            } catch {
                continue;
            }
            skills.push({
                name: entry,
                dirPath: entryPath,
                skillMdPath,
            });
        }
    }

    return skills;
}

/**
 * Discover agent definitions within a plugin's agents/ directory.
 * Agents are markdown files (*.md) with frontmatter — same format
 * as user agents in ~/.pizzapi/agents/ or ~/.claude/agents/.
 */
export function parsePluginAgents(pluginDir: string): PluginAgentRef[] {
    const agentsDir = join(pluginDir, "agents");
    if (!existsSync(agentsDir)) return [];

    // Reject if agents/ itself is a symlink
    try {
        if (lstatSync(agentsDir).isSymbolicLink()) return [];
    } catch { return []; }

    const agents: PluginAgentRef[] = [];

    let entries: string[];
    try {
        entries = readdirSync(agentsDir).slice(0, MAX_ENTRIES_PER_DIR);
    } catch {
        return [];
    }

    for (const entry of entries) {
        if (!entry.endsWith(".md")) continue;

        const filePath = join(agentsDir, entry);
        try {
            // Use lstatSync: skip symlinks and non-regular files
            const s = lstatSync(filePath);
            if (s.isSymbolicLink() || !s.isFile()) continue;
        } catch {
            continue;
        }

        agents.push({
            name: entry.slice(0, -3), // Strip .md
            filePath,
        });
    }

    return agents;
}

/**
 * Discover rules within a plugin's rules/ directory.
 * Rules are markdown files containing guidelines injected into the system prompt.
 */
export function parseRules(pluginDir: string): PluginRule[] {
    const rulesDir = join(pluginDir, "rules");
    if (!existsSync(rulesDir)) return [];

    // Reject if rules/ itself is a symlink
    try {
        if (lstatSync(rulesDir).isSymbolicLink()) return [];
    } catch { return []; }

    const rules: PluginRule[] = [];

    let entries: string[];
    try {
        entries = readdirSync(rulesDir).slice(0, MAX_ENTRIES_PER_DIR);
    } catch {
        return [];
    }

    for (const entry of entries) {
        if (!entry.endsWith(".md")) continue;

        const filePath = join(rulesDir, entry);
        try {
            // Use lstatSync: skip symlinked rule files
            const s = lstatSync(filePath);
            if (s.isSymbolicLink() || !s.isFile()) continue;
        } catch {
            continue;
        }

        const content = readFileCapped(filePath);
        if (content === null) continue;

        rules.push({
            name: entry.slice(0, -3), // Strip .md
            content,
            filePath,
        });
    }

    return rules;
}

// ── Full plugin parsing ───────────────────────────────────────────────────────

/**
 * Check if a directory looks like a Claude Code plugin.
 * A directory is a plugin if it has any of:
 *   - .claude-plugin/plugin.json
 *   - plugin.json (root-level manifest)
 *   - commands/ directory
 *   - hooks/ directory
 *   - rules/ directory
 *   - skills/ directory
 */
export function isPluginDir(dir: string): boolean {
    if (existsSync(join(dir, ".claude-plugin", "plugin.json"))) return true;
    if (existsSync(join(dir, "plugin.json"))) return true;
    if (existsSync(join(dir, "commands"))) return true;
    if (existsSync(join(dir, "hooks"))) return true;
    if (existsSync(join(dir, "rules"))) return true;
    // Skills-only dirs are valid plugins — their SKILL.md entries are
    // added to pi via getPluginSkillPaths() and need to be discovered here.
    if (existsSync(join(dir, "skills"))) return true;
    // Agents-only dirs are valid plugins — their agent .md files are
    // discovered via getPluginAgentPaths() for the subagent extension.
    if (existsSync(join(dir, "agents"))) return true;
    return false;
}

/**
 * Fully parse a single plugin directory.
 */
export function parsePlugin(pluginDir: string): DiscoveredPlugin {
    const rootPath = resolve(pluginDir);
    const manifest = parseManifest(rootPath);
    const commands = parseCommands(rootPath);
    const hooks = parseHooks(rootPath);
    const skills = parsePluginSkills(rootPath);
    const agents = parsePluginAgents(rootPath);
    const rules = parseRules(rootPath);

    return {
        name: manifest.name,
        description: manifest.description ?? "",
        rootPath,
        manifest,
        commands,
        hooks,
        skills,
        agents,
        rules,
        hasMcp: existsSync(join(rootPath, ".mcp.json")),
        hasAgents: agents.length > 0,
        hasLsp: existsSync(join(rootPath, ".lsp.json")),
    };
}
