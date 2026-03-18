/**
 * Claude Code Plugin adapter for pi-coding-agent.
 *
 * Discovers Claude Code plugins from standard locations, parses their
 * manifests, and provides the data structures needed to register their
 * commands, hooks, and skills into pi's extension system.
 *
 * Plugin format reference:
 *   https://code.claude.com/docs/en/plugins-reference
 *
 * Directory layout expected:
 *   plugin-name/
 *   ├── .claude-plugin/
 *   │   └── plugin.json          # Manifest (optional — inferred from dir if missing)
 *   ├── commands/                 # Slash commands (markdown files)
 *   │   └── example.md
 *   ├── skills/                   # Agent Skills (SKILL.md dirs — already compatible)
 *   │   └── my-skill/
 *   │       └── SKILL.md
 *   ├── hooks/                    # Hook configurations
 *   │   └── hooks.json
 *   └── scripts/                  # Helper scripts referenced by hooks/commands
 */
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";

// ── Constants ─────────────────────────────────────────────────────────────────

/** Maximum size (bytes) for individual plugin files (commands, hooks, rules).
 *  Files exceeding this are skipped to prevent DoS from oversized local plugins. */
const MAX_PLUGIN_FILE_SIZE = 2 * 1024 * 1024; // 2 MB

/** Maximum number of entries (files) per plugin subdirectory (commands, hooks, rules, skills).
 *  Limits CPU/IO during discovery of untrusted local plugins. */
const MAX_ENTRIES_PER_DIR = 200;

/** Read a file only if it's within the size limit. Returns null if too large or unreadable. */
function readFileCapped(path: string, maxBytes: number = MAX_PLUGIN_FILE_SIZE): string | null {
    try {
        const s = statSync(path);
        if (s.size > maxBytes) return null;
        return readFileSync(path, "utf-8");
    } catch {
        return null;
    }
}
import { homedir } from "node:os";
import { expandHome } from "./config.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface PluginManifest {
    name: string;
    description?: string;
    version?: string;
    author?: { name?: string; email?: string; url?: string } | string;
    homepage?: string;
    repository?: string;
    license?: string;
    keywords?: string[];
}

export interface PluginCommand {
    /** Command name (filename without .md extension) */
    name: string;
    /** Raw markdown content of the command file */
    content: string;
    /** Parsed frontmatter fields */
    frontmatter: CommandFrontmatter;
    /** Absolute path to the command .md file */
    filePath: string;
}

export interface CommandFrontmatter {
    description?: string;
    "argument-hint"?: string;
    "allowed-tools"?: string[] | string;
    model?: string;
    "disable-model-invocation"?: boolean;
    "hide-from-slash-command-tool"?: string;
    [key: string]: unknown;
}

/**
 * A single hook entry within a hook event group.
 *
 * Claude Code hooks support types: "command" | "prompt" | "agent"
 * We only adapt "command" type hooks — "prompt" and "agent" types
 * are Claude Code–specific and require that runtime.
 */
export interface HookEntry {
    type: "command" | "prompt" | "agent";
    command?: string;
    prompt?: string;
    timeout?: number;
}

export interface HookGroup {
    matcher?: string;
    hooks: HookEntry[];
}

/**
 * Claude Code hook event names that we can map to pi events.
 */
export type ClaudeHookEvent =
    | "PreToolUse"
    | "PostToolUse"
    | "PostToolUseFailure"
    | "PermissionRequest"
    | "UserPromptSubmit"
    | "Notification"
    | "Stop"
    | "SubagentStart"
    | "SubagentStop"
    | "SessionStart"
    | "SessionEnd"
    | "TeammateIdle"
    | "TaskCompleted"
    | "PreCompact"
    | "ConfigChange"
    | "WorktreeCreate"
    | "WorktreeRemove";

export interface HooksConfig {
    description?: string;
    hooks: Partial<Record<ClaudeHookEvent, HookGroup[]>>;
}

export interface PluginSkillRef {
    /** Skill name (directory name) */
    name: string;
    /** Absolute path to the skill directory containing SKILL.md */
    dirPath: string;
    /** Absolute path to SKILL.md */
    skillMdPath: string;
}

