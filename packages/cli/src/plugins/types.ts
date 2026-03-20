/**
 * Shared types, constants, and low-level utilities for the Claude Code
 * plugin adapter.
 *
 * Imported by all other plugin-* modules.
 */
import { statSync, readFileSync } from "node:fs";

// ── Constants ─────────────────────────────────────────────────────────────────

/** Maximum size (bytes) for individual plugin files (commands, hooks, rules).
 *  Files exceeding this are skipped to prevent DoS from oversized local plugins. */
export const MAX_PLUGIN_FILE_SIZE = 2 * 1024 * 1024; // 2 MB

/** Maximum number of entries (files) per plugin subdirectory (commands, hooks, rules, skills).
 *  Limits CPU/IO during discovery of untrusted local plugins. */
export const MAX_ENTRIES_PER_DIR = 200;

/** Read a file only if it's within the size limit. Returns null if too large or unreadable. */
export function readFileCapped(path: string, maxBytes: number = MAX_PLUGIN_FILE_SIZE): string | null {
    try {
        const s = statSync(path);
        if (s.size > maxBytes) return null;
        return readFileSync(path, "utf-8");
    } catch {
        return null;
    }
}

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
