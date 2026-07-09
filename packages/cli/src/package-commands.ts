/**
 * Thin wrapper around upstream pi-coding-agent's package-management CLI
 * handlers so `pizza install|remove|uninstall|update|list|config` work with
 * PizzaPi's configured agent directory and `--cwd` flag.
 */

import { handleConfigCommand, handlePackageCommand } from "@earendil-works/pi-coding-agent";
import { c } from "./cli-colors.js";

const PACKAGE_COMMANDS = new Set(["install", "remove", "uninstall", "update", "list", "config"]);

export function isPackageCommand(arg: string | undefined): boolean {
    return !!arg && PACKAGE_COMMANDS.has(arg);
}

function stripCwdFlag(args: string[]): string[] {
    const idx = args.indexOf("--cwd");
    if (idx === -1) return args;
    const copy = [...args];
    copy.splice(idx, 2);
    return copy;
}

type HelpEntry = {
    commands: string[];
    usage: string;
    description: (c: typeof import("./cli-colors.js").c) => string;
    options: Array<{ flag: string; desc: string }>;
    examples?: string[];
    note?: (c: typeof import("./cli-colors.js").c) => string;
};

const COMMAND_HELP: HelpEntry[] = [
    {
        commands: ["install"],
        usage: "<source> [-l]",
        description: () => "Install a pi package (extensions, skills, prompts, or themes).",
        options: [
            { flag: "-l, --local", desc: "Install into the project-local .pizzapi directory" },
            { flag: "-a, --approve", desc: "Trust project-local files for this command" },
            { flag: "-na, --no-approve", desc: "Ignore project-local files for this command" },
        ],
        examples: [
            "pizza install npm:@foo/pi-tools",
            "pizza install git:github.com/user/repo",
            "pizza install ./local/path",
        ],
    },
    {
        commands: ["remove", "uninstall"],
        usage: "<source> [-l]",
        description: (colors) => `Remove an installed pi package. Alias: ${colors.cmd("pizza uninstall")}.`,
        options: [
            { flag: "-l, --local", desc: "Remove from project-local .pizzapi" },
            { flag: "-a, --approve", desc: "Trust project-local files for this command" },
            { flag: "-na, --no-approve", desc: "Ignore project-local files for this command" },
        ],
    },
    {
        commands: ["update"],
        usage: "[source|self|pi] [--self] [--extensions] [--extension <source>] [-a|-na]",
        description: () => "Update installed pi packages.",
        options: [
            { flag: "--self", desc: "Update the upstream pi package only" },
            { flag: "--extensions", desc: "Update installed packages only" },
            { flag: "--extension <source>", desc: "Update a single package" },
            { flag: "--force", desc: "Reinstall even if already up to date" },
            { flag: "-a, --approve", desc: "Trust project-local files" },
            { flag: "-na, --no-approve", desc: "Ignore project-local files" },
        ],
        note: (colors) =>
            `${colors.accent("Note:")} Use ${colors.cmd("npm install -g @pizzapi/pizza")} to update the PizzaPi wrapper itself.`,
    },
    {
        commands: ["list"],
        usage: "[-a|-na]",
        description: () => "List installed pi packages.",
        options: [
            { flag: "-a, --approve", desc: "Trust project-local files" },
            { flag: "-na, --no-approve", desc: "Ignore project-local files" },
        ],
    },
    {
        commands: ["config"],
        usage: "[-a|-na]",
        description: () => "Interactively enable or disable installed package resources.",
        options: [
            { flag: "-a, --approve", desc: "Trust project-local files" },
            { flag: "-na, --no-approve", desc: "Ignore project-local files" },
        ],
    },
];

function printCommandHelp(command: string): void {
    const entry = COMMAND_HELP.find((e) => e.commands.includes(command));
    if (!entry) return;

    const canonical = entry.commands[0];
    console.log(`\n${c.label("Usage:")}\n  ${c.cmd(`pizza ${canonical}`)} ${c.dim(entry.usage)}\n`);
    console.log(`${entry.description(c)}\n`);
    console.log(`${c.label("Options:")}`);
    const maxFlagLen = entry.options.reduce((max, opt) => Math.max(max, opt.flag.length), 0);
    for (const { flag, desc } of entry.options) {
        const pad = " ".repeat(maxFlagLen - flag.length + 2);
        console.log(`  ${c.flag(flag)}${pad}${desc}`);
    }
    if (entry.examples) {
        console.log(`\n${c.label("Examples:")}`);
        for (const example of entry.examples) {
            console.log(`  ${c.cmd(example)}`);
        }
    }
    if (entry.note) {
        console.log(`\n${entry.note(c)}`);
    }
    console.log();
}

