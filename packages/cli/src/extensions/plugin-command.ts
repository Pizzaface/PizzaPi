/**
 * `/plugin` — Claude Code marketplace management from inside a session.
 *
 *   /plugin                              List marketplaces and installed plugins
 *   /plugin marketplace add <source>     Add a marketplace (owner/repo, git URL, local path)
 *   /plugin marketplace list
 *   /plugin marketplace remove <name>
 *   /plugin install <name[@marketplace]>
 *   /plugin uninstall <name[@marketplace]>
 *   /plugin enable|disable <name[@marketplace]>
 *
 * Mutations reload session resources so newly installed commands/skills are
 * usable immediately. State lives in Claude Code's own files (see marketplace.ts).
 */

import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import {
    addMarketplace,
    installPlugin,
    listInstalledPlugins,
    listMarketplaces,
    readMarketplaceCatalog,
    removeMarketplace,
    resolvePluginKey,
    setPluginEnabled,
    uninstallPlugin,
} from "../plugins/marketplace.js";

const USAGE = [
    "Usage:",
    "  /plugin marketplace add <owner/repo | git-url | path>",
    "  /plugin marketplace list",
    "  /plugin marketplace remove <name>",
    "  /plugin install <name[@marketplace]>",
    "  /plugin uninstall <name[@marketplace]>",
    "  /plugin enable|disable <name[@marketplace]>",
].join("\n");

function formatOverview(): string {
    const markets = listMarketplaces();
    const installed = listInstalledPlugins();
    const lines: string[] = [];

    const names = Object.keys(markets);
    lines.push(names.length ? `Marketplaces (${names.length}):` : "No marketplaces. Add one with /plugin marketplace add <source>");
    for (const name of names) {
        const count = readMarketplaceCatalog(name)?.plugins.length ?? 0;
        lines.push(`  ${name} — ${count} plugin${count === 1 ? "" : "s"}`);
    }

    lines.push("");
    lines.push(installed.length ? `Installed plugins (${installed.length}):` : "No plugins installed.");
    for (const p of installed) {
        lines.push(`  ${p.key}${p.enabled ? "" : "  (disabled)"}`);
    }
    return lines.join("\n");
}

function formatCatalog(name: string): string {
    const catalog = readMarketplaceCatalog(name);
    if (!catalog) return `Unknown marketplace: ${name}`;
    const installed = new Set(listInstalledPlugins().map((p) => p.key));
    const lines = [`${catalog.name} — ${catalog.plugins.length} plugin${catalog.plugins.length === 1 ? "" : "s"}`];
    for (const p of catalog.plugins) {
        const mark = installed.has(`${p.name}@${name}`) ? "✓ " : "  ";
        lines.push(`${mark}${p.name}${p.description ? ` — ${p.description.split("\n")[0].slice(0, 80)}` : ""}`);
    }
    return lines.join("\n");
}

/** Run one `/plugin` invocation. Returns the text to show the user. */
export function runPluginCommand(args: string[]): { output: string; changed: boolean } {
    const [sub, ...rest] = args;

    if (!sub) return { output: formatOverview(), changed: false };

    if (sub === "marketplace" || sub === "marketplaces") {
        const action = rest[0];
        const target = rest.slice(1).join(" ").trim();

        if (!action || action === "list") return { output: formatOverview(), changed: false };

        if (action === "add") {
            if (!target) return { output: "Usage: /plugin marketplace add <owner/repo | git-url | path>", changed: false };
            const result = addMarketplace(target);
            return {
                output: `Added marketplace "${result.name}" (${result.pluginCount} plugins)\n\n${formatCatalog(result.name)}`,
                changed: true,
            };
        }

        if (action === "remove" || action === "rm") {
            if (!target) return { output: "Usage: /plugin marketplace remove <name>", changed: false };
            const removed = removeMarketplace(target);
            return { output: removed ? `Removed marketplace "${target}"` : `Unknown marketplace: ${target}`, changed: removed };
        }

        if (action === "show" || action === "plugins") {
            if (!target) return { output: "Usage: /plugin marketplace show <name>", changed: false };
            return { output: formatCatalog(target), changed: false };
        }

        return { output: USAGE, changed: false };
    }

    const target = rest.join(" ").trim();

    if (sub === "install" || sub === "add") {
        if (!target) return { output: "Usage: /plugin install <name[@marketplace]>", changed: false };
        const result = installPlugin(target);
        return { output: `Installed ${result.plugin}@${result.marketplace} → ${result.installPath}`, changed: true };
    }

    if (sub === "uninstall" || sub === "remove" || sub === "rm") {
        if (!target) return { output: "Usage: /plugin uninstall <name[@marketplace]>", changed: false };
        const removed = uninstallPlugin(target);
        return { output: removed ? `Uninstalled ${target}` : `Not installed: ${target}`, changed: removed };
    }

    if (sub === "enable" || sub === "disable") {
        if (!target) return { output: `Usage: /plugin ${sub} <name[@marketplace]>`, changed: false };
        const key = resolvePluginKey(target);
        setPluginEnabled(key, sub === "enable");
        return { output: `${sub === "enable" ? "Enabled" : "Disabled"} ${key}`, changed: true };
    }

    if (sub === "list") return { output: formatOverview(), changed: false };

    return { output: USAGE, changed: false };
}

