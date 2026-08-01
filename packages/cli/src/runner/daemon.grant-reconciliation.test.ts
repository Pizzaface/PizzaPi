import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _setGlobalConfigDir } from "../config/io.js";
import { getOverlayServiceGrants, getGrantedServiceIds, grantServices } from "../overlay/grants.js";
import { computePackageIdentity } from "../overlay/identity.js";
import { reconcileOverlayGrants } from "./daemon.js";

/**
 * `reconcileOverlayGrants()` is the exact helper `runDaemon()` calls at
 * startup and the `reconfigure_services` socket handler calls on every
 * reconfiguration (daemon.ts). Testing it directly exercises that call
 * path's real behavior without needing to spin up the full socket.io
 * daemon — see the docstring on reconcileOverlayGrants() in daemon.ts.
 */
describe("reconcileOverlayGrants (daemon startup/reconfigure call path)", () => {
    const originalHome = process.env.HOME;
    let tmpDir: string;
    let home: string;
    let agentDir: string;
    let projectDir: string;
    let globalDir: string;

    function makePackage(name: string, serviceIds: string[]): string {
        const dir = join(agentDir, "packages", name);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "index.js"), "// noop\n");
        writeFileSync(
            join(dir, "package.json"),
            JSON.stringify({
                name,
                version: "1.0.0",
                pi: {
                    pizzapi: {
                        schemaVersion: 1,
                        services: serviceIds.map((id) => ({ id, label: id, entry: "./index.js" })),
                    },
                },
            }),
        );
        return dir;
    }

    beforeEach(() => {
        tmpDir = mkdtempSync(join(tmpdir(), "daemon-grant-reconcile-test-"));
        home = join(tmpDir, "home");
        agentDir = join(home, ".pizzapi");
        projectDir = join(tmpDir, "project");
        globalDir = join(tmpDir, "global");
        mkdirSync(join(projectDir, ".pizzapi"), { recursive: true });
        mkdirSync(agentDir, { recursive: true });
        writeFileSync(join(projectDir, ".pizzapi", "config.json"), JSON.stringify({ agentDir }));
        _setGlobalConfigDir(globalDir);
        process.env.HOME = home;
    });

    afterEach(() => {
        _setGlobalConfigDir(null);
        process.env.HOME = originalHome;
        rmSync(tmpDir, { recursive: true, force: true });
    });

    test("removes unconfigured package grants, trims undeclared ids, and keeps a fail-closed missing package's grant", () => {
        // Configured and installed: still declares "kept", no longer declares "dropped".
        const keptPkgPath = makePackage("pkg-kept", ["kept"]);
        const keptIdentity = computePackageIdentity(keptPkgPath, agentDir).identity;

        // Configured in settings.json but its installed path does not exist —
        // e.g. npm store not yet warmed at daemon boot. Must be left alone.
        const missingPkgPath = join(agentDir, "packages", "pkg-missing-not-on-disk");
        const missingIdentity = computePackageIdentity(missingPkgPath, agentDir).identity;

        // Configured path exists, but package.json is temporarily absent/corrupt.
        // This is unreadable, not proof that the package intentionally removed its overlay.
        const brokenPkgPath = join(agentDir, "packages", "pkg-broken-install");
        mkdirSync(brokenPkgPath, { recursive: true });
        const brokenIdentity = computePackageIdentity(brokenPkgPath, agentDir).identity;

        writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [keptPkgPath, missingPkgPath, brokenPkgPath] }));

        // Never configured at all — a pure orphan.
        const orphanIdentity = "npm:@acme/long-gone";

        grantServices(keptIdentity, ["kept", "dropped"]);
        grantServices(missingIdentity, ["still-trusted"]);
        grantServices(brokenIdentity, ["also-still-trusted"]);
        grantServices(orphanIdentity, ["gone"]);

        const writes: string[] = [];
        const originalWrite = process.stdout.write.bind(process.stdout);
        process.stdout.write = ((chunk: string | Uint8Array) => {
            writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
            return true;
        }) as typeof process.stdout.write;

        try {
            reconcileOverlayGrants(projectDir);
        } finally {
            process.stdout.write = originalWrite;
        }

        // Declared id kept, undeclared id trimmed.
        expect(getGrantedServiceIds(keptIdentity)).toEqual(new Set(["kept"]));
        // Fail-closed: missing installed path leaves the grant untouched.
        expect(getGrantedServiceIds(missingIdentity)).toEqual(new Set(["still-trusted"]));
        // Fail-closed: an existing but unreadable package install is also retained.
        expect(getGrantedServiceIds(brokenIdentity)).toEqual(new Set(["also-still-trusted"]));
        // Fully unconfigured identity is removed entirely.
        expect(getGrantedServiceIds(orphanIdentity).size).toBe(0);
        expect(getOverlayServiceGrants().map((g) => g.package).sort()).toEqual([brokenIdentity, keptIdentity, missingIdentity].sort());

        const logged = writes.join("");
        expect(logged).toContain(orphanIdentity);
        expect(logged).toContain("dropped");
        expect(logged).not.toContain("still-trusted");
        expect(logged).not.toContain("also-still-trusted");
    });

    test("corrupt user settings preserves all grants fail-closed", () => {
        const identity = "npm:@acme/configured-before-corruption";
        grantServices(identity, ["github"]);
        writeFileSync(join(agentDir, "settings.json"), "{ truncated", "utf-8");

        expect(() => reconcileOverlayGrants(projectDir)).not.toThrow();
        expect(getGrantedServiceIds(identity)).toEqual(new Set(["github"]));
    });

    test("no configured packages and no grants is a silent no-op", () => {
        writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [] }));
        expect(() => reconcileOverlayGrants(projectDir)).not.toThrow();
        expect(getOverlayServiceGrants()).toHaveLength(0);
    });
});
