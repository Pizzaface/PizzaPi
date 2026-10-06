import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPluginCommand, runPluginCommandView, pluginCommandExtension, PLUGIN_COMMAND_RESULT_CHANNEL } from "./plugin-command.js";

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

function fakePackageManager() {
    const pkgs: Array<{ source: string; scope: "user" | "project"; filtered: boolean }> = [];
    return {
        pkgs,
        listConfiguredPackages: () => [...pkgs],
        installAndPersist: async (source: string, o?: { local?: boolean }) => {
            if (source === "npm:broken") throw new Error("npm install failed");
            pkgs.push({ source, scope: o?.local ? "project" : "user", filtered: false });
        },
        removeAndPersist: async (source: string, o?: { local?: boolean }) => {
            const i = pkgs.findIndex((p) => p.source === source && p.scope === (o?.local ? "project" : "user"));
            if (i < 0) return false;
            pkgs.splice(i, 1);
            return true;
        },
        update: async () => {},
    };
}

describe("runPluginCommandView", () => {
    test("overview tracks enabled, disabled, and catalog state", async () => {
        const deps = { packageManager: fakePackageManager() };
        const added = await runPluginCommandView(["marketplace", "add", sourceRepo], undefined, deps);
        expect(added.changed).toBe(true);
        expect(added.catalog?.plugins).toEqual([
            expect.objectContaining({ name: "demo-plugin", key: "demo-plugin@demo", installed: false }),
        ]);

        const install = await runPluginCommandView(["install", "demo-plugin@demo"], undefined, deps);
        expect(install.catalog?.plugins[0]).toEqual(expect.objectContaining({ installed: true, enabled: true }));
        const loaded = (await runPluginCommandView([], undefined, deps)).overview.plugins.find((p) => p.name === "demo-plugin");
        expect(loaded).toEqual(expect.objectContaining({ source: "marketplace", key: "demo-plugin@demo", marketplace: "demo" }));

        const off = await runPluginCommandView(["disable", "demo-plugin@demo"], undefined, deps);
        expect(off.overview.plugins.some((p) => p.name === "demo-plugin")).toBe(false);
        expect(off.overview.disabled).toEqual([{ key: "demo-plugin@demo", name: "demo-plugin", marketplace: "demo" }]);

        const shown = await runPluginCommandView(["marketplace", "show", "demo"], undefined, deps);
        expect(shown.catalog?.plugins[0]).toEqual(expect.objectContaining({ installed: true, enabled: false }));
    });

    test("failures come back as isError with the current overview", async () => {
        const deps = { packageManager: fakePackageManager() };
        const bad = await runPluginCommandView(["install", "nope@nowhere"], undefined, deps);
        expect(bad.isError).toBe(true);
        expect(bad.changed).toBe(false);
        expect(bad.overview.marketplaces).toEqual([]);
        expect((await runPluginCommandView(["uninstall"], undefined, deps)).isError).toBe(true);
    });

    test("package subcommands install, list, remove, and update pi packages", async () => {
        const deps = { packageManager: fakePackageManager() };
        const installed = await runPluginCommandView(["package", "install", "npm:@acme/ext"], "/work/repo", deps);
        expect(installed.changed).toBe(true);
        expect(installed.notice).toBe("Installed package npm:@acme/ext");
        expect(installed.overview.packages).toEqual([{ source: "npm:@acme/ext", scope: "user", filtered: false, installedPath: undefined }]);
        expect(installed.overview.packagesCwd).toBe("/work/repo");

        await runPluginCommandView(["package", "install", "git:github.com/a/b", "--local"], "/work/repo", deps);
        expect(deps.packageManager.pkgs.map((p) => p.scope)).toEqual(["user", "project"]);

        const listed = await runPluginCommandView(["package", "list"], undefined, deps);
        expect(listed.output).toContain("npm:@acme/ext  (user)");
        expect(listed.changed).toBe(false);

        const removed = await runPluginCommandView(["packages", "remove", "git:github.com/a/b", "-l"], "/work/repo", deps);
        expect(removed.notice).toBe("Removed package git:github.com/a/b (project)");
        expect(removed.overview.packages).toHaveLength(1);

        expect((await runPluginCommandView(["package", "remove", "npm:missing"], undefined, deps)).isError).toBe(true);
        expect((await runPluginCommandView(["package", "update"], undefined, deps)).notice).toBe("Updated all packages");

        const broken = await runPluginCommandView(["package", "install", "npm:broken"], undefined, deps);
        expect(broken).toEqual(expect.objectContaining({ isError: true, changed: false, notice: "npm install failed" }));
        expect(broken.overview.packages).toHaveLength(1);
    });
});

describe("pluginCommandExtension", () => {
    let listeners: Array<(data: any) => void> = [];
    function install() {
        listeners = [];
        const commands = new Map<string, any>();
        pluginCommandExtension({
            registerCommand: (n: string, d: any) => commands.set(n, d),
            events: {
                emit: (ch: string, data: any) => { if (ch === PLUGIN_COMMAND_RESULT_CHANNEL) for (const l of listeners) l(data); },
                on: () => () => {},
            },
        } as any);
        return commands;
    }

    test("emits a structured result; a handling listener suppresses the text notice", async () => {
        const cmd = install();
        runPluginCommand(["marketplace", "add", sourceRepo]);
        const events: any[] = [];
        listeners.push((e) => { events.push(e); e.handled = true; });
        const notices: string[] = [];
        await cmd.get("plugin").handler("install demo-plugin", {
            reload: async () => {},
            ui: { notify: (m: string) => notices.push(m) },
        });
        expect(events).toHaveLength(1);
        expect(events[0].type).toBe("plugin_command_result");
        expect(events[0].notice).toContain("Installed demo-plugin@demo");
        expect(events[0].overview.marketplaces[0].name).toBe("demo");
        expect(notices).toHaveLength(0);
    });

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
