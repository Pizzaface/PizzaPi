import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

import {
    type PizzaPiConfig,
    type HooksConfig,
    type HookEntry,
    isPlainObject,
} from "./config-types.js";
import { mergeSandboxConfig } from "./sandbox.js";

// ── Internal helpers ──────────────────────────────────────────────────────────

function readJsonSafe(path: string): Partial<PizzaPiConfig> {
    if (!existsSync(path)) return {};
    try {
        return JSON.parse(readFileSync(path, "utf-8"));
    } catch {
        return {};
    }
}

// ── Global config directory ───────────────────────────────────────────────────

/**
 * Returns the global PizzaPi config directory path.
 * Tests can override this via _setGlobalConfigDir() since Bun caches os.homedir().
 */
let _globalConfigDirOverride: string | null = null;
export function globalConfigDir(): string {
    return _globalConfigDirOverride ?? join(homedir(), ".pizzapi");
}

/** Test-only: override the global config directory (Bun caches os.homedir()). */
export function _setGlobalConfigDir(dir: string | null): void {
    _globalConfigDirOverride = dir;
}

// ── Hooks helpers ─────────────────────────────────────────────────────────────

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

// ── Config loading ────────────────────────────────────────────────────────────

/**
 * Load only the global config from `~/.pizzapi/config.json` without merging
 * project-local overrides.  Useful when the caller needs the raw user-level
 * settings (e.g. for the sandbox settings editor).
 */
export function loadGlobalConfig(): Partial<PizzaPiConfig> {
    const globalPath = join(globalConfigDir(), "config.json");
    return readJsonSafe(globalPath);
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
    const globalPath = join(globalConfigDir(), "config.json");
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

    // Merge sandbox config securely — project cannot weaken global sandbox.
    // mergeSandboxConfig ensures: deny lists union, allow lists intersect,
    // mode/enabled cannot be relaxed by a project config.
    if (global.sandbox || project.sandbox) {
        config.sandbox = mergeSandboxConfig(
            global.sandbox ?? {},
            project.sandbox ?? {},
        );
    }

    // Deep-merge mcpServers (Claude Code compatibility format) from both scopes.
    // Project entries win on name conflicts, but global servers are preserved.
    // mcpServers is not in the PizzaPiConfig type — it flows through as untyped JSON.
    const globalMcpServers = isPlainObject((global as any).mcpServers) ? (global as any).mcpServers : undefined;
    const projectMcpServers = isPlainObject((project as any).mcpServers) ? (project as any).mcpServers : undefined;
    if (globalMcpServers || projectMcpServers) {
        (config as any).mcpServers = { ...globalMcpServers, ...projectMcpServers };
    }

    // Deep-merge mcp.servers (preferred array format) from both scopes.
    // Project entries win on name conflicts (matched by server name).
    const globalMcp = isPlainObject((global as any).mcp) ? (global as any).mcp : undefined;
    const projectMcp = isPlainObject((project as any).mcp) ? (project as any).mcp : undefined;
    if (globalMcp || projectMcp) {
        const globalServers: any[] = Array.isArray(globalMcp?.servers) ? globalMcp.servers : [];
        const projectServers: any[] = Array.isArray(projectMcp?.servers) ? projectMcp.servers : [];
        // Build a map keyed by server name — project entries overwrite global ones
        const serverMap = new Map<string, any>();
        for (const s of globalServers) {
            if (isPlainObject(s) && typeof s.name === "string") serverMap.set(s.name, s);
        }
        for (const s of projectServers) {
            if (isPlainObject(s) && typeof s.name === "string") serverMap.set(s.name, s);
        }
        (config as any).mcp = {
            ...globalMcp,
            ...projectMcp,
            servers: [...serverMap.values()],
        };
    }

    // Merge disabledMcpServers from both scopes (union).
    // Guard with Array.isArray — a malformed config value (e.g. a string or
    // object) would throw or spread into characters without this check.
    const globalDisabledRaw = Array.isArray(global.disabledMcpServers) ? global.disabledMcpServers : [];
    const projectDisabledRaw = Array.isArray(project.disabledMcpServers) ? project.disabledMcpServers : [];
    const disabledMcpServers = [
        ...globalDisabledRaw,
        ...projectDisabledRaw,
    ].filter((s): s is string => typeof s === "string");
    if (disabledMcpServers.length > 0) {
        config.disabledMcpServers = [...new Set(disabledMcpServers)];
    } else {
        delete config.disabledMcpServers;
    }

    return config;
}

// ── Path utilities ────────────────────────────────────────────────────────────

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
    const globalPath = join(globalConfigDir(), "config.json");
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

