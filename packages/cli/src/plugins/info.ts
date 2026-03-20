/**
 * Lightweight plugin info serialization for the Web UI / API.
 */
import type { DiscoveredPlugin } from "./types.js";
import { discoverPlugins } from "./discover.js";

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
