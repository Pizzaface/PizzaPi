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

/** Hook configuration — shell scripts that run at agent lifecycle points. */
export interface HooksConfig {
    // -- Tool lifecycle hooks (use matchers to target specific tools) --

    /** Hooks that fire BEFORE a tool executes. Can block or inject context. */
    PreToolUse?: HookMatcher[];
    /** Hooks that fire AFTER a tool executes. Can inject context. */
    PostToolUse?: HookMatcher[];

    // -- Input hooks --

    /**
     * Fires when user input is received, before skill/template expansion.
     * Can transform text, block input, or mark it as handled.
     * Exit 0 + JSON `{ text: "..." }` → rewrite input.
     * Exit 0 + JSON `{ action: "handled" }` → consume without processing.
     * Exit 2 → block input (stderr shown as reason).
     */
    Input?: HookEntry[];

    /**
     * Fires after user prompt but before the agent loop starts.
     * Can inject context or tweak the system prompt for this turn.
     * Exit 0 + JSON `{ additionalContext: "...", systemPrompt: "..." }`.
     */
    BeforeAgentStart?: HookEntry[];

    /**
     * Fires when user executes a shell command via ! or !! prefix.
     * Important for safety parity with PreToolUse:Bash.
     * Exit 2 → block the command (stderr shown as reason).
     * Exit 0 → allow.
     */
    UserBash?: HookEntry[];

    // -- Session lifecycle hooks --

    /**
     * Fires before switching to another session. Can cancel.
     * Exit 2 → cancel the switch (stderr shown as reason).
     */
    SessionBeforeSwitch?: HookEntry[];

    /**
     * Fires before forking a session. Can cancel.
     * Exit 2 → cancel the fork (stderr shown as reason).
     */
    SessionBeforeFork?: HookEntry[];

    /**
     * Fires on process exit. Best-effort cleanup/checkpoint.
     * Exit code is ignored (the process is shutting down).
     */
    SessionShutdown?: HookEntry[];

    // -- Second wave hooks --

    /**
     * Fires before context compaction. Can cancel.
     * Exit 2 → cancel compaction (stderr shown as reason).
     */
    SessionBeforeCompact?: HookEntry[];

    /**
     * Fires before navigating in the session tree. Can cancel.
     * Exit 2 → cancel navigation (stderr shown as reason).
     */
    SessionBeforeTree?: HookEntry[];

    /**
     * Fires when a model is selected (observability).
     * Exit code is ignored.
     */
    ModelSelect?: HookEntry[];
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
    /** WebSocket URL of the PizzaPi relay server. Default: ws://localhost:7492. Set to "off" to disable relay entirely. */
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

    /**
     * Project-local Claude Code plugins that have been explicitly trusted.
     * Each entry is the absolute path to the plugin root directory.
     *
     * Must be set in the GLOBAL ~/.pizzapi/config.json — project configs
     * cannot self-authorize (same pattern as allowProjectHooks).
     *
     * Managed via `pizza plugins trust <path>` / `pizza plugins untrust <path>`.
     */
    trustedPlugins?: string[];
}

function readJsonSafe(path: string): Partial<PizzaPiConfig> {
    if (!existsSync(path)) return {};
    try {
        return JSON.parse(readFileSync(path, "utf-8"));
    } catch {
        return {};
    }
}

/** Deep-merge hooks: concatenate arrays from both sources for every hook type. */
export function mergeHooks(a?: HooksConfig, b?: HooksConfig): HooksConfig | undefined {
    if (!a && !b) return undefined;
    const merged: HooksConfig = {};

    // Matcher-based hooks (PreToolUse / PostToolUse)
    const pre = [...(a?.PreToolUse ?? []), ...(b?.PreToolUse ?? [])];
    const post = [...(a?.PostToolUse ?? []), ...(b?.PostToolUse ?? [])];
    if (pre.length > 0) merged.PreToolUse = pre;
    if (post.length > 0) merged.PostToolUse = post;

    // Entry-based hooks — concatenate arrays from both sources
    const entryKeys: (keyof HooksConfig)[] = [
        "Input",
        "BeforeAgentStart",
        "UserBash",
        "SessionBeforeSwitch",
        "SessionBeforeFork",
        "SessionShutdown",
        "SessionBeforeCompact",
        "SessionBeforeTree",
        "ModelSelect",
    ];
    for (const key of entryKeys) {
        const combined = [
            ...((a?.[key] as HookEntry[] | undefined) ?? []),
            ...((b?.[key] as HookEntry[] | undefined) ?? []),
        ];
        if (combined.length > 0) {
            (merged as any)[key] = combined;
        }
    }

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

// ── Plugin trust helpers ──────────────────────────────────────────────────────

/**
 * Read the global trusted plugins list.
 * Returns the normalized list of absolute plugin root paths.
 */
export function getTrustedPlugins(): string[] {
    const globalPath = join(homedir(), ".pizzapi", "config.json");
    const global = readJsonSafe(globalPath);
    return Array.isArray(global.trustedPlugins) ? global.trustedPlugins.filter((p): p is string => typeof p === "string") : [];
}

/**
 * Check whether a plugin at the given root path is in the trust list.
 */
export function isPluginTrusted(pluginRootPath: string): boolean {
    const resolved = pluginRootPath.replace(/\/+$/, ""); // strip trailing slashes
    return getTrustedPlugins().some((p) => p.replace(/\/+$/, "") === resolved);
}

/**
 * Add a plugin root path to the global trust list.
 * Returns true if it was added (false if already present).
 */
export function trustPlugin(pluginRootPath: string): boolean {
    const resolved = pluginRootPath.replace(/\/+$/, "");
    const list = getTrustedPlugins();
    if (list.some((p) => p.replace(/\/+$/, "") === resolved)) return false;
    list.push(resolved);
    saveGlobalConfig({ trustedPlugins: list });
    return true;
}

/**
 * Remove a plugin root path from the global trust list.
 * Returns true if it was removed (false if not found).
 */
export function untrustPlugin(pluginRootPath: string): boolean {
    const resolved = pluginRootPath.replace(/\/+$/, "");
    const list = getTrustedPlugins();
    const filtered = list.filter((p) => p.replace(/\/+$/, "") !== resolved);
    if (filtered.length === list.length) return false;
    saveGlobalConfig({ trustedPlugins: filtered });
    return true;
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
