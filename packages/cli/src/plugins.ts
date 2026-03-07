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
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { homedir } from "node:os";

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
    /** Whether the plugin has MCP configuration (informational — not adapted) */
    hasMcp: boolean;
    /** Whether the plugin has agent definitions (informational — not adapted) */
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
 */
export function globalPluginDirs(): string[] {
    const home = homedir();
    return [
        join(home, ".pizzapi", "plugins"),
        join(home, ".agents", "plugins"),
        // Claude Code's own plugin locations (read-only discovery)
        join(home, ".claude", "plugins"),
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
export function pluginSearchDirs(cwd: string, opts?: { includeProjectLocal?: boolean; extraDirs?: string[] }): string[] {
    const dirs = [...globalPluginDirs()];

    if (opts?.includeProjectLocal) {
        dirs.push(...projectPluginDirs(cwd));
    }

    if (Array.isArray(opts?.extraDirs)) {
        for (const d of opts!.extraDirs) {
            if (typeof d === "string" && d.trim()) {
                dirs.push(d.replace(/^~/, homedir()));
            }
        }
    }
    return [...new Set(dirs)];
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
 * Returns a synthesized manifest from the directory name if the file is missing.
 */
export function parseManifest(pluginDir: string): PluginManifest {
    const manifestPath = join(pluginDir, ".claude-plugin", "plugin.json");
    const dirName = basename(pluginDir);

    if (existsSync(manifestPath)) {
        try {
            const raw = readFileSync(manifestPath, "utf-8");
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
            // Fall through to synthesized manifest
        }
    }

    return { name: dirName };
}

/**
 * Discover all commands in a plugin's commands/ directory.
 */
export function parseCommands(pluginDir: string): PluginCommand[] {
    const commandsDir = join(pluginDir, "commands");
    if (!existsSync(commandsDir)) return [];

    const commands: PluginCommand[] = [];

    let entries: string[];
    try {
        entries = readdirSync(commandsDir);
    } catch {
        return [];
    }

    for (const entry of entries) {
        if (!entry.endsWith(".md")) continue;

        const filePath = join(commandsDir, entry);
        try {
            if (!statSync(filePath).isFile()) continue;
        } catch {
            continue;
        }

        const name = entry.slice(0, -3); // Strip .md
        let content: string;
        try {
            content = readFileSync(filePath, "utf-8");
        } catch {
            continue;
        }

        const { frontmatter, body } = parseMarkdownFrontmatter(content);

        commands.push({
            name,
            content: body,
            frontmatter: frontmatter as CommandFrontmatter,
            filePath,
        });
    }

    return commands;
}

/**
 * Parse hooks/hooks.json (and any other *.json files in hooks/).
 * Merges all hook configs found.
 */
export function parseHooks(pluginDir: string): HooksConfig | null {
    const hooksDir = join(pluginDir, "hooks");
    if (!existsSync(hooksDir)) return null;

    const merged: HooksConfig = { hooks: {} };
    let foundAny = false;

    let entries: string[];
    try {
        entries = readdirSync(hooksDir);
    } catch {
        return null;
    }

    for (const entry of entries) {
        if (!entry.endsWith(".json")) continue;

        const filePath = join(hooksDir, entry);
        try {
            const raw = readFileSync(filePath, "utf-8");
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
                        merged.hooks[key]!.push(group);
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

    const skills: PluginSkillRef[] = [];

    let entries: string[];
    try {
        entries = readdirSync(skillsDir);
    } catch {
        return [];
    }

    for (const entry of entries) {
        const entryPath = join(skillsDir, entry);
        try {
            if (!statSync(entryPath).isDirectory()) continue;
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

// ── Full plugin discovery ─────────────────────────────────────────────────────

/**
 * Check if a directory looks like a Claude Code plugin.
 * A directory is a plugin if it has any of:
 *   - .claude-plugin/plugin.json
 *   - commands/ directory
 *   - hooks/ directory with .json files
 *   - skills/ directory with SKILL.md subdirs
 */
export function isPluginDir(dir: string): boolean {
    if (existsSync(join(dir, ".claude-plugin", "plugin.json"))) return true;
    if (existsSync(join(dir, "commands"))) return true;
    if (existsSync(join(dir, "hooks"))) return true;
    // Don't count skills-only dirs as plugins — they're already handled by pi's skill discovery
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

    return {
        name: manifest.name,
        description: manifest.description ?? "",
        rootPath,
        manifest,
        commands,
        hooks,
        skills,
        hasMcp: existsSync(join(rootPath, ".mcp.json")),
        hasAgents: existsSync(join(rootPath, "agents")),
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
        entries = readdirSync(dir);
    } catch {
        return [];
    }

    const plugins: DiscoveredPlugin[] = [];

    for (const entry of entries) {
        if (entry.startsWith(".")) continue;

        const entryPath = join(dir, entry);
        try {
            if (!statSync(entryPath).isDirectory()) continue;
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
 * @param cwd - Project working directory
 * @param opts.includeProjectLocal - If true, include project-local plugin dirs
 *   (default: false — project-local plugins can run arbitrary code)
 * @param opts.extraDirs - Additional directories to scan
 */
export function discoverPlugins(cwd: string, opts?: { includeProjectLocal?: boolean; extraDirs?: string[] }): DiscoveredPlugin[] {
    const dirs = pluginSearchDirs(cwd, opts);
    const seen = new Set<string>();
    const plugins: DiscoveredPlugin[] = [];

    for (const dir of dirs) {
        for (const plugin of scanPluginsDir(dir)) {
            if (!seen.has(plugin.name)) {
                seen.add(plugin.name);
                plugins.push(plugin);
            }
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
export function matchesTool(matcher: string | undefined, toolName: string, toolInput?: Record<string, unknown>): boolean {
    if (!matcher) return true; // No matcher = match all

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
export function scanAllPluginInfo(cwd: string, opts?: { includeProjectLocal?: boolean; extraDirs?: string[] }): PluginInfo[] {
    return discoverPlugins(cwd, opts).map(toPluginInfo);
}
