/**
 * P0 end-to-end characterization: an untrusted project's native pi
 * extensions AND session-side `pi.pizzapi` overlay (agents/rules/mcp) must
 * both be absent; a trusted project's must both be present. Exercises the
 * REAL `DefaultResourceLoader` + `SettingsManager` + `ProjectTrustStore`
 * pipeline `index.ts`/`worker.ts` use — not a mock — so a regression that
 * re-introduces implicit trust (e.g. dropping `{ projectTrusted }` from a
 * `SettingsManager.create()` call) fails this test.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DefaultResourceLoader, ProjectTrustStore, SettingsManager } from "@earendil-works/pi-coding-agent";
import { runPackageCommand } from "../package-commands.js";
import { resolveExplicitProjectTrust, _setGlobalConfigDir } from "./io.js";
import { resolveSessionOverlays } from "../overlay/session-packages.js";
import { mergeOverlayMcpServers } from "../extensions/mcp-overlay.js";

describe("project-trust gate — native extensions + pi.pizzapi overlay (session-side)", () => {
    let tmpDir: string;
    let cwd: string;
    let agentDir: string;
    let originalCwd: string;
    let originalAgentDirEnv: string | undefined;

    beforeEach(() => {
        // runPackageCommand() chdir()s the process into cwd and only sets
        // PI_CODING_AGENT_DIR when unset — both must be restored, or the
        // NEXT test file to run in this same bun test process inherits a
        // deleted tmp directory as its cwd (breaking anything that shells
        // out or resolves relative paths) and/or a stale agentDir.
        originalCwd = process.cwd();
        originalAgentDirEnv = process.env.PI_CODING_AGENT_DIR;
        delete process.env.PI_CODING_AGENT_DIR;
        tmpDir = mkdtempSync(join(tmpdir(), "pizzapi-trust-gate-"));
        cwd = join(tmpDir, "project");
        agentDir = join(tmpDir, "agent");
        mkdirSync(cwd, { recursive: true });
        mkdirSync(agentDir, { recursive: true });
        _setGlobalConfigDir(join(tmpDir, "global-config"));
    });

    afterEach(() => {
        process.chdir(originalCwd);
        if (originalAgentDirEnv === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = originalAgentDirEnv;
        _setGlobalConfigDir(null);
        rmSync(tmpDir, { recursive: true, force: true });
    });

    function writeNativeProjectExtension(): void {
        const dir = join(cwd, ".pizzapi", "extensions");
        mkdirSync(dir, { recursive: true });
        writeFileSync(
            join(dir, "marker.ts"),
            "export default function markerExtension(pi) {\n" +
                "  pi.registerTool({ name: 'trust_gate_marker', label: 'marker', description: 'marker', parameters: { type: 'object', properties: {} }, async execute() { return { content: [] }; } });\n" +
                "}\n",
        );
    }

    function writeOverlayPackage(scope: "user" | "project"): void {
        const pkgDir = join(tmpDir, `overlay-pkg-${scope}`);
        mkdirSync(join(pkgDir, "agents"), { recursive: true });
        mkdirSync(join(pkgDir, "rules"), { recursive: true });
        writeFileSync(
            join(pkgDir, "package.json"),
            JSON.stringify({
                name: "overlay-pkg",
                pi: { pizzapi: { schemaVersion: 1, agents: ["./agents"], rules: ["./rules"], mcp: "./.mcp.json" } },
            }),
        );
        writeFileSync(join(pkgDir, "agents", "a.md"), "---\nname: a\ndescription: A\n---\nBody");
        writeFileSync(join(pkgDir, "rules", "r.md"), "A project rule.");
        writeFileSync(join(pkgDir, ".mcp.json"), JSON.stringify({ mcpServers: { fromOverlay: { command: "echo" } } }));
    }

    async function installProjectPackage(): Promise<void> {
        writeOverlayPackage("project");
        const code = await runPackageCommand(["install", "../overlay-pkg-project", "-l"], cwd, agentDir);
        expect(code).toBe(0);
    }

    test("untrusted project: native pi extension is NOT loaded, and overlay agents/rules/mcp are absent", async () => {
        // Install FIRST, then add the native extension — pi's own package-
        // command CLI trust check treats a cwd with no trust-requiring
        // resources YET as safe to write project settings.json into
        // (hasTrustRequiringProjectResources()); adding `.pizzapi/extensions`
        // first would make the install itself refuse non-interactively.
        await installProjectPackage();
        writeNativeProjectExtension();

        // No ProjectTrustStore entry at all — resolveExplicitProjectTrust must
        // fail closed (null decision treated as untrusted).
        const projectTrusted = resolveExplicitProjectTrust(cwd, agentDir);
        expect(projectTrusted).toBe(false);

        const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted });
        const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, noThemes: true });
        await loader.reload();

        const extensionPaths = loader.getExtensions().extensions.map((e: any) => e.path ?? e.resolvedPath ?? "");
        expect(extensionPaths.some((p: string) => p.includes("marker.ts"))).toBe(false);

        const overlays = resolveSessionOverlays(cwd, agentDir, projectTrusted);
        expect(overlays.packages.some((p) => p.scope === "project")).toBe(false);

        const { config, serverProvenance } = mergeOverlayMcpServers({}, cwd, agentDir, projectTrusted);
        expect(config.mcpServers?.fromOverlay).toBeUndefined();
        expect(serverProvenance).toHaveLength(0);
    });

    test("trusted project (explicit ProjectTrustStore entry): native pi extension IS loaded, and overlay agents/rules/mcp are present", async () => {
        await installProjectPackage();
        writeNativeProjectExtension();
        new ProjectTrustStore(agentDir).set(cwd, true);

        const projectTrusted = resolveExplicitProjectTrust(cwd, agentDir);
        expect(projectTrusted).toBe(true);

        const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted });
        const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, noThemes: true });
        await loader.reload();

        const extensionPaths = loader.getExtensions().extensions.map((e: any) => e.path ?? e.resolvedPath ?? "");
        expect(extensionPaths.some((p: string) => p.includes("marker.ts"))).toBe(true);

        const overlays = resolveSessionOverlays(cwd, agentDir, projectTrusted);
        expect(overlays.packages.some((p) => p.scope === "project")).toBe(true);

        const { config, serverProvenance } = mergeOverlayMcpServers({}, cwd, agentDir, projectTrusted);
        expect(config.mcpServers?.fromOverlay).toBeDefined();
        expect(serverProvenance.some((p) => p.name === "fromOverlay" && p.owner === "project")).toBe(true);
    });

    test("explicit distrust (ProjectTrustStore set to false) behaves identically to a never-decided project", async () => {
        await installProjectPackage();
        writeNativeProjectExtension();
        new ProjectTrustStore(agentDir).set(cwd, false);

        expect(resolveExplicitProjectTrust(cwd, agentDir)).toBe(false);
    });
});
