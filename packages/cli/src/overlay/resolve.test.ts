import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { packageManagerFor, dedupeConfiguredPackages, type ConfiguredPkg } from "./resolve.js";

describe("dedupeConfiguredPackages — order within the winning scope", () => {
    function pkg(source: string, scope: "user" | "project"): ConfiguredPkg {
        return { source, scope, filtered: false, installedPath: `/pkgs/${scope}/${source}` } as ConfiguredPkg;
    }

    test("a project entry replacing a user entry takes the PROJECT's own position, not the user entry's", () => {
        // Configured order (mirrors pi's listConfiguredPackages: all user
        // entries, then all project entries, each in settings-file order):
        //   user:    [A, B]
        //   project: [B', A']   (reversed relative to user)
        // A single-pass "replace in place" implementation anchors each
        // winner at the LOSER's position, yielding [A', B'] — reversed from
        // the actual project settings file order. The fix must yield the
        // project file's own order: [B', A'].
        const configured = [
            pkg("npm:@acme/a", "user"),
            pkg("npm:@acme/b", "user"),
            pkg("npm:@acme/b", "project"),
            pkg("npm:@acme/a", "project"),
        ];
        const deduped = dedupeConfiguredPackages(configured, "/cwd", "/agent");
        expect(deduped.map((d) => d.pkg.scope)).toEqual(["project", "project"]);
        expect(deduped.map((d) => d.identity)).toEqual(["npm:@acme/b", "npm:@acme/a"]);
    });

    test("user-only and project-only entries keep their own settings-file order untouched", () => {
        const configured = [
            pkg("npm:@acme/u1", "user"),
            pkg("npm:@acme/u2", "user"),
            pkg("npm:@acme/p1", "project"),
            pkg("npm:@acme/p2", "project"),
        ];
        const deduped = dedupeConfiguredPackages(configured, "/cwd", "/agent");
        expect(deduped.map((d) => d.identity)).toEqual([
            "npm:@acme/u1",
            "npm:@acme/u2",
            "npm:@acme/p1",
            "npm:@acme/p2",
        ]);
    });
});

describe("packageManagerFor — corrupt settings", () => {
    let tmpDir: string;
    let cwd: string;
    let agentDir: string;
    let originalWarn: typeof console.warn;
    let warnCalls: string[];

    beforeEach(() => {
        tmpDir = mkdtempSync(join(tmpdir(), "pizzapi-resolve-"));
        cwd = join(tmpDir, "project");
        agentDir = join(tmpDir, "agent");
        mkdirSync(cwd, { recursive: true });
        mkdirSync(agentDir, { recursive: true });
        warnCalls = [];
        originalWarn = console.warn;
        console.warn = (...args: unknown[]) => { warnCalls.push(args.join(" ")); };
    });

    afterEach(() => {
        console.warn = originalWarn;
        rmSync(tmpDir, { recursive: true, force: true });
    });

    test("a corrupt user-scope settings.json warns once and still resolves project-scope packages (scopes are isolated)", () => {
        writeFileSync(join(agentDir, "settings.json"), "{ not valid json");
        mkdirSync(join(cwd, ".pizzapi"), { recursive: true });
        writeFileSync(join(cwd, ".pizzapi", "settings.json"), JSON.stringify({ packages: ["npm:@acme/ok"] }));

        const pm = packageManagerFor(cwd, agentDir, true);
        const configured = pm.listConfiguredPackages();

        // Global (user) scope is corrupt -> empty, but project scope still
        // resolves independently.
        expect(configured.some((p) => p.scope === "project" && p.source === "npm:@acme/ok")).toBe(true);

        const joined = warnCalls.join("\n");
        expect(joined).toContain("global");
        expect(joined.toLowerCase()).toContain("fail");

        // A second call with the SAME error must not warn again.
        const warnCountAfterFirst = warnCalls.length;
        packageManagerFor(cwd, agentDir, true).listConfiguredPackages();
        expect(warnCalls.length).toBe(warnCountAfterFirst);
    });
});