export interface PluginAgentRef {
    /** Agent name (filename without .md extension) */
    name: string;
    /** Absolute path to the agent .md file */
    filePath: string;
}

export interface PluginRule {
    /** Rule name (filename without .md extension) */
    name: string;
    /** Raw markdown content of the rule file */
    content: string;
    /** Absolute path to the rule .md file */
    filePath: string;
}

export interface DiscoveredPlugin {
    /** Plugin name (from manifest or directory name) */
    name: string;
    /** Plugin description */
    description: string;
    /** Absolute path to the plugin root directory */
    rootPath: string;
    /** Parsed manifest (or synthesized from directory) */
    manifest: PluginManifest;
    /** Discovered slash commands */
    commands: PluginCommand[];
    /** Parsed hooks configuration */
    hooks: HooksConfig | null;
    /** Skills directories (passed through to pi — already compatible format) */
    skills: PluginSkillRef[];
    /** Agent definitions (markdown files in agents/ directory) */
    agents: PluginAgentRef[];
    /** Rules — markdown guidelines injected into the system prompt */
    rules: PluginRule[];
    /** Whether the plugin has MCP configuration (informational — not adapted) */
    hasMcp: boolean;
    /** Whether the plugin has agent definitions */
    hasAgents: boolean;
    /** Whether the plugin has LSP configuration (informational — not adapted) */
    hasLsp: boolean;
}

// ── Discovery locations ───────────────────────────────────────────────────────

/**
 * Global (trusted) directories to scan for Claude Code plugins.
 *
 * These are user-controlled home directories — safe to auto-load because
 * they have the same trust level as ~/.pi/agent/extensions/ or ~/.agents/skills/.
 *
 * NOTE: ~/.claude/plugins/ is intentionally excluded here. Claude Code manages
 * that directory via its marketplace system — plugins are installed into a cache
 * subdirectory and tracked via installed_plugins.json. We discover those via
 * discoverClaudeInstalledPlugins() instead of blindly scanning the directory.
 */
export function globalPluginDirs(): string[] {
    const home = homedir();
    return [
        join(home, ".pizzapi", "plugins"),
        join(home, ".agents", "plugins"),
    ];
}

/**
 * Project-local directories where plugins can live.
 *
 * **Security note:** project-local plugins can execute arbitrary shell
 * commands via hooks. They are NOT auto-loaded. The caller must explicitly
 * opt in by passing `includeProjectLocal: true` (e.g. from a config flag)
 * or by listing them in `extraDirs`.
 */
export function projectPluginDirs(cwd: string): string[] {
    return [
        join(cwd, ".pizzapi", "plugins"),
        join(cwd, ".agents", "plugins"),
        join(cwd, ".claude", "plugins"),
    ];
}

/**
 * Build the full list of plugin search directories.
 *
 * @param cwd - Project working directory
 * @param opts.includeProjectLocal - If true, include project-local plugin dirs
 *   (default: false for security — project-local plugins can run arbitrary code)
 * @param opts.extraDirs - Additional directories to scan (explicitly trusted by user)
 */
export function pluginSearchDirs(cwd?: string, opts?: { includeProjectLocal?: boolean; extraDirs?: string[] }): string[] {
    const dirs = [...globalPluginDirs()];

    if (opts?.includeProjectLocal && cwd) {
        dirs.push(...projectPluginDirs(cwd));
    }

    if (Array.isArray(opts?.extraDirs)) {
        for (const d of opts!.extraDirs) {
            if (typeof d === "string" && d.trim()) {
                dirs.push(expandHome(d));
            }
        }
    }
    return [...new Set(dirs)];
}

// ── Claude Code installed plugins ─────────────────────────────────────────────

/**
 * Represents an entry from Claude Code's installed_plugins.json.
 */
export interface ClaudeInstalledPluginEntry {
    scope: string;
    installPath: string;
    version: string;
    lastUpdated?: string;
    projectPath?: string;
}

/**
 * Read `enabledPlugins` from Claude Code settings files and merge them.
 *
 * Checks (in precedence order, higher wins):
 *   1. ~/.claude/settings.json (user-level)
 *   2. .claude/settings.json (project-level, relative to cwd)
 *   3. .claude/settings.local.json (project-local overrides)
 *
 * Returns a merged map of `"pluginName@marketplace" → boolean`.
 * If no settings files exist or none contain `enabledPlugins`, returns null.
 */
