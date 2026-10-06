/**
 * Lightweight plugin info serialization for the Web UI / API.
 */
import type { DiscoveredPlugin } from "./types.js";
import { dirInstalledPluginNames, discoverPlugins, readEnabledPlugins } from "./discover.js";
import { listInstalledPlugins, listMarketplaces, readMarketplaceCatalog, type MarketplaceSource } from "./marketplace.js";

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
    /** Where it was discovered: marketplace install, ~/.pizzapi|~/.agents plugin dir, or project-local dir. */
    source?: "marketplace" | "directory" | "project";
    /** Key accepted by `/plugin enable|disable` ("name@marketplace" or bare name). */
    key?: string;
    /** Marketplace name for marketplace installs. */
    marketplace?: string;
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
        source: plugin.origin,
        key: plugin.enableKey ?? plugin.name,
        marketplace: plugin.origin === "marketplace" && plugin.enableKey?.includes("@")
            ? plugin.enableKey.slice(plugin.enableKey.lastIndexOf("@") + 1)
            : undefined,
    };
}

/**
 * Scan and return plugin info for all discovered plugins.
 */
export function scanAllPluginInfo(cwd?: string, opts?: { includeProjectLocal?: boolean; extraDirs?: string[] }): PluginInfo[] {
    return discoverPlugins(cwd, opts).map(toPluginInfo);
}

// ── Structured overview for `/plugin` and the runner panel ───────────────────

export interface DisabledPluginInfo {
    key: string;
    name: string;
    marketplace?: string;
}

export interface MarketplaceInfo {
    name: string;
    /** Human-readable source: owner/repo, git URL, or local path. */
    source: string;
    pluginCount: number;
    description?: string;
    lastUpdated?: string;
}

export interface PluginsOverview {
    /** Enabled plugins that discovery loads. */
    plugins: PluginInfo[];
    /** Installed plugins turned off via `enabledPlugins`. */
    disabled: DisabledPluginInfo[];
    marketplaces: MarketplaceInfo[];
}

export interface MarketplaceCatalogInfo {
    name: string;
    description?: string;
    plugins: Array<{
        name: string;
        key: string;
        description?: string;
        category?: string;
        installed: boolean;
        enabled: boolean;
    }>;
}

function describeSource(source: MarketplaceSource | undefined): string {
    return source?.repo ?? source?.url ?? source?.path ?? "";
}

export function buildPluginsOverview(cwd?: string, opts?: { includeProjectLocal?: boolean }): PluginsOverview {
    const plugins = scanAllPluginInfo(cwd, opts);
    const loadedKeys = new Set(plugins.map((p) => p.key));
    const enabledMap = readEnabledPlugins(cwd) ?? {};

    const disabled: DisabledPluginInfo[] = [];
    for (const p of listInstalledPlugins()) {
        if (loadedKeys.has(p.key) || (p.enabled && enabledMap[p.key] !== false)) continue;
        const at = p.key.lastIndexOf("@");
        disabled.push({ key: p.key, name: at > 0 ? p.key.slice(0, at) : p.key, marketplace: at > 0 ? p.key.slice(at + 1) : undefined });
    }
    for (const name of dirInstalledPluginNames(cwd, opts)) {
        if (!loadedKeys.has(name) && enabledMap[name] === false) disabled.push({ key: name, name });
    }

    const marketplaces = Object.entries(listMarketplaces()).map(([name, m]) => {
        const catalog = readMarketplaceCatalog(name);
        return {
            name,
            source: describeSource(m.source),
            pluginCount: catalog?.plugins.length ?? 0,
            description: catalog?.description,
            lastUpdated: m.lastUpdated,
        };
    });

    return { plugins, disabled, marketplaces };
}

export function buildMarketplaceCatalog(name: string): MarketplaceCatalogInfo | null {
    const catalog = readMarketplaceCatalog(name);
    if (!catalog) return null;
    const installed = new Map(listInstalledPlugins().map((p) => [p.key, p.enabled]));
    return {
        name,
        description: catalog.description,
        plugins: catalog.plugins.map((p) => {
            const key = `${p.name}@${name}`;
            return {
                name: p.name,
                key,
                description: p.description?.split("\n")[0],
                category: p.category,
                installed: installed.has(key),
                enabled: installed.get(key) === true,
            };
        }),
    };
}
