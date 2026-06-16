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

function printCommandHelp(command: string): void {
    const cmd = (s: string) => c.cmd(s);
    const dim = (s: string) => c.dim(s);
    const flag = (s: string) => c.flag(s);

    switch (command) {
        case "install":
            console.log(`\n${c.label("Usage:")}\n  ${cmd("pizza install")} ${dim("<source> [-l]")}\n`);
            console.log(`Install a pi package (extensions, skills, prompts, or themes).\n`);
            console.log(`${c.label("Options:")}`);
            console.log(`  ${flag("-l, --local")}     Install into the project-local .pizzapi directory`);
            console.log(`  ${flag("-a, --approve")}    Trust project-local files for this command`);
            console.log(`  ${flag("-na, --no-approve")} Ignore project-local files for this command`);
            console.log(`\n${c.label("Examples:")}`);
            console.log(`  ${cmd("pizza install npm:@foo/pi-tools")}`);
            console.log(`  ${cmd("pizza install git:github.com/user/repo")}`);
            console.log(`  ${cmd("pizza install ./local/path")}`);
            console.log();
            return;
        case "remove":
        case "uninstall":
            console.log(`\n${c.label("Usage:")}\n  ${cmd("pizza remove")} ${dim("<source> [-l]")}\n`);
            console.log(`Remove an installed pi package. Alias: ${cmd("pizza uninstall")}.\n`);
            console.log(`${c.label("Options:")}`);
            console.log(`  ${flag("-l, --local")}     Remove from project-local .pizzapi`);
            console.log(`  ${flag("-a, --approve")}    Trust project-local files for this command`);
            console.log(`  ${flag("-na, --no-approve")} Ignore project-local files for this command`);
            console.log();
            return;
        case "update":
            console.log(`\n${c.label("Usage:")}\n  ${cmd("pizza update")} ${dim("[source|self|pi] [--self] [--extensions] [--extension <source>] [-a|-na]")}\n`);
            console.log(`Update installed pi packages.\n`);
            console.log(`${c.label("Options:")}`);
            console.log(`  ${flag("--self")}             Update the upstream pi package only`);
            console.log(`  ${flag("--extensions")}       Update installed packages only`);
            console.log(`  ${flag("--extension <source>")} Update a single package`);
            console.log(`  ${flag("--force")}            Reinstall even if already up to date`);
            console.log(`  ${flag("-a, --approve")}        Trust project-local files`);
            console.log(`  ${flag("-na, --no-approve")}     Ignore project-local files`);
            console.log(`\n${c.accent("Note:")} Use ${cmd("npm install -g @pizzapi/pizza")} to update the PizzaPi wrapper itself.`);
            console.log();
            return;
        case "list":
            console.log(`\n${c.label("Usage:")}\n  ${cmd("pizza list")} ${dim("[-a|-na]")}\n`);
            console.log(`List installed pi packages.\n`);
            console.log(`${c.label("Options:")}`);
            console.log(`  ${flag("-a, --approve")}    Trust project-local files`);
            console.log(`  ${flag("-na, --no-approve")} Ignore project-local files`);
            console.log();
            return;
        case "config":
            console.log(`\n${c.label("Usage:")}\n  ${cmd("pizza config")} ${dim("[-a|-na]")}\n`);
            console.log(`Interactively enable or disable installed package resources.\n`);
            console.log(`${c.label("Options:")}`);
            console.log(`  ${flag("-a, --approve")}    Trust project-local files`);
            console.log(`  ${flag("-na, --no-approve")} Ignore project-local files`);
            console.log();
            return;
    }
}

function isUpdateSelfOnly(args: string[]): boolean {
    if (args[0] !== "update") return false;
    const rest = args.slice(1);
    if (rest.includes("--self")) return true;
    const firstPositional = rest.find((a) => !a.startsWith("-"));
    if (firstPositional === "self" || firstPositional === "pi") return true;
    return false;
}

function printSelfUpdateNote(): void {
    console.log(c.dim("pizza update --self updates the upstream pi package."));
    console.log(`To update the PizzaPi wrapper itself, run ${c.cmd("npm install -g @pizzapi/pizza")}.`);
    console.log();
}

/**
 * Run a package-management subcommand.
 *
 * The caller should exit with the returned status code. This function mutates
 * process state (cwd, env) because upstream handlers are written against
 * `process.cwd()` and `getAgentDir()`.
 */
export async function runPackageCommand(args: string[], cwd: string, agentDir: string): Promise<number> {
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

    if (isUpdateSelfOnly(args)) {
        printSelfUpdateNote();
        return 0;
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
}
