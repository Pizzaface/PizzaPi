import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { chmodSync, mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createMcpClientsFromConfig } from "./mcp.js";
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

        const { config } = mergeOverlayMcpServers({}, cwd, agentDir, true);
        expect(config.mcpServers?.fromPkg).toBeDefined();
    });

    test("defers @PACKAGE_ROOT@ only for package stdio definitions", async () => {
        const pkgDir = join(tmpDir, "mcp package root $literal");
        writeFixturePackage(pkgDir, { schemaVersion: 1, mcp: "./.mcp.json" }, {
            ".mcp.json": JSON.stringify({
                mcp: {
                    servers: [{
                        name: "preferred",
                        transport: "stdio",
                        command: "@PACKAGE_ROOT@/gm",
                        cwd: "@PACKAGE_ROOT@/work dir",
                        args: ["--config", "@PACKAGE_ROOT@/config.json", "7"],
                        env: { CONFIG: "@PACKAGE_ROOT@/config.json", COUNT: "1" },
                    }],
                },
                mcpServers: {
                    compat: {
                        command: "@PACKAGE_ROOT@/bin/gm",
                        cwd: "@PACKAGE_ROOT@/work dir",
                        args: ["--config=@PACKAGE_ROOT@/config.json", false],
                        env: { CONFIG: "@PACKAGE_ROOT@/config.json", ENABLED: true },
                    },
                    remote: { url: "https://example.test/@PACKAGE_ROOT@", headers: { Path: "@PACKAGE_ROOT@" } },
                },
            }),
        });
        await install("../mcp package root $literal");

        const { config, serverProvenance } = mergeOverlayMcpServers({}, cwd, agentDir, true);
        const packageRoot = realpathSync(serverProvenance.find((p) => p.name === "compat")!.sourcePath);
        expect(packageRoot).toContain("mcp package root $literal");
        expect((config.mcp?.servers?.[0] as any)).toMatchObject({
            command: "@PACKAGE_ROOT@/gm",
            cwd: "@PACKAGE_ROOT@/work dir",
            args: ["--config", "@PACKAGE_ROOT@/config.json", "7"],
            env: { CONFIG: "@PACKAGE_ROOT@/config.json", COUNT: "1" },
        });
        expect(config.mcpServers?.compat).toMatchObject({
            command: "@PACKAGE_ROOT@/bin/gm",
            cwd: "@PACKAGE_ROOT@/work dir",
            args: ["--config=@PACKAGE_ROOT@/config.json", false],
            env: { CONFIG: "@PACKAGE_ROOT@/config.json", ENABLED: true },
        });
        expect(config.mcpServers?.remote).toEqual({ url: "https://example.test/@PACKAGE_ROOT@", headers: { Path: "@PACKAGE_ROOT@" } });
    });

    test("does not materialize package roots in URL definitions with incidental stdio fields", async () => {
        const pkgDir = join(tmpDir, "mcp-http-with-stdio");
        writeFixturePackage(pkgDir, { schemaVersion: 1, mcp: "./.mcp.json" }, {
            ".mcp.json": JSON.stringify({
                mcpServers: {
                    remote: {
                        url: "https://example.test/@PACKAGE_ROOT@",
                        type: "sse",
                        command: "@PACKAGE_ROOT@/must-not-run",
                        args: ["@PACKAGE_ROOT@/arg"],
                        cwd: "@PACKAGE_ROOT@/cwd",
                        env: { ROOT: "@PACKAGE_ROOT@" },
                    },
                },
            }),
        });
        await install("../mcp-http-with-stdio");

        const { config } = mergeOverlayMcpServers({}, cwd, agentDir, true);
        expect(config.mcpServers?.remote).toEqual({
            url: "https://example.test/@PACKAGE_ROOT@",
            type: "sse",
            command: "@PACKAGE_ROOT@/must-not-run",
            args: ["@PACKAGE_ROOT@/arg"],
            cwd: "@PACKAGE_ROOT@/cwd",
            env: { ROOT: "@PACKAGE_ROOT@" },
        });
    });

    test("preserves literal config tokens in the installed root through stdio construction", async () => {
        const pkgDir = join(tmpDir, "mcp-@HOME@-@PROJECT_DIR@");
        const server = `#!${process.execPath}\nconst snapshot = () => ({ command: process.argv[1], args: process.argv.slice(2), cwd: process.cwd(), root: process.env.ROOT });\nlet buffer = "";\nprocess.stdin.on("data", (chunk) => { buffer += chunk; for (;;) { const end = buffer.indexOf("\\n"); if (end < 0) return; const line = buffer.slice(0, end); buffer = buffer.slice(end + 1); const message = JSON.parse(line); if (message.method === "initialize") process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-03-26", capabilities: {}, serverInfo: { name: "fixture", version: "1" } } }) + "\\n"); else if (message.method === "tools/list") process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { tools: [{ name: "details", description: JSON.stringify(snapshot()) }] } }) + "\\n"); } });\n`;
        writeFixturePackage(pkgDir, { schemaVersion: 1, mcp: "./.mcp.json" }, {
            ".mcp.json": JSON.stringify({
                mcpServers: {
                    fixture: {
                        command: "@PACKAGE_ROOT@/stdio-server.js",
                        args: ["@PACKAGE_ROOT@/argument"],
                        cwd: "@PACKAGE_ROOT@",
                        env: { ROOT: "@PACKAGE_ROOT@" },
                    },
                },
            }),
            "stdio-server.js": server,
        });
        chmodSync(join(pkgDir, "stdio-server.js"), 0o755);
        await install("../mcp-@HOME@-@PROJECT_DIR@");

        const { config, serverProvenance } = mergeOverlayMcpServers({}, cwd, agentDir, true);
        const packageRoot = realpathSync(serverProvenance.find((p) => p.name === "fixture")!.sourcePath);
        const clients = await createMcpClientsFromConfig(config as any);
        try {
            const [tool] = await clients[0].listTools();
            expect(JSON.parse(tool.description!)).toEqual({
                command: `${packageRoot}/stdio-server.js`,
                args: [`${packageRoot}/argument`],
                cwd: packageRoot,
                root: packageRoot,
            });
        } finally {
            clients[0].close();
        }
    });

    test("leaves @PACKAGE_ROOT@ untouched in explicit config and legacy plugin MCP definitions", async () => {
        installLegacyPlugin("package-root-legacy", { legacy: { command: "@PACKAGE_ROOT@/legacy", args: ["@PACKAGE_ROOT@"] } });
        const base = { mcpServers: { explicit: { command: "@PACKAGE_ROOT@/explicit", env: { ROOT: "@PACKAGE_ROOT@" } } } };

        const { config } = mergeOverlayMcpServers(base, cwd, agentDir, true);
        expect(config.mcpServers?.explicit).toEqual(base.mcpServers.explicit);
        expect(config.mcpServers?.legacy).toEqual({ command: "@PACKAGE_ROOT@/legacy", args: ["@PACKAGE_ROOT@"] });
    });

    test("collision winner alone materializes its package root", async () => {
        const userPkg = join(tmpDir, "mcp-root-user");
        writeFixturePackage(userPkg, { schemaVersion: 1, mcp: "./.mcp.json" }, {
            ".mcp.json": JSON.stringify({ mcpServers: { shared: { command: "@PACKAGE_ROOT@/user" } } }),
        });
        await install("../mcp-root-user");

        const projectPkg = join(tmpDir, "mcp-root-project");
        writeFixturePackage(projectPkg, { schemaVersion: 1, mcp: "./.mcp.json" }, {
            ".mcp.json": JSON.stringify({ mcpServers: { shared: { command: "@PACKAGE_ROOT@/project" } } }),
        });
        await install("../mcp-root-project", { project: true });

        const { config, serverProvenance } = mergeOverlayMcpServers({}, cwd, agentDir, true);
        expect((config.mcpServers?.shared as any)?.command).toEndWith("/project");
        expect((config.mcpServers?.shared as any)?.command).not.toContain("mcp-root-user");
        expect(serverProvenance.find((p) => p.name === "shared")?.identity).toContain("mcp-root-project");
    });

    test("explicit PizzaPi config always wins a server-name collision over package overlay", async () => {
        const pkgDir = join(tmpDir, "mcp-collide-pkg");
        writeFixturePackage(pkgDir, { schemaVersion: 1, mcp: "./.mcp.json" }, {
            ".mcp.json": JSON.stringify({ mcpServers: { shared: { command: "pkg-command" } } }),
        });
        await install("../mcp-collide-pkg");

        const base = { mcpServers: { shared: { command: "explicit-config-command" } } };
        const { config } = mergeOverlayMcpServers(base, cwd, agentDir, true);
        expect((config.mcpServers?.shared as any)?.command).toBe("explicit-config-command");
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

        const { config } = mergeOverlayMcpServers({}, cwd, agentDir, true);
        expect((config.mcpServers?.shared as any)?.command).toBe("project-command");
    });

    test("project-scope package overlay is excluded when the project is not explicitly trusted", async () => {
        const userPkg = join(tmpDir, "mcp-trust-user-pkg");
        writeFixturePackage(userPkg, { schemaVersion: 1, mcp: "./.mcp.json" }, {
            ".mcp.json": JSON.stringify({ mcpServers: { fromUser: { command: "user-command" } } }),
        });
        await install("../mcp-trust-user-pkg");

        const projectPkg = join(tmpDir, "mcp-trust-project-pkg");
        writeFixturePackage(projectPkg, { schemaVersion: 1, mcp: "./.mcp.json" }, {
            ".mcp.json": JSON.stringify({ mcpServers: { fromProject: { command: "project-command" } } }),
        });
        await install("../mcp-trust-project-pkg", { project: true });

        const untrusted = mergeOverlayMcpServers({}, cwd, agentDir, false);
        expect(untrusted.config.mcpServers?.fromUser).toBeDefined();
        expect(untrusted.config.mcpServers?.fromProject).toBeUndefined();
        expect(untrusted.serverProvenance.some((p) => p.name === "fromProject")).toBe(false);
        expect(untrusted.serverProvenance.some((p) => p.name === "fromUser" && p.owner === "user")).toBe(true);

        const trusted = mergeOverlayMcpServers({}, cwd, agentDir, true);
        expect(trusted.config.mcpServers?.fromProject).toBeDefined();
        expect(trusted.serverProvenance.some((p) => p.name === "fromProject" && p.owner === "project")).toBe(true);
    });

    test("malformed mcp sidecar shape (re-parsed at mount time) is skipped with a warning, not silently treated as empty", async () => {
        const pkgDir = join(tmpDir, "mcp-malformed-pkg");
        writeFixturePackage(pkgDir, { schemaVersion: 1, mcp: "./.mcp.json" }, {
            ".mcp.json": JSON.stringify({ mcpServers: { fromPkg: { command: "echo" } } }),
        });
        await install("../mcp-malformed-pkg");

        // Simulate the sidecar being replaced with a malformed shape between
        // manifest validation and mount-time read (manifest.ts only validates
        // the `mcp` path points to a confined, readable location — not the
        // referenced file's own JSON shape).
        writeFileSync(join(pkgDir, ".mcp.json"), JSON.stringify(["not", "an", "object"]));

        const { config, serverProvenance } = mergeOverlayMcpServers({}, cwd, agentDir, true);
        expect(config.mcpServers?.fromPkg).toBeUndefined();
        expect(serverProvenance.some((p) => p.name === "fromPkg")).toBe(false);
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

        const { config } = mergeOverlayMcpServers({}, cwd, agentDir, true);
        expect((config.mcpServers?.legacyServer as any)?.command).toBe("legacy-command");
    });

    test("package overlay mcp wins over legacy plugin .mcp.json for the same name", async () => {
        installLegacyPlugin("legacy-plugin2", { shared: { command: "legacy-command" } });

        const pkgDir = join(tmpDir, "mcp-beats-legacy-pkg");
        writeFixturePackage(pkgDir, { schemaVersion: 1, mcp: "./.mcp.json" }, {
            ".mcp.json": JSON.stringify({ mcpServers: { shared: { command: "package-command" } } }),
        });
        await install("../mcp-beats-legacy-pkg");

        const { config } = mergeOverlayMcpServers({}, cwd, agentDir, true);
        expect((config.mcpServers?.shared as any)?.command).toBe("package-command");
    });
});