export function readEnabledPlugins(cwd?: string): Record<string, boolean> | null {
    const home = process.env.HOME || homedir();
    const candidates: string[] = [
        join(home, ".claude", "settings.json"),
    ];
    if (cwd) {
        candidates.push(join(cwd, ".claude", "settings.json"));
        candidates.push(join(cwd, ".claude", "settings.local.json"));
    }

    let merged: Record<string, boolean> | null = null;

    for (const path of candidates) {
        if (!existsSync(path)) continue;
        try {
            const raw = readFileSync(path, "utf-8");
            const parsed = JSON.parse(raw);
            if (parsed.enabledPlugins && typeof parsed.enabledPlugins === "object") {
                if (!merged) merged = {};
                // Later files (project-level) override earlier (user-level)
                for (const [key, value] of Object.entries(parsed.enabledPlugins)) {
                    if (typeof value === "boolean") {
                        merged[key] = value;
                    }
                }
            }
        } catch {
            // Skip unreadable/unparseable settings files
        }
    }

    return merged;
}

/**
 * Check if a plugin key (e.g. "my-plugin@marketplace") is enabled
 * according to the `enabledPlugins` map.
 *
 * Rules:
 * - If enabledPlugins is null (no settings found), all plugins are enabled.
 * - If the key is explicitly `false`, the plugin is disabled.
 * - If the key is not listed or is `true`, the plugin is enabled.
 */
function isPluginEnabled(key: string, enabledPlugins: Record<string, boolean> | null): boolean {
    if (!enabledPlugins) return true;
    return enabledPlugins[key] !== false;
}

/**
 * Discover plugins installed via Claude Code's marketplace system.
 *
 * Reads ~/.claude/plugins/installed_plugins.json and parses each plugin
 * from its cached installPath. Only returns plugins whose installPath
 * actually exists on disk.
 *
 * Also respects the `enabledPlugins` setting from Claude Code's settings
 * files — plugins explicitly set to `false` are skipped.
 *
 * This replaces the old approach of blindly scanning ~/.claude/plugins/
 * as a flat directory, which would pick up marketplace catalogs and
 * ignore the enable/disable state managed by Claude Code.
 *
 * @param cwd - Project working directory (used to filter project-scoped plugins)
 */
export function discoverClaudeInstalledPlugins(cwd?: string): DiscoveredPlugin[] {
    // Use process.env.HOME directly (not homedir()) so tests can override it.
    // homedir() caches the value at process start and ignores env changes.
    const home = process.env.HOME || homedir();
    const installedPath = join(home, ".claude", "plugins", "installed_plugins.json");

    if (!existsSync(installedPath)) return [];

    let raw: string;
    try {
        raw = readFileSync(installedPath, "utf-8");
    } catch {
        return [];
    }

    let data: { version?: number; plugins?: Record<string, ClaudeInstalledPluginEntry[]> };
    try {
        data = JSON.parse(raw);
    } catch {
        return [];
    }

    if (!data.plugins || typeof data.plugins !== "object") return [];

    // Read enabledPlugins from Claude Code settings to respect disabled state
    const enabledPlugins = readEnabledPlugins(cwd);

    const plugins: DiscoveredPlugin[] = [];
    const seen = new Set<string>();

    for (const [_key, installations] of Object.entries(data.plugins)) {
        // Check enabledPlugins — skip plugins explicitly disabled
        if (!isPluginEnabled(_key, enabledPlugins)) continue;

        if (!Array.isArray(installations) || installations.length === 0) continue;

        // Find the best installation: prefer most recently updated
        const sorted = [...installations]
            .filter(inst => inst && typeof inst.installPath === "string" && inst.installPath.length > 0)
            .sort((a, b) => {
                const ta = typeof a.lastUpdated === "string" ? new Date(a.lastUpdated).getTime() : 0;
                const tb = typeof b.lastUpdated === "string" ? new Date(b.lastUpdated).getTime() : 0;
                return tb - ta;
            });

        for (const inst of sorted) {
            // Skip project-scoped plugins that don't match current cwd.
            // Uses path.relative to avoid platform-specific separator issues.
            // On Windows, cross-drive relative() returns an absolute path, so
            // we also reject when isAbsolute(rel) is true.
            if (inst.scope === "project" && cwd && inst.projectPath) {
                const rel = relative(resolve(inst.projectPath), resolve(cwd));
                if (rel.startsWith("..") || isAbsolute(rel)) {
                    continue;
                }
            }

            const installDir = inst.installPath;
            if (!existsSync(installDir)) continue;

            // Check it looks like a plugin directory
            if (!isPluginDir(installDir)) continue;

            try {
                const plugin = parsePlugin(installDir);
                if (!seen.has(plugin.name)) {
                    seen.add(plugin.name);
                    plugins.push(plugin);
                }
                break; // Successfully parsed — use this installation
            } catch {
                // Unparseable — fall through to try next installation
                continue;
            }
        }
    }

    return plugins;
}

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

