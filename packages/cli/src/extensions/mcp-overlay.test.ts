import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPackageCommand } from "../package-commands.js";
import { _setGlobalConfigDir } from "../config/io.js";
import { mergeOverlayMcpServers } from "./mcp-overlay.js";

describe("mergeOverlayMcpServers", () => {
    let tmpDir: string;
    let cwd: string;
    let agentDir: string;
    let originalCwd: string;
    let originalAgentDir: string | undefined;
    let originalHome: string | undefined;

    beforeEach(() => {
        tmpDir = mkdtempSync(join(tmpdir(), "pizzapi-mcpoverlay-"));
        cwd = join(tmpDir, "project");
        agentDir = join(tmpDir, "agent");
        mkdirSync(cwd, { recursive: true });
        mkdirSync(agentDir, { recursive: true });
        _setGlobalConfigDir(join(tmpDir, "global-config"));
        originalCwd = process.cwd();
        originalAgentDir = process.env.PI_CODING_AGENT_DIR;
        // discoverPlugins() reads process.env.HOME for the legacy plugin-dir scan.
        originalHome = process.env.HOME;
        process.env.HOME = join(tmpDir, "home");
        mkdirSync(process.env.HOME, { recursive: true });
    });

    afterEach(() => {
        process.chdir(originalCwd);
        if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
        if (originalHome === undefined) delete process.env.HOME;
        else process.env.HOME = originalHome;
        _setGlobalConfigDir(null);
        rmSync(tmpDir, { recursive: true, force: true });
    });

    function writeFixturePackage(dir: string, overlay: unknown, files?: Record<string, string>) {
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fixture", pi: { pizzapi: overlay } }));
        for (const [rel, content] of Object.entries(files ?? {})) {
            const filePath = join(dir, rel);
            mkdirSync(join(filePath, ".."), { recursive: true });
            writeFileSync(filePath, content);
        }
    }

    async function install(relOrAbs: string, opts?: { project?: boolean }) {
        const args = opts?.project ? ["install", relOrAbs, "-l"] : ["install", relOrAbs];
        const code = await runPackageCommand(args, cwd, agentDir);
        expect(code).toBe(0);
    }

    test("package overlay mcp server is added to the base config", async () => {
        const pkgDir = join(tmpDir, "mcp-pkg");
        writeFixturePackage(pkgDir, { schemaVersion: 1, mcp: "./.mcp.json" }, {
            ".mcp.json": JSON.stringify({ mcpServers: { fromPkg: { command: "echo" } } }),
        });
        await install("../mcp-pkg");

        const merged = mergeOverlayMcpServers({}, cwd, agentDir);
        expect(merged.mcpServers?.fromPkg).toBeDefined();
    });

    test("explicit PizzaPi config always wins a server-name collision over package overlay", async () => {
        const pkgDir = join(tmpDir, "mcp-collide-pkg");
        writeFixturePackage(pkgDir, { schemaVersion: 1, mcp: "./.mcp.json" }, {
            ".mcp.json": JSON.stringify({ mcpServers: { shared: { command: "pkg-command" } } }),
        });
        await install("../mcp-collide-pkg");

        const base = { mcpServers: { shared: { command: "explicit-config-command" } } };
        const merged = mergeOverlayMcpServers(base, cwd, agentDir);
        expect((merged.mcpServers?.shared as any).command).toBe("explicit-config-command");
    });

    test("project-scope package wins over user-scope package for the same server name", async () => {
        const userPkg = join(tmpDir, "mcp-user-pkg");
        writeFixturePackage(userPkg, { schemaVersion: 1, mcp: "./.mcp.json" }, {
            ".mcp.json": JSON.stringify({ mcpServers: { shared: { command: "user-command" } } }),
        });
        await install("../mcp-user-pkg");

        const projectPkg = join(tmpDir, "mcp-project-pkg");
        writeFixturePackage(projectPkg, { schemaVersion: 1, mcp: "./.mcp.json" }, {
            ".mcp.json": JSON.stringify({ mcpServers: { shared: { command: "project-command" } } }),
        });
        await install("../mcp-project-pkg", { project: true });

        const merged = mergeOverlayMcpServers({}, cwd, agentDir);
        expect((merged.mcpServers?.shared as any).command).toBe("project-command");
    });

    /**
     * Legacy global-plugin discovery (globalPluginDirs()) reads homedir(),
     * which Bun caches at process start — process.env.HOME overrides don't
     * reach it in tests (see claude-plugins.e2e.test.ts's note). The Claude
     * Code marketplace-installed path (discoverClaudeInstalledPlugins) DOES
     * read process.env.HOME directly, so fixtures go through
     * ~/.claude/plugins/installed_plugins.json instead — same discoverPlugins()
     * call, same .mcp.json gap being fixed.
     */
    function installLegacyPlugin(name: string, mcpServers: Record<string, unknown>): void {
        const installPath = join(tmpDir, "claude-plugin-cache", name);
        mkdirSync(join(installPath, "commands"), { recursive: true });
        writeFileSync(join(installPath, "commands", "noop.md"), "noop");
        writeFileSync(join(installPath, ".mcp.json"), JSON.stringify({ mcpServers }));

        const installedPluginsPath = join(process.env.HOME!, ".claude", "plugins", "installed_plugins.json");
        mkdirSync(join(installedPluginsPath, ".."), { recursive: true });
        writeFileSync(installedPluginsPath, JSON.stringify({
            version: 1,
            plugins: { [`${name}@test`]: [{ scope: "user", installPath }] },
        }));
    }

    test("legacy global Claude-plugin .mcp.json is picked up (fixes the previously-ignored gap) at lowest precedence", () => {
        installLegacyPlugin("legacy-plugin", { legacyServer: { command: "legacy-command" } });

        const merged = mergeOverlayMcpServers({}, cwd, agentDir);
        expect((merged.mcpServers?.legacyServer as any).command).toBe("legacy-command");
    });

    test("package overlay mcp wins over legacy plugin .mcp.json for the same name", async () => {
        installLegacyPlugin("legacy-plugin2", { shared: { command: "legacy-command" } });

        const pkgDir = join(tmpDir, "mcp-beats-legacy-pkg");
        writeFixturePackage(pkgDir, { schemaVersion: 1, mcp: "./.mcp.json" }, {
            ".mcp.json": JSON.stringify({ mcpServers: { shared: { command: "package-command" } } }),
        });
        await install("../mcp-beats-legacy-pkg");

        const merged = mergeOverlayMcpServers({}, cwd, agentDir);
        expect((merged.mcpServers?.shared as any).command).toBe("package-command");
    });
});
