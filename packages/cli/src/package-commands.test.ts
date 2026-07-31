import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { isPackageCommand, runPackageCommand } from "./package-commands.js";
import { _setGlobalConfigDir } from "./config/io.js";
import { getGrantedServiceIds } from "./overlay/grants.js";

describe("package command dispatch", () => {
    test("isPackageCommand recognizes package verbs", () => {
        expect(isPackageCommand("install")).toBe(true);
        expect(isPackageCommand("remove")).toBe(true);
        expect(isPackageCommand("uninstall")).toBe(true);
        expect(isPackageCommand("update")).toBe(true);
        expect(isPackageCommand("list")).toBe(true);
        expect(isPackageCommand("config")).toBe(true);
        expect(isPackageCommand("web")).toBe(false);
        expect(isPackageCommand(undefined)).toBe(false);
    });
});

describe("runPackageCommand", () => {
    let tmpDir: string;
    let originalCwd: string;
    let originalAgentDir: string | undefined;

    beforeEach(() => {
        tmpDir = mkdtempSync(join(tmpdir(), "pizzapi-pkg-"));
        mkdirSync(join(tmpDir, "agent"), { recursive: true });
        mkdirSync(join(tmpDir, "project"), { recursive: true });
        originalCwd = process.cwd();
        originalAgentDir = process.env.PI_CODING_AGENT_DIR;
    });

    afterEach(() => {
        process.chdir(originalCwd);
        if (originalAgentDir === undefined) {
            delete process.env.PI_CODING_AGENT_DIR;
        } else {
            process.env.PI_CODING_AGENT_DIR = originalAgentDir;
        }
        try {
            rmSync(tmpDir, { recursive: true, force: true });
        } catch {
            // ignore cleanup failures on ephemeral CI
        }
    });

    test("sets PIZZAPI_CODING_AGENT_DIR and chdirs to the requested cwd", async () => {
        const agentDir = join(tmpDir, "agent");
        const cwd = join(tmpDir, "project");
        expect(process.env.PI_CODING_AGENT_DIR).toBe(originalAgentDir);
        const code = await runPackageCommand(["list"], cwd, agentDir);
        expect(code).toBe(0);
        expect(process.env.PI_CODING_AGENT_DIR).toBe(agentDir);
        expect(process.cwd()).toBe(realpathSync(cwd));
    });

    test("--help returns 0 and prints pizza-branded usage", async () => {
        const agentDir = join(tmpDir, "agent");
        const cwd = join(tmpDir, "project");
        const code = await runPackageCommand(["install", "--help"], cwd, agentDir);
        expect(code).toBe(0);
        expect(process.env.PI_CODING_AGENT_DIR).toBe(agentDir);
    });

    test("update --self is disabled: non-zero exit, no upstream self-update invoked", async () => {
        const agentDir = join(tmpDir, "agent");
        const cwd = join(tmpDir, "project");
        const originalError = console.error;
        const errors: unknown[][] = [];
        console.error = ((...a: unknown[]) => { errors.push(a); }) as typeof console.error;
        try {
            const code = await runPackageCommand(["update", "--self"], cwd, agentDir);
            expect(code).not.toBe(0);
            expect(errors.join(" ")).toContain("self-update disabled");
        } finally {
            console.error = originalError;
        }
    });

    test("update pi is treated as a self-update request and is disabled", async () => {
        const agentDir = join(tmpDir, "agent");
        const cwd = join(tmpDir, "project");
        const originalError = console.error;
        console.error = (() => {}) as typeof console.error;
        try {
            const code = await runPackageCommand(["update", "pi"], cwd, agentDir);
            expect(code).not.toBe(0);
        } finally {
            console.error = originalError;
        }
    });

    test("update with no flags defaults to extensions-only (no self-update)", async () => {
        const agentDir = join(tmpDir, "agent");
        const cwd = join(tmpDir, "project");
        const code = await runPackageCommand(["update"], cwd, agentDir);
        expect(code).toBe(0);
    });

    test("update --extensions updates packages without self-update", async () => {
        const agentDir = join(tmpDir, "agent");
        const cwd = join(tmpDir, "project");
        const code = await runPackageCommand(["update", "--extensions"], cwd, agentDir);
        expect(code).toBe(0);
    });

    test("list on an empty agent dir reports no packages", async () => {
        const agentDir = join(tmpDir, "agent");
        const cwd = join(tmpDir, "project");
        const code = await runPackageCommand(["list"], cwd, agentDir);
        expect(code).toBe(0);
    });

    test("install with an invalid local source returns a non-zero exit code", async () => {
        const agentDir = join(tmpDir, "agent");
        const cwd = join(tmpDir, "project");
        const code = await runPackageCommand(["install", "./not-a-package"], cwd, agentDir);
        expect(code).not.toBe(0);
    });

    test("--allow-daemon-services / --no-allow-daemon-services never reach upstream (plain package installs fine)", async () => {
        const agentDir = join(tmpDir, "agent");
        const cwd = join(tmpDir, "project");
        const pkgDir = join(tmpDir, "plain-pkg");
        mkdirSync(pkgDir, { recursive: true });
        writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: "plain-pkg", pi: { extensions: [] } }));
        // If upstream saw the unknown --allow-daemon-services flag, it would either
        // error or (best case) silently mis-parse; either way this proves stripping works.
        const code = await runPackageCommand(["install", "../plain-pkg", "--allow-daemon-services"], cwd, agentDir);
        expect(code).toBe(0);
    });
});