function printSelfUpdateNote(): void {
    console.log(`Use ${c.cmd("npm install -g @pizzapi/pizza")} to update the PizzaPi wrapper itself.`);
    console.log();
}

function printSelfUpdateDisabled(): void {
    console.error(`self-update disabled — use ${c.cmd("npm install -g @pizzapi/pizza")} to update the PizzaPi wrapper itself.`);
}

/**
 * Parse update args to determine if self-update would be attempted.
 * Returns { includeSelf, argsForUpstream } where argsForUpstream is the
 * rewritten args with self-update stripped out.
 */
function rewriteUpdateArgs(args: string[]): { includeSelf: boolean; argsForUpstream: string[] } {
    if (args[0] !== "update") {
        return { includeSelf: false, argsForUpstream: args };
    }

    const rest = args.slice(1);
    const hasSelf = rest.includes("--self");
    const hasExtensions = rest.includes("--extensions");
    const hasExtensionFlag = rest.some((a, i) => a === "--extension" && i + 1 < rest.length);
    const firstPositional = rest.find((a) => !a.startsWith("-"));
    const positionalIsSelf = firstPositional === "self" || firstPositional === "pi";

    // Explicit self-only
    if (hasSelf && !hasExtensions && !positionalIsSelf && !firstPositional) {
        return { includeSelf: true, argsForUpstream: args };
    }
    if (positionalIsSelf && !hasExtensions) {
        return { includeSelf: true, argsForUpstream: args };
    }

    // Explicit extensions-only or specific source — no self
    if (hasExtensions || hasExtensionFlag) {
        return { includeSelf: false, argsForUpstream: args };
    }
    if (firstPositional && !positionalIsSelf) {
        return { includeSelf: false, argsForUpstream: args };
    }

    // Default (no flags): upstream would do "all" (extensions + self).
    // Rewrite to extensions-only to avoid the self-update failure.
    return { includeSelf: false, argsForUpstream: ["update", "--extensions", ...rest] };
}

/**
 * Run a package-management subcommand.
 *
 * The caller should exit with the returned status code. This function mutates
 * process state (cwd, env) because upstream handlers are written against
 * `process.cwd()` and `getAgentDir()`.
 */
export async function runPackageCommand(args: string[], cwd: string, agentDir: string): Promise<number> {
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;

    try {
        args = stripCwdFlag(args);

        if (!process.env.PI_CODING_AGENT_DIR) {
            process.env.PI_CODING_AGENT_DIR = agentDir;
        }

        // Upstream handlers use process.cwd() for project-local (-l) installs.
        if (process.cwd() !== cwd) {
            process.chdir(cwd);
        }

        if (args.includes("--help") || args.includes("-h")) {
            printCommandHelp(args[0] ?? "install");
            return 0;
        }

        // Rewrite update args to skip self-update by default
        if (args[0] === "update") {
            const { includeSelf, argsForUpstream } = rewriteUpdateArgs(args);
            if (includeSelf) {
                printSelfUpdateDisabled();
                return 1;
            }
            const wasRewritten = argsForUpstream !== args;
            try {
                const handled = await handlePackageCommand(argsForUpstream);
                if (handled) {
                    if (wasRewritten) printSelfUpdateNote();
                    return Number(process.exitCode ?? 0);
                }
                return 1;
            } catch (err) {
                console.error(`pizza ${args[0]}: ${err instanceof Error ? err.message : String(err)}`);
                return 1;
            }
        }

        try {
            if (args[0] === "config") {
                // handleConfigCommand exits the process itself.
                await handleConfigCommand(args);
                return 0;
            }

            const handled = await handlePackageCommand(args);
            return handled ? Number(process.exitCode ?? 0) : 1;
        } catch (err) {
            console.error(`pizza ${args[0]}: ${err instanceof Error ? err.message : String(err)}`);
            return 1;
        }
    } finally {
        process.exitCode = previousExitCode ?? 0;
    }
}
