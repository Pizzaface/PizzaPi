/**
 * Plugin discovery — locates Claude Code plugins from global dirs,
 * project-local dirs, and Claude Code's marketplace install cache.
 */
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { expandHome } from "../config.js";
import { MAX_ENTRIES_PER_DIR, type ClaudeInstalledPluginEntry, type DiscoveredPlugin } from "./types.js";
import { isPluginDir, parsePlugin } from "./parse.js";

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
            // When cwd is undefined (runner-level / global-only scan), ALL
            // project-scoped plugins are excluded — there is no project context.
            // Uses path.relative to avoid platform-specific separator issues.
            // On Windows, cross-drive relative() returns an absolute path, so
            // we also reject when isAbsolute(rel) is true.
            if (inst.scope === "project") {
                if (!cwd || !inst.projectPath) {
                    continue;
                }
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

// ── Scanning & top-level discovery ───────────────────────────────────────────

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