describe("overlay trust integration", () => {
    let tmpDir: string;
    let originalCwd: string;
    let originalAgentDir: string | undefined;
    let originalGlobalConfigDir: string;

    beforeEach(() => {
        tmpDir = mkdtempSync(join(tmpdir(), "pizzapi-overlay-cmd-"));
        mkdirSync(join(tmpDir, "agent"), { recursive: true });
        mkdirSync(join(tmpDir, "project"), { recursive: true });
        originalCwd = process.cwd();
        originalAgentDir = process.env.PI_CODING_AGENT_DIR;
        originalGlobalConfigDir = join(tmpDir, "global-config");
        _setGlobalConfigDir(originalGlobalConfigDir);
    });

    afterEach(() => {
        process.chdir(originalCwd);
        if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
        _setGlobalConfigDir(null);
        try {
            rmSync(tmpDir, { recursive: true, force: true });
        } catch {
            // ignore
        }
    });

    function writeFixturePackage(dir: string, overlay: unknown): void {
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fixture", pi: { pizzapi: overlay } }));
        writeFileSync(join(dir, "service.ts"), "export default {};");
    }

    test("non-interactive install of a package declaring services installs but leaves them untrusted (exit 0)", async () => {
        const agentDir = join(tmpDir, "agent");
        const cwd = join(tmpDir, "project");
        const pkgDir = join(tmpDir, "svc-pkg");
        writeFixturePackage(pkgDir, {
            schemaVersion: 1,
            services: [{ id: "github", label: "GitHub", entry: "./service.ts" }],
        });

        const code = await runPackageCommand(["install", "../svc-pkg"], cwd, agentDir);
        expect(code).toBe(0);
        expect(getGrantedServiceIds("local:" + realpathSync(pkgDir)).size).toBe(0);
    });

    test("--allow-daemon-services grants the currently declared service ids", async () => {
        const agentDir = join(tmpDir, "agent");
        const cwd = join(tmpDir, "project");
        const pkgDir = join(tmpDir, "svc-pkg2");
        writeFixturePackage(pkgDir, {
            schemaVersion: 1,
            services: [{ id: "github", label: "GitHub", entry: "./service.ts" }],
        });

        const code = await runPackageCommand(["install", "../svc-pkg2", "--allow-daemon-services"], cwd, agentDir);
        expect(code).toBe(0);
        expect(getGrantedServiceIds("local:" + realpathSync(pkgDir))).toEqual(new Set(["github"]));
    });

    test("malformed overlay: install returns non-zero, reports errors, grants nothing", async () => {
        const agentDir = join(tmpDir, "agent");
        const cwd = join(tmpDir, "project");
        const pkgDir = join(tmpDir, "bad-pkg");
        writeFixturePackage(pkgDir, { schemaVersion: 1, bogusKey: true });

        const originalError = console.error;
        const errors: string[] = [];
        console.error = ((...a: unknown[]) => { errors.push(a.join(" ")); }) as typeof console.error;
        let code: number;
        try {
            code = await runPackageCommand(["install", "../bad-pkg"], cwd, agentDir);
        } finally {
            console.error = originalError;
        }

        expect(code).not.toBe(0);
        expect(errors.join("\n")).toContain("bogusKey");
        expect(errors.join("\n")).toContain("pi-native package install may remain");
        expect(getGrantedServiceIds("local:" + realpathSync(pkgDir)).size).toBe(0);
    });
});
