import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _setGlobalConfigDir } from "../config/io.js";
import {
    getOverlayServiceGrants,
    getGrantedServiceIds,
    grantServices,
    revokeServices,
    reconcileGrants,
    resolveServiceGrantState,
    type ConfiguredPackageGrantInfo,
} from "./grants.js";

describe("overlay grants", () => {
    let dir: string;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), "pizzapi-grants-"));
        _setGlobalConfigDir(dir);
    });

    afterEach(() => {
        _setGlobalConfigDir(null);
        rmSync(dir, { recursive: true, force: true });
    });

    test("grant is exact — only listed service ids are granted", () => {
        grantServices("npm:@acme/pkg", ["github", "gitlab"]);
        expect(getGrantedServiceIds("npm:@acme/pkg")).toEqual(new Set(["github", "gitlab"]));
        expect(getGrantedServiceIds("npm:@acme/pkg").has("bitbucket")).toBe(false);
    });

    test("granting again unions rather than replacing", () => {
        grantServices("npm:@acme/pkg", ["github"]);
        grantServices("npm:@acme/pkg", ["gitlab"]);
        expect(getGrantedServiceIds("npm:@acme/pkg")).toEqual(new Set(["github", "gitlab"]));
    });

    test("added service ids after an update remain untrusted (no grant call = no grant)", () => {
        grantServices("npm:@acme/pkg", ["github"]);
        // Simulates a package update that adds a new declared id "gitlab" —
        // nothing calls grantServices for it, so it must stay ungranted.
        expect(getGrantedServiceIds("npm:@acme/pkg").has("gitlab")).toBe(false);
    });

    test("revoke removes only the listed ids, and clears the entry when empty", () => {
        grantServices("npm:@acme/pkg", ["github", "gitlab"]);
        revokeServices("npm:@acme/pkg", ["github"]);
        expect(getGrantedServiceIds("npm:@acme/pkg")).toEqual(new Set(["gitlab"]));

        revokeServices("npm:@acme/pkg", ["gitlab"]);
        expect(getOverlayServiceGrants()).toHaveLength(0);
    });

    test("no-op revoke does not write to disk", () => {
        grantServices("npm:@acme/pkg", ["github"]);
        const configPath = join(dir, "config.json");
        const before = readFileSync(configPath, "utf-8");

        // Revoking a service that was never granted, and revoking on an
        // identity with no grant at all — neither changes anything.
        const resultA = revokeServices("npm:@acme/pkg", ["gitlab"]);
        const resultB = revokeServices("npm:@other/pkg", ["github"]);

        expect(readFileSync(configPath, "utf-8")).toBe(before);
        expect(resultA).toEqual(getOverlayServiceGrants());
        expect(resultB).toEqual(getOverlayServiceGrants());
        expect(getGrantedServiceIds("npm:@acme/pkg")).toEqual(new Set(["github"]));
    });

    test("malformed grant entries in the raw config are ignored on read", () => {
        const configPath = join(dir, "config.json");
        writeFileSync(
            configPath,
            JSON.stringify({
                overlayServiceGrants: [
                    { package: "npm:@acme/good", services: ["github"] },
                    { package: "", services: ["github"] }, // empty package string
                    { package: "npm:@acme/bad-services", services: ["github", ""] }, // empty service id
                    { package: "npm:@acme/bad-services", services: ["github", 42] }, // non-string service id
                    { package: 7, services: ["github"] }, // non-string package
                    { services: ["github"] }, // missing package
                    "not-an-object",
                ],
            }),
        );

        expect(getOverlayServiceGrants()).toEqual([{ package: "npm:@acme/good", services: ["github"] }]);
    });

    test("resolveServiceGrantState: untrusted -> granted -> disabled", () => {
        expect(resolveServiceGrantState("npm:@acme/pkg", "github")).toBe("untrusted");
        grantServices("npm:@acme/pkg", ["github"]);
        expect(resolveServiceGrantState("npm:@acme/pkg", "github")).toBe("granted");
        expect(resolveServiceGrantState("npm:@acme/pkg", "github", ["github"])).toBe("disabled");
    });

    describe("corrupt global config", () => {
        function corruptConfig(): { path: string; bytes: string } {
            const path = join(dir, "config.json");
            const bytes = "{ this is not valid json !! ";
            writeFileSync(path, bytes, "utf-8");
            return { path, bytes };
        }

        test("grantServices refuses to write and preserves bytes exactly", () => {
            const { path, bytes } = corruptConfig();
            expect(() => grantServices("npm:@acme/pkg", ["github"])).toThrow(/malformed global config/);
            expect(readFileSync(path, "utf-8")).toBe(bytes);
        });

        test("revokeServices (non-no-op) refuses to write and preserves bytes exactly", () => {
            // Seed a grant while the config is still valid, then corrupt it.
            grantServices("npm:@acme/pkg", ["github"]);
            const path = join(dir, "config.json");
            const bytes = "{ still not json ]]] ";
            writeFileSync(path, bytes, "utf-8");

            expect(() => revokeServices("npm:@acme/pkg", ["github"])).toThrow(/malformed global config/);
            expect(readFileSync(path, "utf-8")).toBe(bytes);
        });
    });

    describe("reconcileGrants", () => {
        function info(ids: string[] | null): ConfiguredPackageGrantInfo {
            return { declaredServiceIds: ids === null ? null : new Set(ids) };
        }

        test("removes grants whose identity is no longer configured at all", () => {
            grantServices("npm:@acme/pkg", ["github"]);
            grantServices("local:/old/path", ["svc"]);

            const removed = reconcileGrants(new Map([["npm:@acme/pkg", info(["github"])]]));

            expect(removed).toHaveLength(1);
            expect(removed[0]).toEqual({ package: "local:/old/path", removedServiceIds: ["svc"], fullyRemoved: true });
            expect(getGrantedServiceIds("local:/old/path").size).toBe(0);
            expect(getGrantedServiceIds("npm:@acme/pkg")).toEqual(new Set(["github"]));
        });

        test("keeps a configured-but-missing package's grant untouched (fail-closed)", () => {
            grantServices("npm:@acme/pkg", ["github", "gitlab"]);

            const removed = reconcileGrants(new Map([["npm:@acme/pkg", info(null)]]));

            expect(removed).toHaveLength(0);
            expect(getGrantedServiceIds("npm:@acme/pkg")).toEqual(new Set(["github", "gitlab"]));
        });

        test("trims a granted service id no longer declared, keeping the rest", () => {
            grantServices("npm:@acme/pkg", ["github", "gitlab"]);

            const removed = reconcileGrants(new Map([["npm:@acme/pkg", info(["github"])]]));

            expect(removed).toEqual([{ package: "npm:@acme/pkg", removedServiceIds: ["gitlab"], fullyRemoved: false }]);
            expect(getGrantedServiceIds("npm:@acme/pkg")).toEqual(new Set(["github"]));
        });

        test("drops the entry entirely when no declared ids remain", () => {
            grantServices("npm:@acme/pkg", ["github"]);

            const removed = reconcileGrants(new Map([["npm:@acme/pkg", info([])]]));

            expect(removed).toEqual([{ package: "npm:@acme/pkg", removedServiceIds: ["github"], fullyRemoved: true }]);
            expect(getOverlayServiceGrants()).toHaveLength(0);
        });

        test("no-op reconciliation does not write to disk", () => {
            grantServices("npm:@acme/pkg", ["github"]);
            const configPath = join(dir, "config.json");
            const before = readFileSync(configPath, "utf-8");

            const removed = reconcileGrants(new Map([["npm:@acme/pkg", info(["github", "gitlab"])]]));

            expect(removed).toHaveLength(0);
            expect(readFileSync(configPath, "utf-8")).toBe(before);
        });
    });
});