// ── Provider settings ─────────────────────────────────────────────────────────

/**
 * Bridge providerSettings from config.json to env vars consumed by the
 * pi-ai Anthropic patch. Env vars take precedence if already set.
 * Call this early in both CLI and worker entry points.
 */
export function applyProviderSettingsEnv(config: PizzaPiConfig): void {
    const ws = config.providerSettings?.anthropic?.webSearch;
    if (ws?.enabled && !process.env.PIZZAPI_WEB_SEARCH) {
        process.env.PIZZAPI_WEB_SEARCH = "1";
    }
    if (ws?.maxUses != null && !process.env.PIZZAPI_WEB_SEARCH_MAX_USES) {
        process.env.PIZZAPI_WEB_SEARCH_MAX_USES = String(ws.maxUses);
    }
    if (ws?.allowedDomains?.length && !process.env.PIZZAPI_WEB_SEARCH_ALLOWED_DOMAINS) {
        process.env.PIZZAPI_WEB_SEARCH_ALLOWED_DOMAINS = ws.allowedDomains.join(",");
    }
    if (ws?.blockedDomains?.length && !process.env.PIZZAPI_WEB_SEARCH_BLOCKED_DOMAINS) {
        process.env.PIZZAPI_WEB_SEARCH_BLOCKED_DOMAINS = ws.blockedDomains.join(",");
    }
}

// ── Config saving ─────────────────────────────────────────────────────────────

/**
 * Merge fields into ~/.pizzapi/config.json (global config).
 */
export function saveGlobalConfig(fields: Partial<PizzaPiConfig>): void {
    const dir = globalConfigDir();
    const path = join(dir, "config.json");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const existing = readJsonSafe(path);
    writeFileSync(path, JSON.stringify({ ...existing, ...fields }, null, 2), "utf-8");
}

/**
 * Merge fields into <cwd>/.pizzapi/config.json (project-local config).
 */
export function saveProjectConfig(fields: Partial<PizzaPiConfig>, cwd: string = process.cwd()): void {
    const dir = join(cwd, ".pizzapi");
    const path = join(dir, "config.json");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const existing = readJsonSafe(path);
    writeFileSync(path, JSON.stringify({ ...existing, ...fields }, null, 2), "utf-8");
}

// ── MCP server disable/enable helpers ─────────────────────────────────────────

/**
 * Toggle an MCP server's disabled state in the project-local config.
 *
 * @param name - MCP server name to toggle
 * @param disable - true to disable, false to enable
 * @param cwd - project root directory
 * @returns Object describing the result:
 *   - `changed`: whether the config was actually modified
 *   - `globallyDisabled`: true if the server is disabled in the global config
 *     (project enable can't override)
 */
export function toggleMcpServer(
    name: string,
    disable: boolean,
    cwd: string = process.cwd(),
): { changed: boolean; globallyDisabled: boolean } {
    const globalPath = join(globalConfigDir(), "config.json");
    const globalConfig = readJsonSafe(globalPath);
    const globalDisabled = new Set(
        (Array.isArray(globalConfig.disabledMcpServers) ? globalConfig.disabledMcpServers : [])
            .filter((s): s is string => typeof s === "string"),
    );

    // If the server is already disabled globally, the project toggle is a no-op:
    //  - enable: project can't override a global disable
    //  - disable: already effective, writing a redundant local entry would
    //    create a sticky disable that survives removal of the global entry
    if (globalDisabled.has(name)) {
        return { changed: false, globallyDisabled: true };
    }

    const projectPath = join(cwd, ".pizzapi", "config.json");
    const projectConfig = readJsonSafe(projectPath);
    const current = new Set(
        (Array.isArray(projectConfig.disabledMcpServers) ? projectConfig.disabledMcpServers : [])
            .filter((s): s is string => typeof s === "string"),
    );

    const hadIt = current.has(name);
    if (disable) {
        current.add(name);
    } else {
        current.delete(name);
    }

    if (disable === hadIt) {
        return { changed: false, globallyDisabled: false };
    }

    const updated: Partial<PizzaPiConfig> = {};
    if (current.size > 0) {
        updated.disabledMcpServers = [...current];
    } else {
        // Remove the key entirely when empty
        const full = { ...projectConfig };
        delete full.disabledMcpServers;
        const dir = join(cwd, ".pizzapi");
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "config.json"), JSON.stringify(full, null, 2), "utf-8");
        return { changed: true, globallyDisabled: false };
    }

    saveProjectConfig(updated, cwd);
    return { changed: true, globallyDisabled: false };
}
