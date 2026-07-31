import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPackageCommand } from "../package-commands.js";
import { _setGlobalConfigDir } from "../config/io.js";
import { resolveSessionOverlays, collectOverlayAgentDirs, collectOverlayRuleBlocks } from "./session-packages.js";

describe("session-packages overlay mounting", () => {
    let tmpDir: string;
    let cwd: string;
    let agentDir: string;
    let originalCwd: string;
    let originalAgentDir: string | undefined;

    beforeEach(() => {
        tmpDir = mkdtempSync(join(tmpdir(), "pizzapi-sesspkg-"));
        cwd = join(tmpDir, "project");
        agentDir = join(tmpDir, "agent");
        mkdirSync(cwd, { recursive: true });
        mkdirSync(agentDir, { recursive: true });
        _setGlobalConfigDir(join(tmpDir, "global-config"));
        originalCwd = process.cwd();
        originalAgentDir = process.env.PI_CODING_AGENT_DIR;
    });

    afterEach(() => {
        process.chdir(originalCwd);
        if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
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

    async function install(relOrAbs: string, opts?: { project?: boolean; allowInvalidOverlay?: boolean }) {
        const args = opts?.project ? ["install", relOrAbs, "-l"] : ["install", relOrAbs];
        const code = await runPackageCommand(args, cwd, agentDir);
        // An invalid overlay makes the CLI wrapper exit non-zero (see
        // cli-support.ts handlePostInstallOverlay) even though the upstream
        // pi-native install itself succeeded and the package is configured.
        expect(code).toBe(opts?.allowInvalidOverlay ? 1 : 0);
    }

    test("valid overlay contributes to packages[]; invalid overlay is skipped with a warning", async () => {
        const validDir = join(tmpDir, "valid-pkg");
        writeFixturePackage(validDir, { schemaVersion: 1, rules: ["./rules"] }, { "rules/a.md": "Rule A" });
        await install("../valid-pkg");

        const invalidDir = join(tmpDir, "invalid-pkg");
        writeFixturePackage(invalidDir, { schemaVersion: 1, bogus: true });
        await install("../invalid-pkg", { allowInvalidOverlay: true });

        const { packages, warnings } = resolveSessionOverlays(cwd, agentDir, true);
        expect(packages).toHaveLength(1);
        expect(packages[0]!.source).toContain("valid-pkg");
        expect(warnings.some((w) => w.includes("bogus"))).toBe(true);
    });

    test("collectOverlayAgentDirs partitions user vs project scope", async () => {
        const userPkg = join(tmpDir, "user-agents-pkg");
        writeFixturePackage(userPkg, { schemaVersion: 1, agents: ["./agents"] }, { "agents/foo.md": "---\nname: foo\ndescription: Foo\n---\nBody" });
        await install("../user-agents-pkg");

        const projectPkg = join(tmpDir, "project-agents-pkg");
        writeFixturePackage(projectPkg, { schemaVersion: 1, agents: ["./agents"] }, { "agents/bar.md": "---\nname: bar\ndescription: Bar\n---\nBody" });
        await install("../project-agents-pkg", { project: true });

        const { userDirs, projectDirs } = collectOverlayAgentDirs(cwd, agentDir, true);
        expect(userDirs).toHaveLength(1);
        expect(userDirs[0]).toContain("user-agents-pkg");
        expect(projectDirs).toHaveLength(1);
        expect(projectDirs[0]).toContain("project-agents-pkg");
    });

    test("collectOverlayAgentDirs returns a single .md agents entry as a file, not folded into its directory", async () => {
        const pkg = join(tmpDir, "single-file-agents-pkg");
        writeFixturePackage(pkg, { schemaVersion: 1, agents: ["./agents/a.md"] }, {
            "agents/a.md": "---\nname: a\ndescription: A\n---\nBody A",
            "agents/b.md": "---\nname: b\ndescription: B\n---\nBody B",
        });
        await install("../single-file-agents-pkg");

        const { userDirs, userFiles } = collectOverlayAgentDirs(cwd, agentDir, true);
        expect(userDirs).toHaveLength(0);
        expect(userFiles).toHaveLength(1);
        expect(userFiles[0]).toContain("a.md");
        expect(userFiles.some((f) => f.endsWith("b.md"))).toBe(false);
    });

    test("project-scope overlays are excluded from resolution when the project is not explicitly trusted", async () => {
        const userPkg = join(tmpDir, "user-untrust-pkg");
        writeFixturePackage(userPkg, { schemaVersion: 1, agents: ["./agents"] }, { "agents/foo.md": "---\nname: foo\ndescription: Foo\n---\nBody" });
        await install("../user-untrust-pkg");

        const projectPkg = join(tmpDir, "project-untrust-pkg");
        writeFixturePackage(projectPkg, { schemaVersion: 1, agents: ["./agents"] }, { "agents/bar.md": "---\nname: bar\ndescription: Bar\n---\nBody" });
        await install("../project-untrust-pkg", { project: true });

        // projectTrusted: false — project-scope configured packages (and thus
        // their overlays) must not resolve at all, matching pi's own
        // SettingsManager behavior (getProjectSettings() returns {} when
        // untrusted).
        const trusted = resolveSessionOverlays(cwd, agentDir, true);
        expect(trusted.packages.some((p) => p.scope === "project")).toBe(true);

        const untrusted = resolveSessionOverlays(cwd, agentDir, false);
        expect(untrusted.packages.some((p) => p.scope === "project")).toBe(false);
        expect(untrusted.packages.some((p) => p.scope === "user")).toBe(true);

        const { projectDirs } = collectOverlayAgentDirs(cwd, agentDir, false);
        expect(projectDirs).toHaveLength(0);
    });

    test("collectOverlayRuleBlocks orders user-scope packages before project-scope packages", async () => {
        const projectPkg = join(tmpDir, "z-project-rules-pkg");
        writeFixturePackage(projectPkg, { schemaVersion: 1, rules: ["./rules"] }, { "rules/r.md": "Project rule" });
        await install("../z-project-rules-pkg", { project: true });

        const userPkg = join(tmpDir, "a-user-rules-pkg");
        writeFixturePackage(userPkg, { schemaVersion: 1, rules: ["./rules"] }, { "rules/r.md": "User rule" });
        await install("../a-user-rules-pkg");

        const blocks = collectOverlayRuleBlocks(cwd, agentDir, true);
        expect(blocks).toHaveLength(2);
        expect(blocks[0]!.scope).toBe("user");
        expect(blocks[0]!.text).toContain("User rule");
        expect(blocks[1]!.scope).toBe("project");
        expect(blocks[1]!.text).toContain("Project rule");
    });

    test("recursive rules directory traversal picks up nested .md files", async () => {
        const pkgDir = join(tmpDir, "nested-rules-pkg");
        writeFixturePackage(pkgDir, { schemaVersion: 1, rules: ["./rules"] }, {
            "rules/top.md": "Top rule",
            "rules/nested/deep.md": "Deep rule",
        });
        await install("../nested-rules-pkg");

        const blocks = collectOverlayRuleBlocks(cwd, agentDir, true);
        expect(blocks).toHaveLength(1);
        expect(blocks[0]!.text).toContain("Top rule");
        expect(blocks[0]!.text).toContain("Deep rule");
    });

    test("recursive rules directory traversal visits entries in deterministic sorted order", async () => {
        const pkgDir = join(tmpDir, "sorted-rules-pkg");
        writeFixturePackage(pkgDir, { schemaVersion: 1, rules: ["./rules"] }, {
            "rules/zeta.md": "Zeta",
            "rules/alpha.md": "Alpha",
            "rules/mid/b.md": "Mid B",
            "rules/mid/a.md": "Mid A",
        });
        await install("../sorted-rules-pkg");

        const blocks = collectOverlayRuleBlocks(cwd, agentDir, true);
        expect(blocks).toHaveLength(1);
        const text = blocks[0]!.text;
        // Sorted traversal: top-level entries alphabetically (alpha.md, mid/, zeta.md),
        // and within mid/, a.md before b.md.
        const alphaIdx = text.indexOf("Alpha");
        const midAIdx = text.indexOf("Mid A");
        const midBIdx = text.indexOf("Mid B");
        const zetaIdx = text.indexOf("Zeta");
        expect(alphaIdx).toBeGreaterThanOrEqual(0);
        expect(alphaIdx).toBeLessThan(midAIdx);
        expect(midAIdx).toBeLessThan(midBIdx);
        expect(midBIdx).toBeLessThan(zetaIdx);
    });
});
