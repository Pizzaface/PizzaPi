/**
 * `pizza plugins` CLI command — discover, list, and manage trust for
 * Claude Code plugins.
 *
 * Usage:
 *   pizza plugins                  List all discovered plugins
 *   pizza plugins list             Same as above
 *   pizza plugins trust [path]     Trust a project-local plugin (by path or interactively)
 *   pizza plugins untrust [path]   Remove a plugin from the trust list
 *   pizza plugins trusted          Show the current trust list
 *   pizza plugins --help           Show help
 */
import { resolve } from "node:path";
import {
    discoverPlugins,
    scanPluginsDir,
    projectPluginDirs,
    globalPluginDirs,
    toPluginInfo,
    type DiscoveredPlugin,
} from "./plugins.js";
import {
    getTrustedPlugins,
    isPluginTrusted,
    trustPlugin,
    untrustPlugin,
} from "./config.js";
import { c } from "./cli-colors.js";
import { createLogger } from "@pizzapi/tools";

const log = createLogger("plugins");

// ── Formatting helpers ────────────────────────────────────────────────────────

function badge(label: string, count: number): string {
    return count > 0 ? `${count} ${label}` : "";
}

function pluginLine(p: DiscoveredPlugin, trusted?: boolean): string {
    const parts: string[] = [];
    const cmds = badge("cmd", p.commands.length);
    const hooks = p.hooks
        ? badge("hook", Object.values(p.hooks.hooks).flat().length)
        : "";
    const skills = badge("skill", p.skills.length);
    if (cmds) parts.push(cmds);
    if (hooks) parts.push(hooks);
    if (skills) parts.push(skills);
    if (p.hasMcp) parts.push("mcp⚠️");

    const caps = parts.length > 0 ? `  (${parts.join(", ")})` : "";
    const trustBadge = trusted === true ? " ✓ trusted" : trusted === false ? " ✗ untrusted" : "";
    return `  ${p.name}${caps}${trustBadge}\n    ${p.rootPath}`;
}

// ── Subcommands ───────────────────────────────────────────────────────────────

function listPlugins(cwd: string): void {
    const globalPlugins = discoverPlugins(cwd);
    const localDirs = projectPluginDirs(cwd);
    const localPlugins: DiscoveredPlugin[] = [];
    for (const dir of localDirs) {
        localPlugins.push(...scanPluginsDir(dir));
    }
    // Deduplicate
    const globalNames = new Set(globalPlugins.map((p) => p.name));
    const localOnly = localPlugins.filter((p) => !globalNames.has(p.name));

    if (globalPlugins.length === 0 && localOnly.length === 0) {
        log.info("No Claude Code plugins found.");
        log.info("\nSearch directories (global):");
        for (const dir of globalPluginDirs()) {
            log.info(`  ${dir}`);
        }
        if (localDirs.length > 0) {
            log.info("\nSearch directories (project-local):");
            for (const dir of localDirs) {
                log.info(`  ${dir}`);
            }
        }
        return;
    }

    if (globalPlugins.length > 0) {
        log.info(`Global plugins (auto-trusted): ${globalPlugins.length}`);
        for (const p of globalPlugins) {
            log.info(pluginLine(p));
        }
    }

    if (localOnly.length > 0) {
        if (globalPlugins.length > 0) log.info("");
        log.info(`Project-local plugins: ${localOnly.length}`);
        for (const p of localOnly) {
            log.info(pluginLine(p, isPluginTrusted(p.rootPath)));
        }
    }

    const untrustedLocal = localOnly.filter((p) => !isPluginTrusted(p.rootPath));
    if (untrustedLocal.length > 0) {
        log.info(
            `\n💡 ${untrustedLocal.length} untrusted local plugin${untrustedLocal.length > 1 ? "s" : ""}. ` +
            `Run \`pizza plugins trust <path>\` to pre-approve.`
        );
    }
}

