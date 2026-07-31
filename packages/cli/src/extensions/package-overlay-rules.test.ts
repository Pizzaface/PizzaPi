import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPackageCommand } from "../package-commands.js";
import { _setGlobalConfigDir } from "../config/io.js";
import { createPackageOverlayRulesExtension } from "./package-overlay-rules.js";

describe("createPackageOverlayRulesExtension", () => {
    let tmpDir: string;
    let cwd: string;
    let agentDir: string;
    let originalCwd: string;
    let originalAgentDir: string | undefined;

    beforeEach(() => {
        tmpDir = mkdtempSync(join(tmpdir(), "pizzapi-overlayrules-"));
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

    async function install(relOrAbs: string) {
        const code = await runPackageCommand(["install", relOrAbs], cwd, agentDir);
        expect(code).toBe(0);
    }

    test("returns null when no configured package declares rules", () => {
        expect(createPackageOverlayRulesExtension(cwd, agentDir, true)).toBeNull();
    });

    test("appends rule content additively via before_agent_start", async () => {
        const pkgDir = join(tmpDir, "rules-pkg");
        writeFixturePackage(pkgDir, { schemaVersion: 1, rules: ["./rules"] }, { "rules/a.md": "Always be terse." });
        await install("../rules-pkg");

        const factory = createPackageOverlayRulesExtension(cwd, agentDir, true);
        expect(factory).not.toBeNull();

        let handler: ((event: { systemPrompt: string }) => Promise<{ systemPrompt: string }>) | undefined;
        const pi = {
            on(type: string, h: any) {
                if (type === "before_agent_start") handler = h;
            },
        };
        factory!(pi as any);
        expect(handler).toBeDefined();

        const result = await handler!({ systemPrompt: "BASE PROMPT" });
        expect(result.systemPrompt.startsWith("BASE PROMPT")).toBe(true);
        expect(result.systemPrompt).toContain("Always be terse.");
    });

    test("project-scope package rules are excluded when the project is not explicitly trusted", async () => {
        const pkgDir = join(tmpDir, "untrusted-rules-pkg");
        writeFixturePackage(pkgDir, { schemaVersion: 1, rules: ["./rules"] }, { "rules/a.md": "Secret project rule." });
        const code = await runPackageCommand(["install", "../untrusted-rules-pkg", "-l"], cwd, agentDir);
        expect(code).toBe(0);

        expect(createPackageOverlayRulesExtension(cwd, agentDir, false)).toBeNull();
        expect(createPackageOverlayRulesExtension(cwd, agentDir, true)).not.toBeNull();
    });
});