const SUBCOMMANDS = [
    { value: "marketplace", label: "marketplace", description: "Add, list, or remove marketplaces" },
    { value: "install", label: "install", description: "Install a plugin from a marketplace" },
    { value: "uninstall", label: "uninstall", description: "Remove an installed plugin" },
    { value: "enable", label: "enable", description: "Enable an installed plugin" },
    { value: "disable", label: "disable", description: "Disable an installed plugin" },
    { value: "list", label: "list", description: "List marketplaces and installed plugins" },
];

export const pluginCommandExtension: ExtensionFactory = (pi) => {
    pi.registerCommand("plugin", {
        description: "Manage Claude Code plugin marketplaces: marketplace add/list/remove, install, uninstall, enable, disable",
        getArgumentCompletions: (prefix: string) => {
            const parts = prefix.trimStart().split(/\s+/);
            if (parts.length <= 1) {
                const p = (parts[0] ?? "").toLowerCase();
                const filtered = p ? SUBCOMMANDS.filter((o) => o.value.startsWith(p)) : SUBCOMMANDS;
                return filtered.length ? filtered : null;
            }
            if (parts[0] === "marketplace" && parts.length === 2) {
                const actions = [
                    { value: "marketplace add", label: "add", description: "Add a marketplace" },
                    { value: "marketplace list", label: "list", description: "List marketplaces" },
                    { value: "marketplace remove", label: "remove", description: "Remove a marketplace" },
                    { value: "marketplace show", label: "show", description: "Show a marketplace's plugins" },
                ];
                const p = parts[1].toLowerCase();
                const filtered = p ? actions.filter((o) => o.label.startsWith(p)) : actions;
                return filtered.length ? filtered : null;
            }
            // Plugin-name position — offer installed plugins and catalog entries.
            if (["install", "uninstall", "enable", "disable"].includes(parts[0]) && parts.length === 2) {
                const p = parts[1].toLowerCase();
                const keys = new Set(listInstalledPlugins().map((x) => x.key));
                for (const market of Object.keys(listMarketplaces())) {
                    for (const entry of readMarketplaceCatalog(market)?.plugins ?? []) {
                        keys.add(`${entry.name}@${market}`);
                    }
                }
                const options = [...keys]
                    .filter((k) => !p || k.toLowerCase().startsWith(p))
                    .slice(0, 50)
                    .map((k) => ({ value: `${parts[0]} ${k}`, label: k }));
                return options.length ? options : null;
            }
            return null;
        },
        handler: async (rawArgs: string, ctx: any) => {
            const args = (rawArgs ?? "").trim().split(/\s+/).filter(Boolean);
            let result: { output: string; changed: boolean };
            try {
                result = runPluginCommand(args);
            } catch (err) {
                ctx?.ui?.notify?.(`/plugin failed: ${err instanceof Error ? err.message : String(err)}`);
                return;
            }
            ctx?.ui?.notify?.(result.output);
            // Pick up newly installed commands, skills, and hooks right away.
            if (result.changed) await ctx.reload();
        },
    });
};
