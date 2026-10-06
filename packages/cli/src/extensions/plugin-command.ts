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
import { dirInstalledPluginNames } from "../plugins/discover.js";
import { resolveAgentDir, resolveExplicitProjectTrust } from "../config/io.js";
import { packageManagerFor } from "../overlay/resolve.js";
import {
    buildMarketplaceCatalog,
    buildPluginsOverview,
    type MarketplaceCatalogInfo,
    type PluginsOverview,
} from "../plugins/info.js";

/** pi event-bus channel + relay event type for structured `/plugin` results. */
export const PLUGIN_COMMAND_RESULT_CHANNEL = "plugin:command_result";
export const PLUGIN_COMMAND_RESULT_EVENT = "plugin_command_result";

const USAGE = [
    "Usage:",
    "  /plugin marketplace add <owner/repo | git-url | path>",
    "  /plugin marketplace list",
    "  /plugin marketplace show <name>",
    "  /plugin marketplace remove <name>",
    "  /plugin install <name[@marketplace]>",
    "  /plugin uninstall <name[@marketplace]>",
    "  /plugin enable|disable <name[@marketplace]>",
    "  /plugin package list|install|remove|update [source] [--local]",
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

export interface PluginCommandResult {
    /** Full text for terminal output. */
    output: string;
    /** True when plugin/marketplace state on disk changed. */
    changed: boolean;
    /** Short status line (e.g. "Installed x@y"); absent for plain listings. */
    notice?: string;
    /** Marketplace whose catalog the result shows (add/show). */
    catalog?: string;
    /** Usage error or no-op on an unknown target. */
    isError?: boolean;
}

/** A configured pi package (extensions, skills, prompts, themes). */
export interface PiPackageInfo {
    source: string;
    scope: "user" | "project";
    filtered: boolean;
    installedPath?: string;
}

/** Structured payload rendered by the web UI's plugins card. */
export interface PluginCommandView {
    notice?: string;
    isError?: boolean;
    changed: boolean;
    overview: PluginsOverview & {
        packages: PiPackageInfo[];
        /** Project dir that `--local` package installs target; absent at runner level. */
        packagesCwd?: string;
    };
    catalog?: MarketplaceCatalogInfo;
}

/** The slice of pi's DefaultPackageManager `/plugin package` uses (injectable for tests). */
export interface PiPackageManager {
    listConfiguredPackages(): Array<{ source: string; scope: "user" | "project"; filtered: boolean; installedPath?: string }>;
    installAndPersist(source: string, options?: { local?: boolean }): Promise<void>;
    removeAndPersist(source: string, options?: { local?: boolean }): Promise<boolean>;
    update(source?: string): Promise<void>;
}

function defaultPackageManager(cwd: string): PiPackageManager {
    const agentDir = resolveAgentDir(cwd);
    return packageManagerFor(cwd, agentDir, resolveExplicitProjectTrust(cwd, agentDir));
}

function listPiPackages(pm: PiPackageManager): PiPackageInfo[] {
    try {
        return pm.listConfiguredPackages().map(({ source, scope, filtered, installedPath }) => ({ source, scope, filtered, installedPath }));
    } catch {
        return [];
    }
}

const PACKAGE_USAGE = [
    "Usage:",
    "  /plugin package list",
    "  /plugin package install <source> [--local]",
    "  /plugin package remove <source> [--local]",
    "  /plugin package update [source]",
].join("\n");

function formatPackages(packages: PiPackageInfo[]): string {
    if (packages.length === 0) return "No pi packages configured. Add one with /plugin package install <source>";
    return [`Pi packages (${packages.length}):`, ...packages.map((p) => `  ${p.source}  (${p.scope})`)].join("\n");
}

/** `/plugin package …` — pi package management (args exclude the leading "package"). */
export async function runPiPackageCommand(args: string[], pm: PiPackageManager): Promise<PluginCommandResult> {
    const [action, ...rest] = args;
    const local = rest.includes("--local") || rest.includes("-l");
    const source = rest.filter((a) => a !== "--local" && a !== "-l").join(" ").trim();
    const where = local ? " (project)" : "";

    if (!action || action === "list") return { output: formatPackages(listPiPackages(pm)), changed: false };

    if (action === "install" || action === "add") {
        if (!source) return failure("Usage: /plugin package install <source> [--local]");
        await pm.installAndPersist(source, { local });
        return result(`Installed package ${source}${where}`, true);
    }

    if (action === "remove" || action === "uninstall" || action === "rm") {
        if (!source) return failure("Usage: /plugin package remove <source> [--local]");
        return (await pm.removeAndPersist(source, { local }))
            ? result(`Removed package ${source}${where}`, true)
            : failure(`Package not configured: ${source}${where}`);
    }

    if (action === "update") {
        await pm.update(source || undefined);
        return result(source ? `Updated package ${source}` : "Updated all packages", true);
    }

    return failure(PACKAGE_USAGE);
}

function result(notice: string | undefined, changed: boolean, catalog?: string): PluginCommandResult {
    const body = catalog ? formatCatalog(catalog) : notice ? "" : formatOverview();
    return { output: [notice, body].filter(Boolean).join("\n\n"), changed, notice, catalog };
}

function failure(notice: string): PluginCommandResult {
    return { ...result(notice, false), isError: true };
}

/** Resolve an enable/disable target. Directory-installed plugins are keyed by bare name. */
function resolveToggleKey(target: string, cwd?: string): string {
    if (!target.includes("@") && dirInstalledPluginNames(cwd, { includeProjectLocal: !!cwd }).includes(target)) {
        return target;
    }
    return resolvePluginKey(target);
}

/** Run one `/plugin` invocation. Throws on failed mutations. */
export function runPluginCommand(args: string[], cwd?: string): PluginCommandResult {
    const [sub, ...rest] = args;

    if (!sub || sub === "list") return result(undefined, false);

    if (sub === "marketplace" || sub === "marketplaces") {
        const action = rest[0];
        const target = rest.slice(1).join(" ").trim();

        if (!action || action === "list") return result(undefined, false);

        if (action === "add") {
            if (!target) return failure("Usage: /plugin marketplace add <owner/repo | git-url | path>");
            const added = addMarketplace(target);
            return result(`Added marketplace "${added.name}" (${added.pluginCount} plugins)`, true, added.name);
        }

        if (action === "remove" || action === "rm") {
            if (!target) return failure("Usage: /plugin marketplace remove <name>");
            return removeMarketplace(target)
                ? result(`Removed marketplace "${target}"`, true)
                : failure(`Unknown marketplace: ${target}`);
        }

        if (action === "show" || action === "plugins") {
            if (!target) return failure("Usage: /plugin marketplace show <name>");
            if (!readMarketplaceCatalog(target)) return failure(`Unknown marketplace: ${target}`);
            return result(undefined, false, target);
        }

        return failure(USAGE);
    }

    const target = rest.join(" ").trim();

    if (sub === "install" || sub === "add") {
        if (!target) return failure("Usage: /plugin install <name[@marketplace]>");
        const installed = installPlugin(target);
        // Keep showing the catalog so the user can carry on browsing.
        return result(`Installed ${installed.plugin}@${installed.marketplace} → ${installed.installPath}`, true, installed.marketplace);
    }

    if (sub === "uninstall" || sub === "remove" || sub === "rm") {
        if (!target) return failure("Usage: /plugin uninstall <name[@marketplace]>");
        return uninstallPlugin(target) ? result(`Uninstalled ${target}`, true) : failure(`Not installed: ${target}`);
    }

    if (sub === "enable" || sub === "disable") {
        if (!target) return failure(`Usage: /plugin ${sub} <name[@marketplace]>`);
        const key = resolveToggleKey(target, cwd);
        setPluginEnabled(key, sub === "enable");
        return result(`${sub === "enable" ? "Enabled" : "Disabled"} ${key}`, true);
    }

    return failure(USAGE);
}

/**
 * Run `/plugin` and build the structured view the web UI renders. Never throws:
 * failures come back as `isError` with the current overview.
 */
export async function runPluginCommandView(
    args: string[],
    cwd?: string,
    deps?: { packageManager?: PiPackageManager },
): Promise<PluginCommandView & { output: string }> {
    const scan = { includeProjectLocal: !!cwd };
    let pm: PiPackageManager | undefined = deps?.packageManager;
    const overview = (): PluginCommandView["overview"] => {
        try {
            pm ??= defaultPackageManager(cwd ?? process.cwd());
        } catch {
            // Unreadable pi settings — show plugins without packages.
        }
        return { ...buildPluginsOverview(cwd, scan), packages: pm ? listPiPackages(pm) : [], packagesCwd: cwd };
    };
    try {
        const isPackage = args[0] === "package" || args[0] === "packages";
        const r = isPackage
            ? await runPiPackageCommand(args.slice(1), (pm ??= defaultPackageManager(cwd ?? process.cwd())))
            : runPluginCommand(args, cwd);
        const catalog = r.catalog ? buildMarketplaceCatalog(r.catalog) ?? undefined : undefined;
        return {
            output: r.output,
            notice: r.notice,
            isError: r.isError,
            changed: r.changed,
            overview: overview(),
            catalog,
        };
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
            output: `/plugin failed: ${message}`,
            notice: message,
            isError: true,
            changed: false,
            overview: overview(),
        };
    }
}

const SUBCOMMANDS = [
    { value: "marketplace", label: "marketplace", description: "Add, list, or remove marketplaces" },
    { value: "install", label: "install", description: "Install a plugin from a marketplace" },
    { value: "uninstall", label: "uninstall", description: "Remove an installed plugin" },
    { value: "enable", label: "enable", description: "Enable an installed plugin" },
    { value: "disable", label: "disable", description: "Disable an installed plugin" },
    { value: "list", label: "list", description: "List marketplaces and installed plugins" },
    { value: "package", label: "package", description: "Manage pi packages: list, install, remove, update" },
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
            const view = await runPluginCommandView(args, ctx?.cwd);
            // The remote extension forwards this to the web UI as a structured
            // card and flags it handled (EventBus delivery is synchronous).
            const event = { type: PLUGIN_COMMAND_RESULT_EVENT, ...view, handled: false };
            pi.events.emit(PLUGIN_COMMAND_RESULT_CHANNEL, event);
            const isTui = ctx?.hasUI && ctx?.mode === "tui";
            if (!event.handled || isTui) ctx?.ui?.notify?.(view.output, view.isError ? "error" : "info");
            // Pick up newly installed commands, skills, and hooks right away.
            if (view.changed) await ctx.reload();
        },
    });
};
