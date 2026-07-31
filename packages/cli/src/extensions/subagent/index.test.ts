/**
 * Runtime wiring test for the subagent tool's overlay agent-directory/file
 * resolution (docs/specs/pi-pizzapi-overlay.md §4.3). Exercises the REAL
 * `subagentExtension` factory + real `runPackageCommand` install +
 * `collectOverlayAgentDirs` wiring in subagent/index.ts — not a mock of
 * `discoverAgents()` — so a regression that drops the overlay wiring (or
 * forgets to thread `extraUserFiles`/`extraProjectFiles`) fails this test.
 * Only exercises the "list available agents" fallback path (no agent/task
 * given) so it never spawns a real subagent AgentSession.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { subagentExtension } from "./index.js";
import { runPackageCommand } from "../../package-commands.js";
import { _setGlobalConfigDir } from "../../config/io.js";
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";

describe("subagentExtension — overlay agent wiring", () => {
    let tmpDir: string;
    let cwd: string;
    let agentDir: string;
    let originalCwd: string;
    let originalAgentDirEnv: string | undefined;

    beforeEach(() => {
        originalCwd = process.cwd();
        // runPackageCommand() only sets PI_CODING_AGENT_DIR when it's unset
        // ("upstream handlers use the env var, not an explicit param") —
        // without clearing it here, the FIRST test in this file to install a
        // package pins every later test's install to ITS agentDir, even
        // though each test uses its own fresh tmpdir (see session-packages.
        // test.ts / mcp-overlay.test.ts, which follow this same pattern).
        originalAgentDirEnv = process.env.PI_CODING_AGENT_DIR;
        delete process.env.PI_CODING_AGENT_DIR;
        tmpDir = mkdtempSync(join(tmpdir(), "pizzapi-subagent-overlay-"));
        cwd = join(tmpDir, "project");
        agentDir = join(tmpDir, "agent");
        mkdirSync(cwd, { recursive: true });
        mkdirSync(agentDir, { recursive: true });
        _setGlobalConfigDir(join(tmpDir, "global-config"));
        // resolveAgentDir(cwd) reads config.agentDir from project config —
        // point it at our isolated test agentDir instead of ~/.pizzapi
        // (homedir() is cached by Bun at process start, so HOME overrides
        // don't reach it — see other overlay tests' notes on this).
        mkdirSync(join(cwd, ".pizzapi"), { recursive: true });
        writeFileSync(join(cwd, ".pizzapi", "config.json"), JSON.stringify({ agentDir }));
    });

    afterEach(() => {
        process.chdir(originalCwd);
        if (originalAgentDirEnv === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = originalAgentDirEnv;
        _setGlobalConfigDir(null);
        rmSync(tmpDir, { recursive: true, force: true });
    });

    function registerTool() {
        const tools: any[] = [];
        const pi = { registerTool: (t: any) => tools.push(t), on: () => {} };
        subagentExtension(pi as any);
        return tools[0];
    }

    async function installOverlayPackage(opts: { project: boolean; agentFile: string; agentName: string }): Promise<void> {
        const pkgDir = join(tmpDir, `overlay-agent-pkg-${opts.project ? "project" : "user"}`);
        mkdirSync(join(pkgDir, "agents"), { recursive: true });
        writeFileSync(
            join(pkgDir, "package.json"),
            JSON.stringify({ name: "overlay-agent-pkg", pi: { pizzapi: { schemaVersion: 1, agents: [`./agents/${opts.agentFile}`] } } }),
        );
        writeFileSync(
            join(pkgDir, "agents", opts.agentFile),
            `---\nname: ${opts.agentName}\ndescription: From overlay\n---\nBody`,
        );
        // Unrelated sibling agent file that was NOT declared — proves exact
        // single-file loading (must never be picked up alongside it).
        writeFileSync(
            join(pkgDir, "agents", "undeclared-sibling.md"),
            "---\nname: undeclared-sibling\ndescription: Should never load\n---\nBody",
        );
        const args = opts.project
            ? ["install", `../${pkgDir.split("/").pop()}`, "-l"]
            : ["install", `../${pkgDir.split("/").pop()}`];
        const code = await runPackageCommand(args, cwd, agentDir);
        expect(code).toBe(0);
    }

    test("project-scope overlay agent is discoverable via the real subagent tool once the project is trusted, with confirmProjectAgents required", async () => {
        await installOverlayPackage({ project: true, agentFile: "special.md", agentName: "overlay-special" });
        new ProjectTrustStore(agentDir).set(cwd, true);

        const tool = registerTool();
        const result = await tool.execute(
            "call-1",
            { agentScope: "project", confirmProjectAgents: false },
            new AbortController().signal,
            undefined,
            { cwd, hasUI: false, modelRegistry: undefined },
        );

        const text = result.content[0].text as string;
        expect(text).toContain("overlay-special");
        expect(text).not.toContain("undeclared-sibling"); // exact single-file loading, not folder-folded
    });

    test("project-scope overlay agent is absent when the project is not trusted", async () => {
        await installOverlayPackage({ project: true, agentFile: "special2.md", agentName: "overlay-special-untrusted" });
        // No ProjectTrustStore entry — fails closed.

        const tool = registerTool();
        const result = await tool.execute(
            "call-2",
            { agentScope: "project", confirmProjectAgents: false },
            new AbortController().signal,
            undefined,
            { cwd, hasUI: false, modelRegistry: undefined },
        );

        const text = result.content[0].text as string;
        expect(text).not.toContain("overlay-special-untrusted");
    });

    test("user-scope overlay agent is discoverable regardless of project trust", async () => {
        await installOverlayPackage({ project: false, agentFile: "userspecial.md", agentName: "overlay-user-special" });

        const tool = registerTool();
        const result = await tool.execute(
            "call-3",
            { agentScope: "user" },
            new AbortController().signal,
            undefined,
            { cwd, hasUI: false, modelRegistry: undefined },
        );

        const text = result.content[0].text as string;
        expect(text).toContain("overlay-user-special");
    });
});