// ── Full plugin discovery ─────────────────────────────────────────────────────

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

/**
 * Scan a directory for Claude Code plugins.
 * Each immediate subdirectory that looks like a plugin is parsed.
 */
export function scanPluginsDir(dir: string): DiscoveredPlugin[] {
    if (!existsSync(dir)) return [];

    let entries: string[];
    try {
        entries = readdirSync(dir).slice(0, MAX_ENTRIES_PER_DIR);
    } catch {
        return [];
    }

    const plugins: DiscoveredPlugin[] = [];

    for (const entry of entries) {
        if (entry.startsWith(".")) continue;

        const entryPath = join(dir, entry);
        try {
            // Use lstatSync to avoid following symlinks — reject symlinked
            // plugin root dirs to prevent scanning outside the plugins dir
            const s = lstatSync(entryPath);
            if (s.isSymbolicLink() || !s.isDirectory()) continue;
        } catch {
            continue;
        }

        if (isPluginDir(entryPath)) {
            try {
                plugins.push(parsePlugin(entryPath));
            } catch {
                // Skip unparseable plugins
            }
        }
    }

    return plugins;
}

/**
 * Discover all Claude Code plugins from all search directories.
 * Deduplicates by plugin name (first found wins).
 *
 * Discovery sources (in precedence order):
 * 1. PizzaPi plugin dirs (~/.pizzapi/plugins/, ~/.agents/plugins/)
 * 2. Claude Code installed plugins (from ~/.claude/plugins/installed_plugins.json)
 * 3. Project-local plugin dirs (if opts.includeProjectLocal)
 * 4. Extra dirs (if opts.extraDirs)
 *
 * @param cwd - Project working directory
 * @param opts.includeProjectLocal - If true, include project-local plugin dirs
 *   (default: false — project-local plugins can run arbitrary code)
 * @param opts.extraDirs - Additional directories to scan
 */
export function discoverPlugins(cwd?: string, opts?: { includeProjectLocal?: boolean; extraDirs?: string[] }): DiscoveredPlugin[] {
    const dirs = pluginSearchDirs(cwd, opts);
    const seen = new Set<string>();
    const plugins: DiscoveredPlugin[] = [];

    // 1. Scan PizzaPi/agents plugin dirs
    for (const dir of dirs) {
        for (const plugin of scanPluginsDir(dir)) {
            if (!seen.has(plugin.name)) {
                seen.add(plugin.name);
                plugins.push(plugin);
            }
        }
    }

    // 2. Discover Claude Code marketplace-installed plugins
    for (const plugin of discoverClaudeInstalledPlugins(cwd)) {
        if (!seen.has(plugin.name)) {
            seen.add(plugin.name);
            plugins.push(plugin);
        }
    }

    return plugins;
}

// ── Hook event mapping ────────────────────────────────────────────────────────

/**
 * Maps Claude Code hook events to pi-coding-agent event names.
 *
 * Not all events have direct equivalents. Events that can't be mapped
 * are returned as null.
 */
