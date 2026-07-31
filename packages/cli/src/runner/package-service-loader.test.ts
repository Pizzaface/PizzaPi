import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPackageCommand } from "../package-commands.js";
import { _setGlobalConfigDir } from "../config/io.js";
import { grantServices } from "../overlay/grants.js";
import { discoverPackageServices } from "./package-service-loader.js";

describe("discoverPackageServices", () => {
    let tmpDir: string;
    let cwd: string;
    let agentDir: string;
    let originalCwd: string;
    let originalAgentDir: string | undefined;

    beforeEach(() => {
        tmpDir = mkdtempSync(join(tmpdir(), "pizzapi-pkgsvc-"));
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

    /** Writes a marker file on import so tests can prove import did/didn't happen. */
    function writeMarkerService(dir: string, id: string, markerPath: string) {
        mkdirSync(dir, { recursive: true });
        writeFileSync(
            join(dir, "service.ts"),
            `import { writeFileSync } from "node:fs";\n` +
            `writeFileSync(${JSON.stringify(markerPath)}, "imported");\n` +
            `export default { id: ${JSON.stringify(id)}, init() {}, dispose() {} };\n`,
        );
    }

    function writeFixturePackage(dir: string, overlay: unknown) {
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fixture", pi: { pizzapi: overlay } }));
    }

    async function installLocal(relOrAbs: string) {
        const code = await runPackageCommand(["install", relOrAbs], cwd, agentDir);
        expect(code).toBe(0);
    }

    test("configured-only discovery: an orphan install directory not in settings is never inspected", async () => {
        const orphanDir = join(tmpDir, "orphan-pkg");
        const markerPath = join(tmpDir, "orphan-marker.txt");
        writeFixturePackage(orphanDir, { schemaVersion: 1, services: [{ id: "orphan-svc", label: "Orphan", entry: "./service.ts" }] });
        writeMarkerService(orphanDir, "orphan-svc", markerPath);
        // NOT installed/configured — just sitting on disk.

        const { services, errors } = await discoverPackageServices({ cwd, agentDir });
        expect(services).toHaveLength(0);
        expect(errors.find((e) => e.error.includes("orphan-svc"))).toBeUndefined();
        expect(existsSync(markerPath)).toBe(false);
    });

    test("missing configured source is skipped with a warning, no import, no crash", async () => {
        const pkgDir = join(tmpDir, "vanishing-pkg");
        writeFixturePackage(pkgDir, { schemaVersion: 1, services: [{ id: "svc", label: "Svc", entry: "./service.ts" }] });
        writeFileSync(join(pkgDir, "service.ts"), "export default { id: 'svc', init(){}, dispose(){} };");
        await installLocal("../vanishing-pkg");
        // Simulate the install directory disappearing after configuration.
        rmSync(pkgDir, { recursive: true, force: true });

        const { services, errors } = await discoverPackageServices({ cwd, agentDir });
        expect(services).toHaveLength(0);
        expect(errors.some((e) => e.error.includes("not installed") && e.error.includes("skipping"))).toBe(true);
    });

    test("service module is never imported before grant (untrusted service)", async () => {
        const pkgDir = join(tmpDir, "untrusted-pkg");
        const markerPath = join(tmpDir, "untrusted-marker.txt");
        writeFixturePackage(pkgDir, { schemaVersion: 1, services: [{ id: "untrusted-svc", label: "X", entry: "./service.ts" }] });
        writeMarkerService(pkgDir, "untrusted-svc", markerPath);
        await installLocal("../untrusted-pkg");
        // No grantServices() call — service remains untrusted.

        const { services, errors } = await discoverPackageServices({ cwd, agentDir });
        expect(services).toHaveLength(0);
        expect(errors.some((e) => e.error.includes("not granted"))).toBe(true);
        expect(existsSync(markerPath)).toBe(false);
    });

    test("granted service is imported and registered with a matching handler id", async () => {
        const pkgDir = join(tmpDir, "granted-pkg");
        const markerPath = join(tmpDir, "granted-marker.txt");
        writeFixturePackage(pkgDir, { schemaVersion: 1, services: [{ id: "granted-svc", label: "X", entry: "./service.ts" }] });
        writeMarkerService(pkgDir, "granted-svc", markerPath);
        await installLocal("../granted-pkg");
        const identity = "local:" + realpathSync(pkgDir);
        grantServices(identity, ["granted-svc"]);

        const { services, errors } = await discoverPackageServices({ cwd, agentDir });
        expect(errors).toEqual([]);
        expect(services).toHaveLength(1);
        expect(services[0]!.handler.id).toBe("granted-svc");
        expect(services[0]!.source.origin).toBe("package");
        expect(services[0]!.source.pluginName).toBe(identity);
        expect(existsSync(markerPath)).toBe(true);
    });

    test("disabled service is never imported even when granted", async () => {
        const pkgDir = join(tmpDir, "disabled-pkg");
        const markerPath = join(tmpDir, "disabled-marker.txt");
        writeFixturePackage(pkgDir, { schemaVersion: 1, services: [{ id: "disabled-svc", label: "X", entry: "./service.ts" }] });
        writeMarkerService(pkgDir, "disabled-svc", markerPath);
        await installLocal("../disabled-pkg");
        const identity = "local:" + realpathSync(pkgDir);
        grantServices(identity, ["disabled-svc"]);

        const { services } = await discoverPackageServices({ cwd, agentDir, disabledIds: new Set(["disabled-svc"]) });
        expect(services).toHaveLength(0);
        expect(existsSync(markerPath)).toBe(false);
    });

    test("project-scope package with a declared service warns and is skipped, never imported", async () => {
        const pkgDir = join(tmpDir, "project-pkg");
        const markerPath = join(tmpDir, "project-marker.txt");
        writeFixturePackage(pkgDir, { schemaVersion: 1, services: [{ id: "project-svc", label: "X", entry: "./service.ts" }] });
        writeMarkerService(pkgDir, "project-svc", markerPath);
        const code = await runPackageCommand(["install", "../project-pkg", "--local"], cwd, agentDir);
        expect(code).toBe(0);
        const identity = "local:" + realpathSync(pkgDir);
        grantServices(identity, ["project-svc"]); // even if granted, project scope must not mount

        const { services, errors } = await discoverPackageServices({ cwd, agentDir });
        expect(services).toHaveLength(0);
        expect(errors.some((e) => e.error.includes("project-svc") && e.error.includes("schema v1"))).toBe(true);
        expect(existsSync(markerPath)).toBe(false);
    });

    test("handler id mismatch is rejected", async () => {
        const pkgDir = join(tmpDir, "mismatch-pkg");
        writeFixturePackage(pkgDir, { schemaVersion: 1, services: [{ id: "declared-id", label: "X", entry: "./service.ts" }] });
        mkdirSync(pkgDir, { recursive: true });
        writeFileSync(join(pkgDir, "service.ts"), "export default { id: 'actual-id', init(){}, dispose(){} };");
        await installLocal("../mismatch-pkg");
        const identity = "local:" + realpathSync(pkgDir);
        grantServices(identity, ["declared-id"]);

        const { services, errors } = await discoverPackageServices({ cwd, agentDir });
        expect(services).toHaveLength(0);
        expect(errors.some((e) => e.error.includes("does not match the declared id"))).toBe(true);
    });

    test("built-in service ids are reserved — a package cannot impersonate one, even granted", async () => {
        const pkgDir = join(tmpDir, "impersonator-pkg");
        writeFixturePackage(pkgDir, { schemaVersion: 1, services: [{ id: "terminal", label: "X", entry: "./service.ts" }] });
        writeFileSync(join(pkgDir, "service.ts"), "export default { id: 'terminal', init(){}, dispose(){} };");
        await installLocal("../impersonator-pkg");
        const identity = "local:" + realpathSync(pkgDir);
        grantServices(identity, ["terminal"]);

        const { services, errors } = await discoverPackageServices({ cwd, agentDir });
        expect(services).toHaveLength(0);
        expect(errors.some((e) => e.error.includes("reserved built-in"))).toBe(true);
    });

    test("package-vs-package collision: first configured package wins, stable order", async () => {
        const pkgADir = join(tmpDir, "pkg-a");
        const pkgBDir = join(tmpDir, "pkg-b");
        writeFixturePackage(pkgADir, { schemaVersion: 1, services: [{ id: "shared-id", label: "A", entry: "./service.ts" }] });
        writeFileSync(join(pkgADir, "service.ts"), "export default { id: 'shared-id', init(){}, dispose(){} };");
        writeFixturePackage(pkgBDir, { schemaVersion: 1, services: [{ id: "shared-id", label: "B", entry: "./service.ts" }] });
        writeFileSync(join(pkgBDir, "service.ts"), "export default { id: 'shared-id', init(){}, dispose(){} };");

        await installLocal("../pkg-a");
        await installLocal("../pkg-b");
        const identityA = "local:" + realpathSync(pkgADir);
        const identityB = "local:" + realpathSync(pkgBDir);
        grantServices(identityA, ["shared-id"]);
        grantServices(identityB, ["shared-id"]);

        const { services, errors } = await discoverPackageServices({ cwd, agentDir });
        expect(services).toHaveLength(1);
        expect(services[0]!.source.pluginName).toBe(identityA); // first configured wins
        expect(errors.some((e) => e.error.includes("collides with already-registered package"))).toBe(true);
    });

    test("corrupt GLOBAL settings make discovery non-authoritative, not an empty valid result (fix #1)", async () => {
        // Malformed JSON in the global (user-scope) settings file — this is
        // what `DefaultPackageManager.listConfiguredPackages()` silently
        // degrades to `[]` for, which must NOT be read as "user has no
        // packages configured".
        writeFileSync(join(agentDir, "settings.json"), "{ not valid json");

        const { services, errors, authoritative } = await discoverPackageServices({ cwd, agentDir });
        expect(services).toHaveLength(0);
        expect(authoritative).toBe(false);
        expect(errors.some((e) => e.error.includes("not authoritative"))).toBe(true);
    });

    test("a project-scope settings load error does NOT flip authoritative (fix #1)", async () => {
        // Project settings failures must not gate user-scope daemon service
        // discovery — only GLOBAL (user-scope) load errors do.
        mkdirSync(join(cwd, ".pizzapi"), { recursive: true });
        writeFileSync(join(cwd, ".pizzapi", "settings.json"), "{ not valid json");

        const { authoritative } = await discoverPackageServices({ cwd, agentDir });
        expect(authoritative).toBe(true);
    });

    test("an untrusted (ungranted) first package still reserves its id — a later granted package cannot impersonate it (fix #5)", async () => {
        const pkgADir = join(tmpDir, "untrusted-first");
        const pkgBDir = join(tmpDir, "granted-second");
        writeFixturePackage(pkgADir, { schemaVersion: 1, services: [{ id: "shared-id", label: "A", entry: "./service.ts" }] });
        writeFileSync(join(pkgADir, "service.ts"), "export default { id: 'shared-id', init(){}, dispose(){} };");
        writeFixturePackage(pkgBDir, { schemaVersion: 1, services: [{ id: "shared-id", label: "B", entry: "./service.ts" }] });
        writeFileSync(join(pkgBDir, "service.ts"), "export default { id: 'shared-id', init(){}, dispose(){} };");

        await installLocal("../untrusted-first");
        await installLocal("../granted-second");
        const identityB = "local:" + realpathSync(pkgBDir);
        // Only B is granted — A is left untrusted (broken/untrusted-first case).
        grantServices(identityB, ["shared-id"]);

        const { services, errors } = await discoverPackageServices({ cwd, agentDir });
        expect(services).toHaveLength(0); // A is untrusted, B is blocked by A's reservation
        expect(errors.some((e) => e.error.includes("is not granted"))).toBe(true);
        expect(errors.some((e) => e.error.includes("collides with already-registered package"))).toBe(true);
    });

    test("panel.dir failing re-validation immediately before use rejects the whole service (fix #2, TOCTOU)", async () => {
        // A pre-deleted panel dir would already be caught by
        // readOverlayManifest()'s own validation (before the per-service
        // TOCTOU recheck even runs) — to exercise the *actual* re-validation
        // gap, delete the panel dir as a side effect of importing the entry
        // module. Manifest validation (which reads panel.dir first) has
        // already passed by the time the entry is imported; the panel-dir
        // recheck runs immediately AFTER import, so it must catch this.
        const pkgDir = join(tmpDir, "panel-toctou-pkg");
        const panelDir = join(pkgDir, "panel");
        writeFixturePackage(pkgDir, {
            schemaVersion: 1,
            services: [{ id: "panel-svc", label: "X", entry: "./service.ts", panel: { dir: "./panel" } }],
        });
        writeFileSync(
            join(pkgDir, "service.ts"),
            `import { rmSync } from "node:fs";\n` +
            `rmSync(${JSON.stringify(panelDir)}, { recursive: true, force: true });\n` +
            `export default { id: "panel-svc", init(){}, dispose(){} };\n`,
        );
        mkdirSync(panelDir, { recursive: true });
        writeFileSync(join(panelDir, "index.html"), "<html></html>");
        await installLocal("../panel-toctou-pkg");
        const identity = "local:" + realpathSync(pkgDir);
        grantServices(identity, ["panel-svc"]);

        const { services, errors } = await discoverPackageServices({ cwd, agentDir });
        expect(services).toHaveLength(0); // never register a broken-panel service
        expect(errors.some((e) => e.error.includes("panel.dir failed re-validation"))).toBe(true);
    });

    test("a package service with only triggers/sigils (no panel) gets hasPanel: false in its manifest (fix #3)", async () => {
        const pkgDir = join(tmpDir, "no-panel-pkg");
        writeFixturePackage(pkgDir, {
            schemaVersion: 1,
            services: [{
                id: "sigil-svc",
                label: "X",
                entry: "./service.ts",
                sigils: [{ type: "thing", label: "Thing" }],
            }],
        });
        writeFileSync(join(pkgDir, "service.ts"), "export default { id: 'sigil-svc', init(){}, dispose(){} };");
        await installLocal("../no-panel-pkg");
        const identity = "local:" + realpathSync(pkgDir);
        grantServices(identity, ["sigil-svc"]);

        const { services, errors } = await discoverPackageServices({ cwd, agentDir });
        expect(errors).toEqual([]);
        expect(services).toHaveLength(1);
        expect(services[0]!.manifest?.hasPanel).toBe(false);
        expect(services[0]!.manifest?.panel).toBeUndefined();
    });

    test("a package service with a panel gets hasPanel: true in its manifest (fix #3)", async () => {
        const pkgDir = join(tmpDir, "with-panel-pkg");
        writeFixturePackage(pkgDir, {
            schemaVersion: 1,
            services: [{ id: "panel-svc2", label: "X", entry: "./service.ts", panel: { dir: "./panel" } }],
        });
        writeFileSync(join(pkgDir, "service.ts"), "export default { id: 'panel-svc2', init(){}, dispose(){} };");
        mkdirSync(join(pkgDir, "panel"), { recursive: true });
        writeFileSync(join(pkgDir, "panel", "index.html"), "<html></html>");
        await installLocal("../with-panel-pkg");
        const identity = "local:" + realpathSync(pkgDir);
        grantServices(identity, ["panel-svc2"]);

        const { services, errors } = await discoverPackageServices({ cwd, agentDir });
        expect(errors).toEqual([]);
        expect(services).toHaveLength(1);
        expect(services[0]!.manifest?.hasPanel).toBe(true);
    });

    test("one invalid package does not block discovery of a valid one", async () => {
        const badPkgDir = join(tmpDir, "bad-pkg");
        const goodPkgDir = join(tmpDir, "good-pkg");
        writeFixturePackage(badPkgDir, { schemaVersion: 1, bogusKey: true });
        writeFixturePackage(goodPkgDir, { schemaVersion: 1, services: [{ id: "good-svc", label: "Good", entry: "./service.ts" }] });
        writeFileSync(join(goodPkgDir, "service.ts"), "export default { id: 'good-svc', init(){}, dispose(){} };");

        // "install" (via runPackageCommand) would refuse the malformed
        // overlay non-zero; configure both packages directly in settings.json
        // instead, mirroring the "list dedupes" test's direct-settings-write
        // pattern, so both are configured regardless of overlay validity.
        writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [badPkgDir, goodPkgDir] }));
        const goodIdentity = "local:" + realpathSync(goodPkgDir);
        grantServices(goodIdentity, ["good-svc"]);

        const { services, errors } = await discoverPackageServices({ cwd, agentDir });
        expect(services).toHaveLength(1);
        expect(services[0]!.handler.id).toBe("good-svc");
        expect(errors.some((e) => e.error.includes("bogusKey"))).toBe(true);
    });
});
