import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPluginCommand, pluginCommandExtension } from "./plugin-command.js";

let home: string;
let originalHome: string | undefined;
let sourceRepo: string;

beforeEach(() => {
    originalHome = process.env.HOME;
    home = mkdtempSync(join(tmpdir(), "pizzapi-plugin-cmd-"));
    process.env.HOME = home;

    sourceRepo = mkdtempSync(join(tmpdir(), "pizzapi-plugin-src-"));
    mkdirSync(join(sourceRepo, ".claude-plugin"), { recursive: true });
    writeFileSync(
        join(sourceRepo, ".claude-plugin", "marketplace.json"),
        JSON.stringify({ name: "demo", plugins: [{ name: "demo-plugin", description: "A demo" }] }),
    );
    const pluginDir = join(sourceRepo, "plugins", "demo-plugin");
    mkdirSync(join(pluginDir, ".claude-plugin"), { recursive: true });
    writeFileSync(join(pluginDir, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "demo-plugin" }));
});

afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    rmSync(home, { recursive: true, force: true });
    rmSync(sourceRepo, { recursive: true, force: true });
});

describe("runPluginCommand", () => {
    test("bare /plugin lists an empty state", () => {
        const { output, changed } = runPluginCommand([]);
        expect(changed).toBe(false);
        expect(output).toContain("No marketplaces");
        expect(output).toContain("No plugins installed");
    });

    test("marketplace add registers and reports the catalog", () => {
        const { output, changed } = runPluginCommand(["marketplace", "add", sourceRepo]);
        expect(changed).toBe(true);
        expect(output).toContain("Added marketplace");
        expect(output).toContain("demo-plugin");
    });

    test("install → enable/disable → uninstall round trip", () => {
        runPluginCommand(["marketplace", "add", sourceRepo]);

        const install = runPluginCommand(["install", "demo-plugin"]);
        expect(install.changed).toBe(true);
        expect(install.output).toContain("Installed demo-plugin@");

        expect(runPluginCommand([]).output).toContain("demo-plugin@");

        const disabled = runPluginCommand(["disable", "demo-plugin"]);
        expect(disabled.output).toContain("Disabled demo-plugin@");
        expect(runPluginCommand([]).output).toContain("(disabled)");

        expect(runPluginCommand(["enable", "demo-plugin"]).output).toContain("Enabled demo-plugin@");

        const removed = runPluginCommand(["uninstall", "demo-plugin"]);
        expect(removed.changed).toBe(true);
        expect(removed.output).toContain("Uninstalled");
    });

    test("marketplace remove reports unknown names without changing state", () => {
        const { output, changed } = runPluginCommand(["marketplace", "remove", "ghost"]);
        expect(changed).toBe(false);
        expect(output).toContain("Unknown marketplace");
    });

    test("missing arguments print usage instead of throwing", () => {
        expect(runPluginCommand(["marketplace", "add"]).output).toContain("Usage:");
        expect(runPluginCommand(["install"]).output).toContain("Usage:");
        expect(runPluginCommand(["enable"]).output).toContain("Usage:");
        expect(runPluginCommand(["bogus"]).output).toContain("Usage:");
    });

    test("marketplace show lists plugins with install marks", () => {
        runPluginCommand(["marketplace", "add", sourceRepo]);
        runPluginCommand(["install", "demo-plugin@demo"]);
        const { output } = runPluginCommand(["marketplace", "show", "demo"]);
        expect(output).toContain("✓ demo-plugin");
    });
});

describe("pluginCommandExtension", () => {
    function install() {
        const commands = new Map<string, any>();
        pluginCommandExtension({ registerCommand: (n: string, d: any) => commands.set(n, d) } as any);
        return commands;
    }

    test("registers /plugin", () => {
        expect(install().has("plugin")).toBe(true);
    });

    test("reloads resources only after a mutating subcommand", async () => {
        const cmd = install().get("plugin");
        let reloads = 0;
        const ctx = { reload: async () => { reloads++; }, ui: { notify: () => {} } };

        await cmd.handler("", ctx);
        expect(reloads).toBe(0);

        await cmd.handler(`marketplace add ${sourceRepo}`, ctx);
        expect(reloads).toBe(1);
    });

    test("surfaces failures as a notice instead of throwing", async () => {
        const cmd = install().get("plugin");
        const notices: string[] = [];
        await cmd.handler("marketplace add not-a-real-source", {
            reload: async () => {},
            ui: { notify: (m: string) => notices.push(m) },
        });
        expect(notices.join()).toContain("failed");
    });

    test("completions offer subcommands and marketplace actions", () => {
        const cmd = install().get("plugin");
        expect(cmd.getArgumentCompletions("")?.some((o: any) => o.value === "marketplace")).toBe(true);
        expect(cmd.getArgumentCompletions("inst")?.[0].value).toBe("install");
        expect(cmd.getArgumentCompletions("marketplace ")?.some((o: any) => o.label === "add")).toBe(true);
        expect(cmd.getArgumentCompletions("zzz")).toBeNull();
    });

    test("plugin-name completions include catalog entries", () => {
        runPluginCommand(["marketplace", "add", sourceRepo]);
        const cmd = install().get("plugin");
        const options = cmd.getArgumentCompletions("install demo");
        expect(options?.[0].label).toBe("demo-plugin@demo");
    });
});
