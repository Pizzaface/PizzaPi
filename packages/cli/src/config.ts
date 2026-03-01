import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

/** A single hook entry — a shell command to run at a lifecycle point. */
export interface HookEntry {
    /** Shell command to execute. Receives JSON on stdin. */
    command: string;
    /** Timeout in milliseconds. Default: 10000 (10s). */
    timeout?: number;
}

/** A matcher group — binds a tool name pattern to one or more hooks. */
export interface HookMatcher {
    /**
     * Tool name pattern to match. Supports `|` for alternation.
     * Examples: "Bash", "Edit|Write", "Read".
     * Use ".*" to match all tools.
     */
    matcher: string;
    /** Hooks to run when the matcher matches. */
    hooks: HookEntry[];
}

/** Hook configuration — shell scripts that run at tool lifecycle points. */
export interface HooksConfig {
    /** Hooks that fire BEFORE a tool executes. Can block or inject context. */
    PreToolUse?: HookMatcher[];
    /** Hooks that fire AFTER a tool executes. Can inject context. */
    PostToolUse?: HookMatcher[];
}

export interface PizzaPiConfig {
    /** Override the default system prompt */
    systemPrompt?: string;
    /** Global agent config directory. Default: ~/.pizzapi */
    agentDir?: string;
    /** Prepend text to the system prompt without replacing it */
    appendSystemPrompt?: string;
    /** API key for authenticating with the PizzaPi relay server */
    apiKey?: string;
    /** WebSocket URL of the PizzaPi relay server. Default: ws://localhost:3001 */
    relayUrl?: string;
    /**
     * Additional skill paths to load (files or directories).
     * Merged on top of the default ~/.pizzapi/skills/ and .pizzapi/skills/ locations.
     * Supports ~ expansion and absolute paths.
     */
    skills?: string[];
    /**
     * Shell-script hooks that fire at tool lifecycle points.
     * Inspired by Claude Code hooks: scripts receive JSON on stdin,
     * exit 0 to allow (with optional additionalContext), exit 2 to block.
     */
    hooks?: HooksConfig;
    /**
     * Trust gate: allow project-local hooks (.pizzapi/config.json) to run.
     * Must be set in the GLOBAL ~/.pizzapi/config.json (or via
     * PIZZAPI_ALLOW_PROJECT_HOOKS=1 env var). Project configs cannot
     * self-authorize.
     *
     * When false/unset, only hooks from ~/.pizzapi/config.json (global) run.
     */
    allowProjectHooks?: boolean;
}

function readJsonSafe(path: string): Partial<PizzaPiConfig> {
    if (!existsSync(path)) return {};
    try {
        return JSON.parse(readFileSync(path, "utf-8"));
    } catch {
        return {};
    }
}

/** Deep-merge hooks: concatenate matcher arrays from both sources. */
export function mergeHooks(a?: HooksConfig, b?: HooksConfig): HooksConfig | undefined {
    if (!a && !b) return undefined;
    const merged: HooksConfig = {};
    const pre = [...(a?.PreToolUse ?? []), ...(b?.PreToolUse ?? [])];
    const post = [...(a?.PostToolUse ?? []), ...(b?.PostToolUse ?? [])];
    if (pre.length > 0) merged.PreToolUse = pre;
    if (post.length > 0) merged.PostToolUse = post;
    return Object.keys(merged).length > 0 ? merged : undefined;
}

/**
 * Check whether project-local hooks are trusted.
 * Trust must come from the global config or the environment — never from
 * the project config itself (that would be a self-authorization bypass).
 */
export function isProjectHooksTrusted(globalConfig: Partial<PizzaPiConfig>): boolean {
    if (process.env.PIZZAPI_ALLOW_PROJECT_HOOKS === "1") return true;
    return globalConfig.allowProjectHooks === true;
}

/**
 * Load PizzaPi config from:
 *   1. ~/.pizzapi/config.json  (global)
 *   2. <cwd>/.pizzapi/config.json  (project-local, wins on conflict)
 *
 * Hooks: global hooks always run. Project hooks only run when explicitly
 * trusted via `allowProjectHooks: true` in the global config or the
 * PIZZAPI_ALLOW_PROJECT_HOOKS=1 env var.
 */
export function loadConfig(cwd: string = process.cwd()): PizzaPiConfig {
    const globalPath = join(homedir(), ".pizzapi", "config.json");
    const projectPath = join(cwd, ".pizzapi", "config.json");
    const global = readJsonSafe(globalPath);
    const project = readJsonSafe(projectPath);

    // Trust gate: project hooks require explicit authorization from global config
    const projectHooksTrusted = isProjectHooksTrusted(global);
    const projectHooks = projectHooksTrusted ? project.hooks : undefined;
    if (project.hooks && !projectHooksTrusted) {
        console.warn(
            "[hooks] Project hooks found in .pizzapi/config.json but not trusted. " +
                'Set "allowProjectHooks": true in ~/.pizzapi/config.json or ' +
                "PIZZAPI_ALLOW_PROJECT_HOOKS=1 to enable.",
        );
    }

    const hooks = mergeHooks(global.hooks, projectHooks);
    const config = { ...global, ...project };
    if (hooks) config.hooks = hooks;
    else delete config.hooks;
    return config;
}

export function expandHome(path: string): string {
    return path.replace(/^~/, homedir());
}

export function defaultAgentDir(): string {
    return join(homedir(), ".pizzapi");
}

/**
 * Merge fields into ~/.pizzapi/config.json (global config).
 */
export function saveGlobalConfig(fields: Partial<PizzaPiConfig>): void {
    const dir = join(homedir(), ".pizzapi");
    const path = join(dir, "config.json");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const existing = readJsonSafe(path);
    writeFileSync(path, JSON.stringify({ ...existing, ...fields }, null, 2), "utf-8");
}
