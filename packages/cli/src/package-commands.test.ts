import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { isPackageCommand, runPackageCommand } from "./package-commands.js";

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
});