function trustCommand(args: string[], cwd: string): void {
    if (args.length === 0) {
        // Interactive: show local plugins and let user pick
        const localDirs = projectPluginDirs(cwd);
        const localPlugins: DiscoveredPlugin[] = [];
        for (const dir of localDirs) {
            localPlugins.push(...scanPluginsDir(dir));
        }
        const untrusted = localPlugins.filter((p) => !isPluginTrusted(p.rootPath));

        if (untrusted.length === 0) {
            log.info("No untrusted project-local plugins found.");
            return;
        }

        // Trust all untrusted local plugins
        log.info(`Trusting ${untrusted.length} local plugin${untrusted.length > 1 ? "s" : ""}:`);
        for (const p of untrusted) {
            const added = trustPlugin(p.rootPath);
            log.info(`  ${added ? "✓" : "⋅"} ${p.name} → ${p.rootPath}`);
        }
        log.info("\nPlugins will auto-load on next session start.");
        return;
    }

    // Trust a specific path
    const target = resolve(cwd, args[0]);
    const plugins = scanPluginsDir(target);
    if (plugins.length > 0) {
        // Path is a plugins directory — trust all plugins in it
        for (const p of plugins) {
            const added = trustPlugin(p.rootPath);
            log.info(`${added ? "✓ Trusted" : "⋅ Already trusted"}: ${p.name} (${p.rootPath})`);
        }
    } else {
        // Path might be a single plugin directory
        const added = trustPlugin(target);
        if (added) {
            log.info(`✓ Trusted: ${target}`);
        } else {
            log.info(`⋅ Already trusted: ${target}`);
        }
    }
}

function untrustCommand(args: string[], cwd: string): void {
    if (args.length === 0) {
        const list = getTrustedPlugins();
        if (list.length === 0) {
            log.info("No plugins in the trust list.");
            return;
        }
        // Remove all
        for (const p of [...list]) {
            untrustPlugin(p);
        }
        log.info(`Removed ${list.length} plugin${list.length > 1 ? "s" : ""} from the trust list.`);
        return;
    }

    const target = resolve(cwd, args[0]);
    const removed = untrustPlugin(target);
    if (removed) {
        log.info(`✓ Removed from trust list: ${target}`);
    } else {
        log.info(`⋅ Not in trust list: ${target}`);
    }
}

function showTrusted(): void {
    const list = getTrustedPlugins();
    if (list.length === 0) {
        log.info("No plugins in the trust list.");
        log.info('Use `pizza plugins trust <path>` to add plugins.');
        return;
    }
    log.info(`Trusted plugins (${list.length}):`);
    for (const p of list) {
        log.info(`  ${p}`);
    }
}

function showHelp(): void {
    log.info("");
    log.info(`${c.brand("pizza plugins")} ${c.dim("— Manage Claude Code plugins")}`);
    log.info("");
    log.info(c.label("Commands"));
    log.info(`  ${c.cmd("pizza plugins")}                List all discovered plugins (global + local)`);
    log.info(`  ${c.cmd("pizza plugins list")}           Same as above`);
    log.info(`  ${c.cmd("pizza plugins trust")} ${c.dim("[path]")}   Trust project-local plugin(s)`);
    log.info(`                               ${c.dim("No path → trust all untrusted local plugins")}`);
    log.info(`                               ${c.dim("With path → trust plugin at that path")}`);
    log.info(`  ${c.cmd("pizza plugins untrust")} ${c.dim("[path]")} Remove plugin(s) from the trust list`);
    log.info(`                               ${c.dim("No path → clear the entire trust list")}`);
    log.info(`                               ${c.dim("With path → remove that specific plugin")}`);
    log.info(`  ${c.cmd("pizza plugins trusted")}        Show the current trust list`);
    log.info("");
    log.info(c.dim("Trusted plugins auto-load without prompting. Global plugins"));
    log.info(c.dim("(~/.pizzapi/plugins/, ~/.agents/plugins/, ~/.claude/plugins/) are"));
    log.info(c.dim("always auto-trusted. Project-local plugins require explicit trust"));
    log.info(c.dim("via this command or interactive confirmation at session start."));
    log.info("");
    log.info(c.dim("Trust state is stored in ~/.pizzapi/config.json (trustedPlugins)."));
    log.info("");
}

// ── Entry point ───────────────────────────────────────────────────────────────

export async function runPluginsCommand(args: string[], cwd: string): Promise<void> {
    const subcommand = args[0] ?? "list";

    if (subcommand === "--help" || subcommand === "-h" || subcommand === "help") {
        showHelp();
        return;
    }

    if (subcommand === "list" || subcommand === "ls") {
        listPlugins(cwd);
        return;
    }

    if (subcommand === "trust") {
        trustCommand(args.slice(1), cwd);
        return;
    }

    if (subcommand === "untrust") {
        untrustCommand(args.slice(1), cwd);
        return;
    }

    if (subcommand === "trusted") {
        showTrusted();
        return;
    }

    // Unknown subcommand — show list (default behavior)
    listPlugins(cwd);
}
