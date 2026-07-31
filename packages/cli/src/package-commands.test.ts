import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { isPackageCommand, runPackageCommand } from "./package-commands.js";
import { _setGlobalConfigDir } from "./config/io.js";
import { getGrantedServiceIds } from "./overlay/grants.js";
import { handlePostUpdateOverlay, snapshotOverlayServiceIds } from "./overlay/cli-support.js";

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

    test("install rejects a preferred MCP sidecar without an explicit transport", async () => {
        const agentDir = join(tmpDir, "agent");
        const cwd = join(tmpDir, "project");
        const pkgDir = join(tmpDir, "bad-mcp-pkg");
        writeFixturePackage(pkgDir, { schemaVersion: 1, mcp: "./mcp.json" });
        writeFileSync(join(pkgDir, "mcp.json"), JSON.stringify({ mcp: { servers: [{ name: "godmother", command: "godmother" }] } }));

        const originalError = console.error;
        const errors: string[] = [];
        console.error = ((...a: unknown[]) => { errors.push(a.join(" ")); }) as typeof console.error;
        let code: number;
        try {
            code = await runPackageCommand(["install", "../bad-mcp-pkg"], cwd, agentDir);
        } finally {
            console.error = originalError;
        }

        expect(code).not.toBe(0);
        expect(errors.join("\n")).toContain("mcp.servers[0].transport");
        expect(errors.join("\n")).toContain("pi-native package install may remain");
    });

    // P1: `pizza config grant` must require the normalized identity to exist
    // in DefaultPackageManager.listConfiguredPackages() at USER scope —
    // an arbitrary local directory that merely exists on disk (never
    // installed/configured) must be rejected. Exact repro: fresh agentDir
    // with no settings.json at all.
    test("config grant rejects an arbitrary local directory that was never installed (no settings.json)", async () => {
        const agentDir = join(tmpDir, "agent");
        const cwd = join(tmpDir, "project");
        expect(existsSync(join(agentDir, "settings.json"))).toBe(false);

        const outsideDir = join(tmpDir, "never-installed-pkg");
        writeFixturePackage(outsideDir, {
            schemaVersion: 1,
            services: [{ id: "github", label: "GitHub", entry: "./service.ts" }],
        });

        const originalError = console.error;
        const errors: string[] = [];
        console.error = ((...a: unknown[]) => { errors.push(a.join(" ")); }) as typeof console.error;
        let code: number;
        try {
            code = await runPackageCommand(["config", "grant", outsideDir], cwd, agentDir);
        } finally {
            console.error = originalError;
        }

        expect(code).not.toBe(0);
        expect(errors.join("\n")).toContain("no valid pi.pizzapi overlay found");
        expect(getGrantedServiceIds("local:" + realpathSync(outsideDir)).size).toBe(0);
        // Still no settings.json — the rejected grant attempt didn't configure the package either.
        expect(existsSync(join(agentDir, "settings.json"))).toBe(false);
    });

    // P2: `pizza list` must dedupe the same package identity across user and
    // project scope (project wins), preserving stable order and using the
    // correct per-scope base dir (agentDir for user, <cwd>/.pizzapi for
    // project) to compute identity. Reaches the real `list` command path.
    test("list dedupes the same package identity configured in both user and project scope (project wins, one line)", async () => {
        const agentDir = join(tmpDir, "deeply", "nested", "agent");
        const cwd = join(tmpDir, "project");
        mkdirSync(agentDir, { recursive: true });
        mkdirSync(cwd, { recursive: true });

        const pkgDir = join(tmpDir, "shared-pkg");
        writeFixturePackage(pkgDir, {
            schemaVersion: 1,
            services: [{ id: "github", label: "GitHub", entry: "./service.ts" }],
        });

        // Same absolute path configured at both scopes so identity matches
        // regardless of each scope's base dir (agentDir vs <cwd>/.pizzapi).
        writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [pkgDir] }));
        const projectPizzapiDir = join(cwd, ".pizzapi");
        mkdirSync(projectPizzapiDir, { recursive: true });
        writeFileSync(join(projectPizzapiDir, "settings.json"), JSON.stringify({ packages: [pkgDir] }));

        const originalLog = console.log;
        const logs: string[] = [];
        console.log = ((...a: unknown[]) => { logs.push(a.join(" ")); }) as typeof console.log;
        let code: number;
        try {
            code = await runPackageCommand(["list"], cwd, agentDir);
        } finally {
            console.log = originalLog;
        }

        expect(code).toBe(0);
        const identity = "local:" + realpathSync(pkgDir);
        const matchingLines = logs.filter((l) => l.includes(identity));
        expect(matchingLines).toHaveLength(1);
        expect(matchingLines[0]).toContain("(project)");
    });

    // P2: package update must snapshot declared overlay service ids/validity
    // before and after, then process changed/new overlays without blindly
    // granting. Existing-service grants persist; new ids surface as
    // untrusted; a newly-malformed overlay fails the command with
    // partial-update remediation. Reaches the real `update` command path.
    test("update: existing grant persists, a newly-declared service id stays untrusted (not auto-granted)", async () => {
        const agentDir = join(tmpDir, "agent");
        const cwd = join(tmpDir, "project");
        const pkgDir = join(tmpDir, "svc-pkg-update");
        writeFixturePackage(pkgDir, {
            schemaVersion: 1,
            services: [{ id: "github", label: "GitHub", entry: "./service.ts" }],
        });

        const installCode = await runPackageCommand(["install", "../svc-pkg-update", "--allow-daemon-services"], cwd, agentDir);
        expect(installCode).toBe(0);
        const identity = "local:" + realpathSync(pkgDir);
        expect(getGrantedServiceIds(identity)).toEqual(new Set(["github"]));

        // Local sources are update no-ops in upstream (only npm/git are
        // re-fetched), so there is no way to observe a before/after content
        // transition through a single `runPackageCommand(["update"])` call
        // with a local fixture — nothing mutates the package between the
        // internal before/after snapshots taken inside one call. Exercise
        // the exact functions `runPackageCommand`'s update branch calls
        // (snapshotOverlayServiceIds before, handlePostUpdateOverlay after)
        // directly, with the mutation happening between them, matching
        // exactly how a real npm/git update would be observed.
        const before = snapshotOverlayServiceIds(cwd, agentDir);
        expect(before.get(identity)?.serviceIds).toEqual(["github"]);

        writeFileSync(
            join(pkgDir, "package.json"),
            JSON.stringify({
                name: "fixture",
                pi: {
                    pizzapi: {
                        schemaVersion: 1,
                        services: [
                            { id: "github", label: "GitHub", entry: "./service.ts" },
                            { id: "gitlab", label: "GitLab", entry: "./service.ts" },
                        ],
                    },
                },
            }),
        );

        const originalLog = console.log;
        const logs: string[] = [];
        console.log = ((...a: unknown[]) => { logs.push(a.join(" ")); }) as typeof console.log;
        let updateCode: number;
        try {
            updateCode = handlePostUpdateOverlay(cwd, agentDir, before);
        } finally {
            console.log = originalLog;
        }

        expect(updateCode).toBe(0);
        // Existing grant persists untouched.
        expect(getGrantedServiceIds(identity)).toEqual(new Set(["github"]));
        // New id was never granted, but is surfaced.
        expect(logs.join("\n")).toContain("gitlab");
        expect(logs.join("\n")).toContain("untrusted");
    });

    test("update: overlay that becomes malformed after update fails the command with remediation", async () => {
        const agentDir = join(tmpDir, "agent");
        const cwd = join(tmpDir, "project");
        const pkgDir = join(tmpDir, "svc-pkg-update-bad");
        writeFixturePackage(pkgDir, {
            schemaVersion: 1,
            services: [{ id: "github", label: "GitHub", entry: "./service.ts" }],
        });

        const installCode = await runPackageCommand(["install", "../svc-pkg-update-bad"], cwd, agentDir);
        expect(installCode).toBe(0);

        // Simulate an update that ships a broken overlay.
        writeFileSync(
            join(pkgDir, "package.json"),
            JSON.stringify({ name: "fixture", pi: { pizzapi: { schemaVersion: 1, bogusKey: true } } }),
        );

        const originalError = console.error;
        const errors: string[] = [];
        console.error = ((...a: unknown[]) => { errors.push(a.join(" ")); }) as typeof console.error;
        let updateCode: number;
        try {
            updateCode = await runPackageCommand(["update"], cwd, agentDir);
        } finally {
            console.error = originalError;
        }

        expect(updateCode).not.toBe(0);
        expect(errors.join("\n")).toContain("invalid");
    });
});