export function mapHookEventToPi(claudeEvent: ClaudeHookEvent): string | null {
    const mapping: Record<ClaudeHookEvent, string | null> = {
        PreToolUse: "tool_call",
        PostToolUse: "tool_result",
        PostToolUseFailure: "tool_result",  // pi fires tool_result for both success/failure
        PermissionRequest: null,            // No pi equivalent
        UserPromptSubmit: "input",
        Notification: null,                 // No pi equivalent
        Stop: "agent_end",
        SubagentStart: null,                // No direct pi equivalent
        SubagentStop: null,                 // No direct pi equivalent
        SessionStart: "session_start",
        SessionEnd: "session_shutdown",
        TeammateIdle: null,                 // No pi equivalent
        TaskCompleted: null,                // No pi equivalent
        PreCompact: "session_before_compact",
        ConfigChange: null,                 // No pi equivalent
        WorktreeCreate: null,               // No pi equivalent
        WorktreeRemove: null,               // No pi equivalent
    };
    return mapping[claudeEvent] ?? null;
}

/**
 * Check if a tool name matches a Claude-style matcher pattern.
 *
 * Matchers use `|` for OR: "Edit|Write|MultiEdit"
 * Matchers can use `Bash(prefix:*)` for bash command prefix matching.
 */
export function matchesTool(matcher: string | undefined | unknown, toolName: string, toolInput?: Record<string, unknown>): boolean {
    if (matcher == null) return true; // No matcher = match all

    // Reject non-string matchers from malformed plugin configs — they
    // should NOT match any tool (previously returned true = match-all,
    // which could cause hooks to fire on every tool call by mistake).
    if (typeof matcher !== "string") return false;

    // Treat common wildcard patterns as match-all
    const trimmed = matcher.trim();
    if (trimmed === ".*" || trimmed === "*" || trimmed === ".+") return true;

    const patterns = matcher.split("|").map(s => s.trim());

    for (const pattern of patterns) {
        // Simple name match
        if (pattern === toolName) return true;

        // Map Claude tool names to pi tool names
        const claudeToPi: Record<string, string> = {
            Read: "read",
            Write: "write",
            Edit: "edit",
            Bash: "bash",
            Glob: "find",
            Grep: "grep",
            MultiEdit: "edit",
        };

        if (claudeToPi[pattern] === toolName) return true;

        // Bash(prefix:*) pattern matching
        const bashMatch = pattern.match(/^Bash\((.+):\*?\)$/);
        if (bashMatch && toolName === "bash" && toolInput) {
            const prefix = bashMatch[1];
            const command = (toolInput as any).command;
            if (typeof command === "string" && command.trimStart().startsWith(prefix)) {
                return true;
            }
        }
    }

    return false;
}

// ── Serialization for API/UI ──────────────────────────────────────────────────

/** Lightweight plugin info for the Web UI */
export interface PluginInfo {
    name: string;
    description: string;
    rootPath: string;
    commands: { name: string; description?: string; argumentHint?: string }[];
    hookEvents: string[];
    skills: { name: string; dirPath: string }[];
    agents: { name: string }[];
    rules: { name: string }[];
    hasMcp: boolean;
    hasAgents: boolean;
    hasLsp: boolean;
    version?: string;
    author?: string;
}

/**
 * Convert a DiscoveredPlugin to a lightweight PluginInfo for the UI.
 */
export function toPluginInfo(plugin: DiscoveredPlugin): PluginInfo {
    const authorStr =
        typeof plugin.manifest.author === "string"
            ? plugin.manifest.author
            : plugin.manifest.author?.name;

    return {
        name: plugin.name,
        description: plugin.description,
        rootPath: plugin.rootPath,
        commands: plugin.commands.map(c => ({
            name: c.name,
            description: c.frontmatter.description,
            argumentHint: c.frontmatter["argument-hint"],
        })),
        hookEvents: plugin.hooks ? Object.keys(plugin.hooks.hooks) : [],
        skills: plugin.skills.map(s => ({ name: s.name, dirPath: s.dirPath })),
        agents: plugin.agents.map(a => ({ name: a.name })),
        rules: plugin.rules.map(r => ({ name: r.name })),
        hasMcp: plugin.hasMcp,
        hasAgents: plugin.hasAgents,
        hasLsp: plugin.hasLsp,
        version: plugin.manifest.version,
        author: authorStr,
    };
}

/**
 * Scan and return plugin info for all discovered plugins.
 */
export function scanAllPluginInfo(cwd?: string, opts?: { includeProjectLocal?: boolean; extraDirs?: string[] }): PluginInfo[] {
    return discoverPlugins(cwd, opts).map(toPluginInfo);
}
